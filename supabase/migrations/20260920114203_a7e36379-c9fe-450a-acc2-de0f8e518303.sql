REVOKE ALL ON FUNCTION public.neo_property_entrance_enter(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_property_entrance_enter(uuid) TO authenticated;