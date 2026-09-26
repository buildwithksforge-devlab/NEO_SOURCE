-- Templates still use legacy 2-part keys (pms.payments.record). Resolve them
-- through the canonical/alias layer so grants are not silently dropped.
CREATE OR REPLACE FUNCTION public.neo_apply_role_templates(_org uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _granted integer := 0; _revoked integer := 0;
BEGIN
  IF _org IS NULL OR (NOT public.neo_internal_ctx()
      AND (_org <> public.current_org_id() OR NOT public.is_org_admin())) THEN
    RAISE EXCEPTION 'Not authorised';
  END IF;

  WITH added AS (
    INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
    SELECT DISTINCT _org, r.id, p.id
      FROM public.roles r
      JOIN public.role_permission_templates t
        ON t.version = 1
       AND t.template_key IN (coalesce(r.normalized_role_key, ''),
                              public.neo_norm_key(r.name),
                              lower(r.name))
      CROSS JOIN LATERAL public.canonical_permission(t.module, '*', t.action) c
      JOIN public.permissions p
        ON p.module = c.module AND p.feature = c.feature AND p.action = c.action
     WHERE r.organization_id = _org
       AND r.role_status IN ('active','custom')
       AND NOT EXISTS (SELECT 1 FROM public.role_permissions rp
                        WHERE rp.role_id = r.id AND rp.permission_id = p.id)
    RETURNING 1)
  SELECT count(*) INTO _granted FROM added;

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

  RETURN jsonb_build_object('permissions_granted', _granted, 'restricted_revoked', _revoked);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_apply_role_templates(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_apply_role_templates(uuid) TO authenticated, service_role;

-- Backfill every existing role with the grants that the exact-match join lost.
INSERT INTO public.role_permissions (organization_id, role_id, permission_id)
SELECT DISTINCT r.organization_id, r.id, p.id
  FROM public.roles r
  JOIN public.role_permission_templates t
    ON t.version = 1
   AND t.template_key IN (coalesce(r.normalized_role_key, ''),
                          public.neo_norm_key(r.name),
                          lower(r.name))
  CROSS JOIN LATERAL public.canonical_permission(t.module, '*', t.action) c
  JOIN public.permissions p
    ON p.module = c.module AND p.feature = c.feature AND p.action = c.action
 WHERE r.role_status IN ('active','custom')
   AND NOT EXISTS (SELECT 1 FROM public.role_permissions rp
                    WHERE rp.role_id = r.id AND rp.permission_id = p.id)
   AND NOT EXISTS (SELECT 1 FROM public.restricted_actions ra
                    WHERE ra.module = p.module AND ra.action = p.action
                      AND NOT EXISTS (SELECT 1 FROM public.role_catalogue rc
                                       WHERE rc.role_key = r.normalized_role_key
                                         AND rc.restricted_authority));