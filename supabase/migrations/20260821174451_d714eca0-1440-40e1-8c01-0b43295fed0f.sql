
DO $$
DECLARE src text;
BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE proname = 'neo_simulate_access';
  src := replace(
    src,
    'NOT public.has_permission(''administration'', ''workspace'', ''edit'')',
    'NOT (public.has_permission(''administration'', ''workspace'', ''edit'') OR public.has_permission(''administration'', ''users'', ''view_access''))'
  );
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.neo_simulate_access(_user uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS %L',
    src
  );
END $$;

REVOKE EXECUTE ON FUNCTION public.neo_simulate_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_simulate_access(uuid) TO authenticated;
