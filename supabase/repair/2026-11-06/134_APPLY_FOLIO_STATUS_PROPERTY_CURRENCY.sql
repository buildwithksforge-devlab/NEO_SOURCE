BEGIN;
DO $guard$ BEGIN
 IF md5(pg_get_functiondef(to_regprocedure('public.tg_folio_sync_reservation_payment_status()'))) IS DISTINCT FROM 'ce2c9bbed195311a903704ecc2f6a5ff' THEN RAISE EXCEPTION 'Folio status definition differs; inspect before correction'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.folios') AND tgname='folio_sync_reservation_payment_status' AND tgenabled IN ('O','A') AND md5(pg_get_triggerdef(oid))='10f8dc9c5804c831bdf68731aede8505') THEN RAISE EXCEPTION 'Folio status trigger differs'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.tg_folio_sync_reservation_payment_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE reservation public.reservations; paid numeric; outstanding numeric; next_status text; before_arrival boolean;
BEGIN
 IF NEW.reservation_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO reservation FROM public.reservations r
  WHERE r.id=NEW.reservation_id AND r.organization_id=NEW.organization_id
   AND r.branch_id IS NOT DISTINCT FROM NEW.branch_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 -- Preserve valid installed behavior for protected organizations outside this repair.
 IF reservation.organization_id IS DISTINCT FROM 'aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
  next_status:=CASE WHEN coalesce(NEW.total_payments,0)<=0 THEN 'unpaid'
   WHEN coalesce(NEW.balance,0)<=0 THEN 'paid' ELSE 'part-paid' END;
  UPDATE public.reservations r SET payment_status=next_status,updated_at=now()
   WHERE r.id=reservation.id AND r.organization_id=reservation.organization_id AND r.payment_status IS DISTINCT FROM next_status;
  RETURN NEW;
 END IF;
 IF EXISTS(SELECT 1 FROM public.folios f WHERE f.reservation_id=reservation.id
   AND f.organization_id=reservation.organization_id AND f.branch_id IS NOT DISTINCT FROM reservation.branch_id
   AND coalesce(f.status,'open') NOT IN ('void','voided')
   AND coalesce(f.currency,'KES') IS DISTINCT FROM coalesce(nullif(public.neo_fact_currency(reservation.organization_id,reservation.branch_id),''),'KES')) THEN
  RAISE EXCEPTION 'Reservation folio currencies differ; reconcile the currency evidence before updating payment status' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM public.folios f WHERE f.reservation_id=reservation.id
   AND f.organization_id=reservation.organization_id AND f.branch_id IS NOT DISTINCT FROM reservation.branch_id
   AND coalesce(f.status,'open') NOT IN ('void','voided') AND (f.total_payments IS NULL OR f.balance IS NULL)) THEN
  RAISE EXCEPTION 'Reservation folio amounts are incomplete' USING ERRCODE='23514';
 END IF;
 SELECT coalesce(sum(f.total_payments),0),coalesce(sum(f.balance),0) INTO paid,outstanding
  FROM public.folios f WHERE f.reservation_id=reservation.id AND f.organization_id=reservation.organization_id
   AND f.branch_id IS NOT DISTINCT FROM reservation.branch_id AND coalesce(f.status,'open') NOT IN ('void','voided');
 IF paid::text IN ('NaN','Infinity','-Infinity') OR outstanding::text IN ('NaN','Infinity','-Infinity') THEN
  RAISE EXCEPTION 'Reservation folio amounts are not finite' USING ERRCODE='23514';
 END IF;
 before_arrival:=reservation.status IN ('enquiry','on-hold','waitlisted','tentative','pending-deposit','confirmed','guaranteed','provisional-hold','awaiting-deposit');
 IF before_arrival AND coalesce(reservation.total_amount,0)::text IN ('NaN','Infinity','-Infinity') THEN
  RAISE EXCEPTION 'Reservation quote is not finite' USING ERRCODE='23514';
 END IF;
 next_status:=CASE
  WHEN paid<=0 THEN 'unpaid'
  WHEN outstanding>0 THEN 'part-paid'
  WHEN before_arrival AND (coalesce(reservation.total_amount,0)<=0 OR paid<reservation.total_amount) THEN 'part-paid'
  ELSE 'paid' END;
 UPDATE public.reservations r SET payment_status=next_status,updated_at=now()
  WHERE r.id=reservation.id AND r.organization_id=reservation.organization_id AND r.payment_status IS DISTINCT FROM next_status;
 RETURN NEW;
END;
$function$;
COMMIT;
