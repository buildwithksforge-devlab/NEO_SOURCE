CREATE OR REPLACE FUNCTION public.my_access_context()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'user_id', auth.uid(),
    'organization_id', public.current_org_id(),
    'access_scope', public.current_access_scope(),
    'branch_ids', to_jsonb(public.current_branch_ids()),
    'department_ids', to_jsonb(public.current_department_ids()),
    'station_ids', to_jsonb(public.current_station_ids()),
    'role_names', coalesce((
      SELECT jsonb_agg(DISTINCT r.name)
      FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id
      WHERE ur.user_id = auth.uid()
    ), '[]'::jsonb),
    'account_status', (SELECT p.account_status FROM public.profiles p WHERE p.id = auth.uid()),
    'setup_complete', (
      public.current_org_id() IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid())
      AND array_length(public.current_branch_ids(), 1) IS NOT NULL
    )
  );
$$;

REVOKE EXECUTE ON FUNCTION public.my_access_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_access_context() TO authenticated;