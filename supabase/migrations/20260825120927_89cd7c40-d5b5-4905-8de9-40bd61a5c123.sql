REVOKE ALL ON FUNCTION public.neo_structure_guard() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_structure_guard() TO service_role;