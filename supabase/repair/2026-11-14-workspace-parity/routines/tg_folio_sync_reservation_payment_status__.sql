CREATE OR REPLACE FUNCTION public.tg_folio_sync_reservation_payment_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE booking public.reservations;
BEGIN
 IF NEW.reservation_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO booking FROM public.reservations r WHERE r.id=NEW.reservation_id AND r.organization_id=NEW.organization_id AND r.branch_id IS NOT DISTINCT FROM NEW.branch_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 PERFORM public.neo_reservation_financial_state_sync(booking.id);
 RETURN NEW;
END $function$
