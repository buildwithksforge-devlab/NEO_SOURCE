CREATE OR REPLACE FUNCTION public.neo_pos_lifecycle_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_setting('neo.payment_maintenance', true) = 'on' THEN RETURN NEW; END IF;

  IF NEW.status IN ('draft','cancelled','voided','void')
     AND coalesce(NEW.payment_status,'unpaid') IN ('paid','partial','partially_paid') THEN
    RAISE EXCEPTION 'A % order cannot be marked as %. Settle the order from the POS instead.',
      NEW.status, NEW.payment_status USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('closed','completed','settled')
     AND coalesce(NEW.payment_status,'unpaid') NOT IN ('paid','settled','complimentary','transferred','charged_to_room')
     AND coalesce(NEW.grand_total,0) > 0 THEN
    RAISE EXCEPTION 'This order cannot be closed while its payment is %.', NEW.payment_status
      USING ERRCODE = '23514';
  END IF;

  -- A fully settled order may not linger in an in-progress state.
  IF NEW.status IN ('sent','confirmed','preparing','ready','served','partially-served')
     AND coalesce(NEW.payment_status,'unpaid') IN ('paid','settled')
     AND coalesce(NEW.grand_total,0) > 0
     AND coalesce(NEW.paid_total,0) >= coalesce(NEW.grand_total,0) THEN
    RAISE EXCEPTION 'This order is fully paid and cannot remain %. Close the order to complete settlement.', NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $function$;