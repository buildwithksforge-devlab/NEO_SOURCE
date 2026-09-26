-- 1. Privileged routines must never be executable by signed-out callers.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('folio_close','pms_confirm_payment','neo_guard_approval_step_actor','neo_guard_superuser_permission_deny')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    IF r.proname IN ('folio_close','pms_confirm_payment') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
    END IF;
  END LOOP;
END $$;

-- 2. Folio charge totals are a derived figure: realign the stored total with the
--    posted charge lines wherever the two disagree. No amounts are invented —
--    the folio simply reports what is actually posted against it.
UPDATE public.folios f
SET total_charges = agg.posted,
    balance = round(agg.posted - COALESCE(f.total_payments, 0), 2)
FROM (
  SELECT fo.id,
         round(COALESCE(SUM(CASE WHEN fl.line_type = 'charge' AND fl.status = 'posted'
                                 THEN fl.gross_amount ELSE 0 END), 0), 2) AS posted
  FROM public.folios fo
  LEFT JOIN public.folio_lines fl ON fl.folio_id = fo.id
  GROUP BY fo.id
) agg
WHERE agg.id = f.id
  AND round(COALESCE(f.total_charges, 0), 2) <> agg.posted;