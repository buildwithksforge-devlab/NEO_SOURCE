-- Canonical, catalogue-backed role template reconciliation.

CREATE OR REPLACE FUNCTION public.neo_can_manage_roles()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT public.is_org_admin()
      OR public.has_permission('administration', 'roles', 'edit')
      OR public.has_permission('administration', 'roles', 'manage');
$fn$;
REVOKE ALL ON FUNCTION public.neo_can_manage_roles() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_can_manage_roles() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.canonical_role_template_key(_role_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  WITH r AS (
    SELECT id, organization_id, name, normalized_role_key,
           lower(trim(regexp_replace(name, '[^a-zA-Z0-9]+', ' ', 'g'))) AS name_key,
           lower(trim(regexp_replace(coalesce(normalized_role_key,''), '[^a-zA-Z0-9]+', ' ', 'g'))) AS stored_key
    FROM public.roles WHERE id = _role_id
  ), candidate AS (
    SELECT c.role_key, 1 AS precedence
    FROM r JOIN public.role_catalogue c ON c.role_key = r.normalized_role_key
    WHERE NOT c.retired
    UNION ALL
    SELECT a.role_key, 2
    FROM r JOIN public.role_catalogue_aliases a
      ON a.alias_key IN (r.name_key, r.stored_key)
    JOIN public.role_catalogue c ON c.role_key = a.role_key AND NOT c.retired
    WHERE NOT a.ambiguous
    UNION ALL
    SELECT c.role_key, 3
    FROM r JOIN public.role_catalogue c
      ON lower(trim(regexp_replace(c.role_name, '[^a-zA-Z0-9]+', ' ', 'g'))) = r.name_key
    WHERE NOT c.retired
  )
  SELECT role_key FROM candidate ORDER BY precedence, role_key LIMIT 1;
$fn$;
REVOKE ALL ON FUNCTION public.canonical_role_template_key(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.canonical_role_template_key(uuid) TO authenticated, service_role;

-- Cashier is collection custody, not accounting administration or correction approval.
DELETE FROM public.role_feature_templates
WHERE role_key = 'cashier' AND module = 'finance';
INSERT INTO public.role_feature_templates(role_key,module,feature,action)
VALUES
 ('cashier','finance','collections','view'),
 ('cashier','finance','collections','collect_payment'),
 ('cashier','finance','collections','issue_receipt'),
 ('cashier','finance','collections','query_bill'),
 ('cashier','finance','collections','reprint_receipt'),
 ('cashier','finance','collections','settle_bill'),
 ('cashier','finance','collections','verify_bill'),
 ('cashier','finance','till','view'),
 ('cashier','finance','till','create'),
 ('cashier','finance','till','edit'),
 ('cashier','finance','till','close'),
 ('cashier','finance','till','confirm_cash'),
 ('cashier','finance','till','declare_cash'),
 ('cashier','finance','sessions','view'),
 ('cashier','finance','sessions','create'),
 ('cashier','finance','sessions','edit')
ON CONFLICT (role_key,module,feature,action) DO NOTHING;

-- Night audit is automated; the historical label must never resolve to a human template.
UPDATE public.role_catalogue_aliases
SET ambiguous = true,
    review_reason = 'Retired: night audit is an automated EOD process, not an assignable role.'
WHERE alias_key = 'night auditor';

DROP FUNCTION IF EXISTS public.recommended_template_grants(uuid);
CREATE FUNCTION public.recommended_template_grants(_role_id uuid)
RETURNS TABLE(template_module text, template_action text, permission_id uuid, module text, action text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  WITH role_template AS (
    SELECT public.canonical_role_template_key(_role_id) AS role_key
  ), tpl AS (
    SELECT DISTINCT t.module, t.feature, t.action
    FROM role_template r
    JOIN public.role_feature_templates t ON t.role_key = r.role_key
  )
  SELECT tpl.module,
         CASE WHEN tpl.feature = '*' THEN tpl.action ELSE tpl.feature || '.' || tpl.action END,
         p.id,
         p.module,
         p.action
  FROM tpl
  LEFT JOIN LATERAL public.canonical_permission(tpl.module, tpl.feature, tpl.action) c ON true
  LEFT JOIN public.permissions p
    ON p.module = c.module AND p.feature = c.feature AND p.action = c.action;
$fn$;
REVOKE ALL ON FUNCTION public.recommended_template_grants(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.recommended_template_grants(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.recommended_role_template_status(_role_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE _r public.roles; _key text; _retired boolean := false; _count int := 0;
BEGIN
  SELECT * INTO _r FROM public.roles WHERE id = _role_id;
  IF _r.id IS NULL OR _r.organization_id IS DISTINCT FROM public.current_org_id() THEN
    RAISE EXCEPTION 'Role not found in the active organization';
  END IF;
  IF NOT public.neo_can_manage_roles() THEN RAISE EXCEPTION 'Not authorised to manage role templates'; END IF;
  _key := public.canonical_role_template_key(_role_id);
  IF _key IS NULL THEN
    SELECT coalesce(bool_or(c.retired OR a.ambiguous), false) INTO _retired
    FROM public.role_catalogue c
    LEFT JOIN public.role_catalogue_aliases a ON a.role_key = c.role_key
    WHERE c.role_key = _r.normalized_role_key
       OR a.alias_key IN (
          lower(trim(regexp_replace(_r.name, '[^a-zA-Z0-9]+', ' ', 'g'))),
          lower(trim(regexp_replace(coalesce(_r.normalized_role_key,''), '[^a-zA-Z0-9]+', ' ', 'g')))
       );
    RETURN jsonb_build_object('status', CASE WHEN _retired THEN 'retired' ELSE 'custom' END,
                              'role_key', null, 'template_rows', 0);
  END IF;
  SELECT count(*) INTO _count FROM public.role_feature_templates WHERE role_key = _key;
  RETURN jsonb_build_object('status', CASE WHEN _count > 0 THEN 'approved' ELSE 'incomplete' END,
                            'role_key', _key, 'template_rows', _count);
END;
$fn$;
REVOKE ALL ON FUNCTION public.recommended_role_template_status(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.recommended_role_template_status(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.recommended_role_diff(_role_id uuid)
RETURNS TABLE(module text, action text, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.roles WHERE id=_role_id AND organization_id=public.current_org_id()) THEN
    RAISE EXCEPTION 'Role not found in the active organization';
  END IF;
  IF NOT public.neo_can_manage_roles() THEN RAISE EXCEPTION 'Not authorised to manage role templates'; END IF;
  RETURN QUERY
  WITH g AS (SELECT * FROM public.recommended_template_grants(_role_id)),
  wanted AS (
    SELECT DISTINCT g.permission_id, g.module, g.action FROM g WHERE g.permission_id IS NOT NULL
  ), unavailable AS (
    SELECT DISTINCT g.template_module AS module, g.template_action AS action
    FROM g WHERE g.permission_id IS NULL
  ), cur AS (
    SELECT DISTINCT p.id permission_id,p.module,p.action
    FROM public.role_permissions rp JOIN public.permissions p ON p.id=rp.permission_id
    WHERE rp.role_id=_role_id AND rp.organization_id=public.current_org_id()
  )
  SELECT coalesce(w.module,c.module),coalesce(w.action,c.action),
         CASE WHEN c.permission_id IS NULL THEN 'add'
              WHEN w.permission_id IS NULL THEN 'custom' ELSE 'retained' END
  FROM wanted w FULL JOIN cur c ON c.permission_id=w.permission_id
  UNION ALL SELECT u.module,u.action,'unavailable' FROM unavailable u;
END;
$fn$;
REVOKE ALL ON FUNCTION public.recommended_role_diff(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.recommended_role_diff(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apply_recommended_permissions(_role_id uuid, _reset boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  _org uuid; _name text; _key text; _added int:=0; _removed int:=0;
  _wanted_count int:=0; _missing_after int:=0; _unavailable jsonb:='[]'::jsonb;
BEGIN
  SELECT organization_id,name INTO _org,_name FROM public.roles WHERE id=_role_id;
  IF _org IS NULL OR _org IS DISTINCT FROM public.current_org_id() THEN
    RAISE EXCEPTION 'Role not found in the active organization';
  END IF;
  IF NOT public.neo_can_manage_roles() THEN RAISE EXCEPTION 'Not authorised to manage role templates'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_role_id::text,0));
  _key := public.canonical_role_template_key(_role_id);
  IF _key IS NULL THEN RAISE EXCEPTION 'No approved platform template for role %',_name; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.role_feature_templates WHERE role_key=_key) THEN
    RAISE EXCEPTION 'Approved template % has no permission lines',_key;
  END IF;

  CREATE TEMP TABLE _wanted(permission_id uuid PRIMARY KEY) ON COMMIT DROP;
  INSERT INTO _wanted SELECT DISTINCT permission_id FROM public.recommended_template_grants(_role_id)
  WHERE permission_id IS NOT NULL;
  SELECT count(*) INTO _wanted_count FROM _wanted;
  SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('module',template_module,'action',template_action)),'[]'::jsonb)
    INTO _unavailable FROM public.recommended_template_grants(_role_id) WHERE permission_id IS NULL;

  INSERT INTO public.role_permissions(organization_id,role_id,permission_id,source)
  SELECT _org,_role_id,w.permission_id,'template' FROM _wanted w
  ON CONFLICT (role_id,permission_id) DO NOTHING;
  GET DIAGNOSTICS _added=ROW_COUNT;

  IF _reset THEN
    DELETE FROM public.role_permissions rp
    WHERE rp.role_id=_role_id AND rp.organization_id=_org AND rp.source='template'
      AND NOT EXISTS (SELECT 1 FROM _wanted w WHERE w.permission_id=rp.permission_id);
    GET DIAGNOSTICS _removed=ROW_COUNT;
  END IF;

  SELECT count(*) INTO _missing_after FROM _wanted w
  WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions rp
                    WHERE rp.role_id=_role_id AND rp.organization_id=_org AND rp.permission_id=w.permission_id);
  IF _missing_after > 0 THEN
    RAISE EXCEPTION 'Reconciliation incomplete: % of % grants did not persist for %',_missing_after,_wanted_count,_name;
  END IF;

  INSERT INTO public.audit_logs(organization_id,user_id,user_name,action,module,record_id,new_value)
  VALUES(_org,auth.uid(),coalesce((SELECT full_name FROM public.profiles WHERE id=auth.uid()),''),
         CASE WHEN _reset THEN 'role.permissions.reset_to_recommended' ELSE 'role.permissions.apply_recommended' END,
         'administration',_role_id,
         jsonb_build_object('role',_name,'canonical_role_key',_key,'source','role_feature_templates',
                            'added',_added,'removed',_removed,'expected',_wanted_count,
                            'missing_after',_missing_after,'unavailable',_unavailable));
  RETURN jsonb_build_object('ok',true,'role',_name,'role_key',_key,'added',_added,
                            'removed',_removed,'expected',_wanted_count,'missing_after',0,
                            'unavailable',_unavailable,'verified',true);
END;
$fn$;
REVOKE ALL ON FUNCTION public.apply_recommended_permissions(uuid,boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.apply_recommended_permissions(uuid,boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_role_permissions(_role uuid, _permission_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE _org uuid:=public.current_org_id(); _role_row public.roles; _added int:=0; _removed int:=0; _added_keys text[]; _removed_keys text[];
BEGIN
  IF _org IS NULL OR NOT public.neo_can_manage_roles() THEN RAISE EXCEPTION 'Not authorised to change role permissions'; END IF;
  SELECT * INTO _role_row FROM public.roles WHERE id=_role AND organization_id=_org;
  IF _role_row.id IS NULL THEN RAISE EXCEPTION 'Role not found in the active organization'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_role::text,0));
  IF EXISTS (SELECT 1 FROM unnest(coalesce(_permission_ids,'{}'::uuid[])) pid
             WHERE NOT EXISTS(SELECT 1 FROM public.permissions p WHERE p.id=pid)) THEN
    RAISE EXCEPTION 'Unknown permission in selection';
  END IF;
  SELECT array_agg(p.module||'.'||p.feature||'.'||p.action) INTO _removed_keys
  FROM public.role_permissions rp JOIN public.permissions p ON p.id=rp.permission_id
  WHERE rp.role_id=_role AND rp.organization_id=_org
    AND NOT(rp.permission_id=ANY(coalesce(_permission_ids,'{}'::uuid[])));
  DELETE FROM public.role_permissions rp WHERE rp.role_id=_role AND rp.organization_id=_org
    AND NOT(rp.permission_id=ANY(coalesce(_permission_ids,'{}'::uuid[])));
  GET DIAGNOSTICS _removed=ROW_COUNT;
  SELECT array_agg(p.module||'.'||p.feature||'.'||p.action) INTO _added_keys
  FROM unnest(coalesce(_permission_ids,'{}'::uuid[])) pid JOIN public.permissions p ON p.id=pid
  WHERE NOT EXISTS(SELECT 1 FROM public.role_permissions rp WHERE rp.role_id=_role AND rp.permission_id=pid);
  INSERT INTO public.role_permissions(organization_id,role_id,permission_id,source)
  SELECT _org,_role,pid,'custom' FROM unnest(coalesce(_permission_ids,'{}'::uuid[])) pid
  ON CONFLICT (role_id,permission_id) DO NOTHING;
  GET DIAGNOSTICS _added=ROW_COUNT;
  IF _added>0 OR _removed>0 THEN
    INSERT INTO public.audit_logs(organization_id,user_id,user_name,action,module,record_id,previous_value,new_value)
    VALUES(_org,auth.uid(),coalesce((SELECT full_name FROM public.profiles WHERE id=auth.uid()),''),
           'role.permissions.updated','administration',_role,
           jsonb_build_object('removed',coalesce(to_jsonb(_removed_keys),'[]'::jsonb)),
           jsonb_build_object('added',coalesce(to_jsonb(_added_keys),'[]'::jsonb),'role',_role_row.name));
  END IF;
  RETURN jsonb_build_object('ok',true,'added',_added,'removed',_removed,'role_id',_role);
END;
$fn$;
REVOKE ALL ON FUNCTION public.set_role_permissions(uuid,uuid[]) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_role_permissions(uuid,uuid[]) TO authenticated, service_role;