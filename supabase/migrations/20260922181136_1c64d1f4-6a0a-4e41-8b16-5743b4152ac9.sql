CREATE OR REPLACE FUNCTION public.neo_pos_can_take_payment()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.has_permission('pos','payments','process')
      OR public.has_permission('finance','collections','collect_payment')
      OR public.has_permission('finance','collections','settle_bill')
      OR public.has_permission('finance','collections','issue_receipt')
      OR public.has_permission('finance','payments','create')
      OR public.has_permission('finance','till','confirm_cash');
$$;

REVOKE ALL ON FUNCTION public.neo_pos_can_take_payment() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pos_can_take_payment() TO authenticated, service_role;

DO $mig$
DECLARE src text; patched text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='pos_record_payment_attempt';

  patched := replace(src,
    'IF NOT public.has_permission(''pos'',''payments'',''process'') THEN',
    'IF NOT public.neo_pos_can_take_payment() THEN');

  IF patched = src THEN
    RAISE EXCEPTION 'Payment permission guard not found in pos_record_payment_attempt';
  END IF;

  EXECUTE patched;
END
$mig$;
