-- Reviewed folio arithmetic guard only. No business command is executed.
BEGIN;
DO $guard$ BEGIN
 IF to_regprocedure('public.neo_folio_line_amount_invariant()') IS NULL OR md5(pg_get_functiondef('public.neo_folio_line_amount_invariant()'::regprocedure)) NOT IN ('fd7b0b8ca28706e6c3abebaa09f7a959','44c8a6546d51b865ad133dd8304048e5') THEN
  RAISE EXCEPTION 'Installed folio arithmetic guard differs from reviewed code; nothing replaced.';
 END IF;
END $guard$;
CREATE TEMP TABLE neo_folio_acl_before ON COMMIT DROP AS SELECT coalesce(proacl::text,'') acl FROM pg_proc WHERE oid='public.neo_folio_line_amount_invariant()'::regprocedure;
CREATE OR REPLACE FUNCTION public.neo_folio_line_amount_invariant()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Reversals may be negative. Every saved monetary component must be finite.
  IF EXISTS (SELECT 1 FROM unnest(ARRAY[NEW.gross_amount, NEW.discount_amount,
       NEW.tax_amount, NEW.service_charge_amount, NEW.net_amount]) amount
       WHERE amount::text IN ('NaN','Infinity','-Infinity')) THEN
    RAISE EXCEPTION 'Folio line monetary amounts must be finite' USING ERRCODE='22003';
  END IF;
  IF abs(coalesce(NEW.gross_amount,0) - coalesce(NEW.discount_amount,0)
       + coalesce(NEW.tax_amount,0) + coalesce(NEW.service_charge_amount,0)
       - coalesce(NEW.net_amount,0)) > 0.01 THEN
    RAISE EXCEPTION 'Folio line total does not agree with its amount, discount, tax and service charge';
  END IF;
  RETURN NEW;
END;
$function$;

DO $verify$ BEGIN
 IF md5(pg_get_functiondef('public.neo_folio_line_amount_invariant()'::regprocedure))<>'44c8a6546d51b865ad133dd8304048e5' OR NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN neo_folio_acl_before b WHERE p.oid='public.neo_folio_line_amount_invariant()'::regprocedure AND coalesce(p.proacl::text,'')=b.acl) THEN
  RAISE EXCEPTION 'Folio guard definition or permission verification failed; installation rolled back.';
 END IF;
END $verify$;
SELECT jsonb_build_object('diagnostic_version','folio-finite-amount-guard-v1','definition_matches',true,'permissions_unchanged',true,'scope','Rejects non-finite amounts in future folio lines. Preserves reversal signs, existing arithmetic tolerance and permissions. Installation changes no folio, payment, stock, tax setting or history.');
COMMIT;
