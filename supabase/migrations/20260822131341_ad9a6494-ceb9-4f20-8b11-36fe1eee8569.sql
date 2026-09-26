REVOKE ALL ON FUNCTION public.neo_autopost_on_finalise() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_autopost_on_finalise() TO service_role;