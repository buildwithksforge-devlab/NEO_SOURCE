-- Restore execute access lost during the security revocation sweep.
GRANT EXECUTE ON FUNCTION public.pms_post_accommodation(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_public_workspace(text, text) TO anon, authenticated;