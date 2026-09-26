-- The published-app lookup is resolved server-side with a trusted client, so
-- signed-out clients no longer need to call it directly.
REVOKE EXECUTE ON FUNCTION public.resolve_public_workspace(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_public_workspace(text, text) TO authenticated, service_role;