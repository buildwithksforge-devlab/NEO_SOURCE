
CREATE TABLE IF NOT EXISTS public.neo_perf_benchmarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  subject uuid,
  runs integer NOT NULL,
  total_ms numeric NOT NULL,
  avg_ms numeric NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.neo_perf_benchmarks TO service_role;
ALTER TABLE public.neo_perf_benchmarks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "perf benchmarks admin read" ON public.neo_perf_benchmarks;
CREATE POLICY "perf benchmarks admin read" ON public.neo_perf_benchmarks
  FOR SELECT TO authenticated USING (public.is_org_admin());
GRANT SELECT ON public.neo_perf_benchmarks TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_bench_access(_user uuid, _label text, _runs integer DEFAULT 5)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE t0 timestamptz; total numeric; i integer; dummy jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', _user::text, 'role', 'authenticated')::text, true);
  -- warm
  dummy := public.my_effective_access();
  t0 := clock_timestamp();
  FOR i IN 1.._runs LOOP
    dummy := public.my_effective_access();
  END LOOP;
  total := extract(epoch from clock_timestamp() - t0) * 1000;
  PERFORM set_config('request.jwt.claims', '', true);
  INSERT INTO public.neo_perf_benchmarks(label, subject, runs, total_ms, avg_ms)
  VALUES (_label, _user, _runs, round(total, 2), round(total / greatest(_runs,1), 2));
  RETURN round(total / greatest(_runs,1), 2);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.neo_bench_access(uuid, text, integer) FROM PUBLIC, anon, authenticated;

SELECT public.neo_bench_access('64bed97a-db0e-4a1a-84eb-7edab5b00501'::uuid, 'before:my_effective_access', 5);
