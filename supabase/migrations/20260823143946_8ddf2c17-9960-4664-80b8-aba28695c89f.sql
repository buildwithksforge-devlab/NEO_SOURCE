CREATE OR REPLACE FUNCTION public.neo_apply_role_templates(_org uuid, _reset boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _granted integer := 0; _revoked integer := 0; _stale integer := 0;
BEGIN
  IF _org IS NULL OR (NOT public.neo_internal_ctx()
      AND (_org <> public.current_org_id() OR NOT public.is_org_admin())) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  DROP TABLE IF EXISTS _role_template;
  DROP TABLE IF EXISTS _role_grant;

  CREATE TEMP TABLE _role_template ON COMMIT DROP AS
  SELECT r.id AS role_id, pick.template_key
    FROM public.roles r
    CROSS JOIN LATERAL (
      SELECT k.template_key
        FROM (VALUES (coalesce(r.normalized_role_key,''), 1),
                     (public.neo_norm_key(r.name), 2),
                     (lower(r.name), 3)) AS cand(key, rank)
        JOIN (SELECT DISTINCT template_key FROM public.role_permission_templates WHERE version = 1) k
          ON k.template_key = cand.key
       ORDER BY cand.rank
       LIMIT 1
    ) pick
   WHERE r.organization_id = _org
     AND r.role_status IN ('active','custom');

  CREATE TEMP TABLE _role_grant ON COMMIT DROP AS
  SELECT DISTINCT rt.role_id, p.id AS permission_id
    FROM _role_template rt
    JOIN public.role_permission_templates t
      ON t.version = 1 AND t.template_key = rt.template_key
    CROSS JOIN LATERAL public.canonical_permission(t.module, '*', t.action) c
    JOIN public.permissions p
      ON p.module = c.module AND p.feature = c.feature AND p.action = c.action;

  WITH added AS (
    INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
    SELECT _org, g.role_id, g.permission_id
      FROM _role_grant g
     WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions rp
                        WHERE rp.role_id = g.role_id AND rp.permission_id = g.permission_id)
    RETURNING 1)
  SELECT count(*) INTO _granted FROM added;

  IF _reset THEN
    WITH dropped AS (
      DELETE FROM public.role_permissions rp
       USING _role_template rt
       WHERE rp.role_id = rt.role_id
         AND rp.source = 'template'
         AND NOT EXISTS (SELECT 1 FROM _role_grant g
                          WHERE g.role_id = rp.role_id AND g.permission_id = rp.permission_id)
      RETURNING 1)
    SELECT count(*) INTO _stale FROM dropped;
  END IF;

  WITH removed AS (
    DELETE FROM public.role_permissions rp
     USING public.roles r, public.permissions p, public.restricted_actions ra
     WHERE rp.role_id = r.id
       AND r.organization_id = _org
       AND rp.permission_id = p.id
       AND p.module = ra.module AND p.action = ra.action
       AND NOT EXISTS (SELECT 1 FROM public.role_catalogue c
                        WHERE c.role_key = r.normalized_role_key AND c.restricted_authority)
    RETURNING 1)
  SELECT count(*) INTO _revoked FROM removed;

  DROP TABLE IF EXISTS _role_template;
  DROP TABLE IF EXISTS _role_grant;

  RETURN jsonb_build_object('permissions_granted', _granted,
                            'stale_template_grants_removed', _stale,
                            'restricted_revoked', _revoked);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_apply_role_templates(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_apply_role_templates(uuid, boolean) TO authenticated, service_role;

INSERT INTO public.permissions (module, feature, action, label)
SELECT DISTINCT c.module, c.feature, c.action,
       initcap(replace(c.action,'_',' '))
         || ' — ' || replace(c.module,'-',' ')
         || CASE WHEN c.feature = '*' THEN '' ELSE ' · ' || replace(c.feature,'-',' ') END
  FROM public.role_permission_templates t
  CROSS JOIN LATERAL public.canonical_permission(t.module,'*',t.action) c
 WHERE t.version = 1
   AND NOT EXISTS (
     SELECT 1 FROM public.permissions p
      WHERE p.module = c.module AND p.feature = c.feature AND p.action = c.action);

DO $$
DECLARE _o uuid;
BEGIN
  PERFORM set_config('neo.internal','on',true);
  FOR _o IN SELECT id FROM public.organizations LOOP
    PERFORM public.neo_apply_role_templates(_o, true);
  END LOOP;
END $$;