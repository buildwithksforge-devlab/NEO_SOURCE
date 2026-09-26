REVOKE EXECUTE ON FUNCTION public.neo_stores_shortage_to_pr(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.neo_stores_shortage_to_pr(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_stores_shortage_to_pr(uuid, text) TO authenticated;