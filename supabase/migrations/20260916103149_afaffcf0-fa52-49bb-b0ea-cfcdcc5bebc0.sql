-- Remove malformed catalogue lines that cannot resolve to a live permission.
DELETE FROM public.role_feature_templates t
USING public.role_catalogue c
WHERE c.role_key=t.role_key AND NOT c.retired
  AND NOT EXISTS (
    SELECT 1 FROM public.permissions p
    WHERE p.module=t.module AND p.feature=t.feature AND p.action=t.action
  );

-- These are implementation helpers called inside guarded SECURITY DEFINER APIs,
-- not browser RPC endpoints in their own right.
REVOKE EXECUTE ON FUNCTION public.neo_can_manage_roles() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.canonical_role_template_key(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.recommended_template_grants(uuid) FROM authenticated;