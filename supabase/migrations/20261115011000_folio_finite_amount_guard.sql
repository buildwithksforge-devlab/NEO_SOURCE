-- Formatting-tolerant verification of this one explicit reviewed function.
BEGIN;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.neo_folio_line_amount_invariant()')
   AND (md5(pg_get_functiondef(oid))='fd7b0b8ca28706e6c3abebaa09f7a959'
     OR md5(regexp_replace(regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g'), '[[:space:]]', '', 'g'))='52ad12d27fbcc4bba36c32b8e3ff95f5')) THEN
  RAISE EXCEPTION 'Installed folio guard differs from reviewed code; nothing replaced.';
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
 IF NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN neo_folio_acl_before b
   WHERE p.oid='public.neo_folio_line_amount_invariant()'::regprocedure
   AND md5(regexp_replace(regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g'), '[[:space:]]', '', 'g'))='52ad12d27fbcc4bba36c32b8e3ff95f5'
   AND coalesce(p.proacl::text,'')=b.acl
   AND p.prosecdef=false AND p.prorettype='trigger'::regtype
   AND p.proconfig=ARRAY['search_path=public']::text[]
   AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')) THEN
  RAISE EXCEPTION 'Folio guard definition or permission verification failed; installation rolled back.';
 END IF;
END $verify$;
SELECT jsonb_build_object('diagnostic_version','folio-finite-amount-guard-v2','definition_matches',true,'permissions_unchanged',true,'scope','Rejects non-finite future folio amounts; preserves reversals, arithmetic tolerance and permissions. No historical row changed.');
COMMIT;
