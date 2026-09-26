
REVOKE EXECUTE ON FUNCTION public.neo_build_effective_access() FROM authenticated;
SELECT public.neo_bench_access('64bed97a-db0e-4a1a-84eb-7edab5b00501'::uuid, 'after:my_effective_access', 5);
SELECT public.neo_bench_access('2e4afcc7-f0c2-433e-9a19-be9d2dca2669'::uuid, 'after:my_effective_access', 5);
