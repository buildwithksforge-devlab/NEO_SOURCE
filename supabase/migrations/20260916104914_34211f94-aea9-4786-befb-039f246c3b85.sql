CREATE OR REPLACE FUNCTION public.neo_reconcile_org_role_templates()
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  _org uuid := public.current_org_id();
  _results jsonb := '[]'::jsonb;
  _roles int := 0; _reconciled int := 0; _incomplete int := 0; _no_template int := 0; _total_added int := 0;
  r record;
  _key text; _added int; _wanted int; _missing int; _unavailable jsonb;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No active organisation'; END IF;
  IF NOT public.neo_can_manage_roles() THEN
    RAISE EXCEPTION 'Not authorised to manage role templates';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('neo_reconcile_org_role_templates:' || _org::text, 0));

  FOR r IN SELECT id, name FROM public.roles
           WHERE organization_id = _org AND coalesce(active, true)
           ORDER BY name
  LOOP
    _roles := _roles + 1;
    _key := public.canonical_role_template_key(r.id);

    IF _key IS NULL OR NOT EXISTS (SELECT 1 FROM public.role_feature_templates WHERE role_key = _key) THEN
      _no_template := _no_template + 1;
      _results := _results || jsonb_build_object('role', r.name, 'status', 'no_template', 'added', 0, 'missing', 0);
      CONTINUE;
    END IF;

    SELECT count(*) FILTER (WHERE permission_id IS NOT NULL),
           coalesce(jsonb_agg(DISTINCT jsonb_build_object('module', template_module, 'action', template_action))
                    FILTER (WHERE permission_id IS NULL), '[]'::jsonb)
      INTO _wanted, _unavailable
      FROM public.recommended_template_grants(r.id);

    -- Additive only: nothing already granted is ever removed, so permissions a
    -- hotel configured itself survive the reconciliation untouched.
    INSERT INTO public.role_permissions(organization_id, role_id, permission_id, source)
    SELECT _org, r.id, g.permission_id, 'template'
    FROM (SELECT DISTINCT permission_id FROM public.recommended_template_grants(r.id)
          WHERE permission_id IS NOT NULL) g
    ON CONFLICT (role_id, permission_id) DO NOTHING;
    GET DIAGNOSTICS _added = ROW_COUNT;
    _total_added := _total_added + _added;

    SELECT count(*) INTO _missing
    FROM (SELECT DISTINCT permission_id FROM public.recommended_template_grants(r.id)
          WHERE permission_id IS NOT NULL) g
    WHERE NOT EXISTS (
      SELECT 1 FROM public.role_permissions rp
      WHERE rp.role_id = r.id AND rp.organization_id = _org AND rp.permission_id = g.permission_id);

    IF _missing > 0 THEN _incomplete := _incomplete + 1; ELSE _reconciled := _reconciled + 1; END IF;

    _results := _results || jsonb_build_object(
      'role', r.name, 'role_key', _key,
      'status', CASE WHEN _missing > 0 THEN 'incomplete' ELSE 'reconciled' END,
      'added', _added, 'expected', _wanted, 'missing', _missing,
      'unavailable', jsonb_array_length(_unavailable));

    IF _added > 0 THEN
      INSERT INTO public.audit_logs(organization_id, user_id, user_name, action, module, record_id, new_value)
      VALUES (_org, auth.uid(),
              coalesce((SELECT full_name FROM public.profiles WHERE id = auth.uid()), ''),
              'role.permissions.apply_recommended', 'administration', r.id,
              jsonb_build_object('role', r.name, 'canonical_role_key', _key, 'added', _added,
                                 'expected', _wanted, 'missing_after', _missing,
                                 'scope', 'organisation_reconciliation'));
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', _incomplete = 0, 'roles', _roles, 'reconciled', _reconciled,
    'incomplete', _incomplete, 'no_template', _no_template,
    'added', _total_added, 'results', _results);
END;
$fn$;
REVOKE ALL ON FUNCTION public.neo_reconcile_org_role_templates() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_reconcile_org_role_templates() TO authenticated, service_role;