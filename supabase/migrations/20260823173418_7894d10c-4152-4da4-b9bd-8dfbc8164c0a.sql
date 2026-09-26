CREATE OR REPLACE FUNCTION public.delivery_get_settings(_branch uuid)
RETURNS delivery_settings
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT s.* FROM public.delivery_settings s
  WHERE s.organization_id = coalesce(
          (SELECT b.organization_id FROM public.branches b WHERE b.id = _branch),
          public.current_org_id())
    AND (s.branch_id = _branch OR s.branch_id IS NULL)
  ORDER BY s.branch_id NULLS LAST
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.delivery_get_settings(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delivery_get_settings(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.delivery_get_settings(uuid) TO authenticated, service_role;