DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS rel
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_inherits i ON i.inhrelid = c.oid
    WHERE n.nspname = 'public' AND i.inhparent = 'public.audit_logs_partitioned'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', r.rel);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', r.rel);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.neo_audit_ensure_partition(_month date)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _start date := date_trunc('month', _month)::date;
  _end   date := (date_trunc('month', _month) + interval '1 month')::date;
  _name  text := format('audit_logs_p%s', to_char(_start, 'YYYYMM'));
BEGIN
  IF to_regclass('public.' || _name) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE public.%I PARTITION OF public.audit_logs_partitioned FOR VALUES FROM (%L) TO (%L)',
      _name, _start, _end);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', _name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', _name);
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO authenticated', _name);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', _name);
  END IF;
  RETURN _name;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_audit_ensure_partition(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_audit_ensure_partition(date) TO service_role;