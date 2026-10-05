-- NEØ — scoped asset custodian display
-- Returns only the custodian attached to assets already visible to the caller.
-- This is deliberately NOT a general staff directory.

CREATE OR REPLACE FUNCTION public.neo_asset_custodian_names()
RETURNS TABLE (
  asset_id uuid,
  custodian_id uuid,
  full_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT
    a.id AS asset_id,
    a.custodian_id,
    p.full_name
  FROM public.assets a
  JOIN public.profiles p
    ON p.id = a.custodian_id
   AND p.organization_id = a.organization_id
  WHERE a.organization_id = public.current_org_id()
    AND a.custodian_id IS NOT NULL
    AND (
      public.in_my_config_scope(
        a.organization_id,
        a.branch_id
      )
      OR
      public.in_my_scope(
        a.organization_id,
        a.branch_id,
        a.department_id,
        NULL::uuid,
        NULL::uuid,
        a.created_by
      )
    );
$function$;

REVOKE ALL
ON FUNCTION public.neo_asset_custodian_names()
FROM PUBLIC, anon;

GRANT EXECUTE
ON FUNCTION public.neo_asset_custodian_names()
TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';