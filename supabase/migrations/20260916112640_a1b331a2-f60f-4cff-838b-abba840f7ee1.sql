REVOKE ALL ON public.rbac_platform_snapshots FROM public,anon,authenticated;
GRANT ALL ON public.rbac_platform_snapshots TO service_role;
REVOKE ALL ON FUNCTION public.neo_approval_seed_steps() FROM public,anon;
GRANT EXECUTE ON FUNCTION public.neo_approval_seed_steps() TO service_role;