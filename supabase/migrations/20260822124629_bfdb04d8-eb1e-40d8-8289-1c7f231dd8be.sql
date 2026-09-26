DO $mig$
DECLARE s text;
BEGIN
  SELECT prosrc INTO s FROM pg_proc
   WHERE proname = 'neo_facts' AND pronamespace = 'public'::regnamespace;
  s := replace(s, 'coalesce(b.is_active, true)', 'coalesce(b.active, true)');
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.neo_facts(_branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS %L', s);
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.neo_facts(uuid, date, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.neo_facts(uuid, date, date) FROM anon;
GRANT EXECUTE ON FUNCTION public.neo_facts(uuid, date, date) TO authenticated, service_role;