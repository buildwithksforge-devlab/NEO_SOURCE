-- OPTIONAL, OPERATOR-SCOPED: enable the approved device page for EXISTING roles.
-- Run only after catalogue + device backend postchecks pass.
-- Replace both placeholders from verified project/organisation evidence.
-- No user assignment, PIN, other capability or other organisation is changed.
BEGIN;
SELECT set_config('neo.repair.target_org','REPLACE_WITH_VERIFIED_ORGANISATION_UUID',true);
SELECT set_config('neo.repair.change_ref','REPLACE_WITH_OPERATOR_AND_CHANGE_REFERENCE',true);

DO $neo_scope$
DECLARE
  v_org uuid := current_setting('neo.repair.target_org')::uuid;
  v_reference text := current_setting('neo.repair.change_ref');
  v_permission uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id=v_org) THEN
    RAISE EXCEPTION 'The verified target organisation does not exist';
  END IF;
  IF v_reference IS NULL OR btrim(v_reference)='' OR v_reference LIKE 'REPLACE_%' THEN
    RAISE EXCEPTION 'Record the operator and approved change reference before granting access';
  END IF;
  SELECT id INTO v_permission FROM public.permissions
    WHERE module='administration' AND feature='devices' AND action='manage';
  IF v_permission IS NULL THEN RAISE EXCEPTION 'The dedicated device catalogue migration is not installed'; END IF;
  IF to_regprocedure('public.neo_device_admin_allowed()') IS NULL THEN
    RAISE EXCEPTION 'The Owner/System Administrator device backend is not installed';
  END IF;

  WITH granted AS (
    INSERT INTO public.role_permissions(organization_id,role_id,permission_id,source)
    SELECT v_org,r.id,v_permission,'template'
    FROM public.roles r
    WHERE r.organization_id=v_org AND coalesce(r.active,true)
      AND coalesce(r.role_status,'active')='active'
      AND r.normalized_role_key IN ('owner','it-system-administrator')
    ON CONFLICT (role_id,permission_id) DO NOTHING
    RETURNING role_id,permission_id
  )
  INSERT INTO public.role_grant_migration_log(
    organization_id,role_id,role_key,permission_id,module,feature,action,operation,reason
  )
  SELECT v_org,g.role_id,r.normalized_role_key,g.permission_id,
    'administration','devices','manage','granted',
    'Dedicated device/PIN administration; ' || v_reference || '; SQL operator=' || current_user
  FROM granted g JOIN public.roles r ON r.id=g.role_id AND r.organization_id=v_org;
END
$neo_scope$;

SELECT l.id AS grant_audit_id,l.organization_id,l.role_id,l.role_key,l.module,l.feature,l.action,l.reason
FROM public.role_grant_migration_log l
WHERE l.organization_id=current_setting('neo.repair.target_org')::uuid
  AND l.module='administration' AND l.feature='devices' AND l.action='manage'
  AND l.reason LIKE '%' || current_setting('neo.repair.change_ref') || '%'
ORDER BY l.created_at,l.id;
COMMIT;