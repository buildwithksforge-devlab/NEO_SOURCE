CREATE OR REPLACE FUNCTION public.neo_laundry_completion_guard()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IN ('delivered','completed','closed') THEN
    IF coalesce(btrim(NEW.laundry_number), '') = '' THEN
      RAISE EXCEPTION 'This laundry order has no order number yet, so it cannot be completed.'
        USING ERRCODE = '23514';
    END IF;
    IF coalesce(NEW.total, 0) <= 0 THEN
      RAISE EXCEPTION 'This laundry order has no priced items, so it cannot be completed. Price the items first.'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS neo_laundry_completion_guard_trg ON public.guest_laundry_orders;
CREATE TRIGGER neo_laundry_completion_guard_trg
  BEFORE INSERT OR UPDATE ON public.guest_laundry_orders
  FOR EACH ROW EXECUTE FUNCTION public.neo_laundry_completion_guard();

CREATE OR REPLACE FUNCTION public.neo_pos_lifecycle_guard()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF current_setting('neo.payment_maintenance', true) = 'on' THEN RETURN NEW; END IF;

  IF NEW.status IN ('draft','cancelled','voided','void')
     AND coalesce(NEW.payment_status,'unpaid') IN ('paid','partial','partially_paid') THEN
    RAISE EXCEPTION 'A % order cannot be marked as %. Settle the order from the POS instead.',
      NEW.status, NEW.payment_status USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('draft','cancelled','voided','void')
     AND coalesce(NEW.paid_total,0) > 0 THEN
    RAISE EXCEPTION 'A % order cannot carry a paid amount. Reverse the payment first.', NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('closed','completed','settled')
     AND coalesce(NEW.payment_status,'unpaid') NOT IN ('paid','settled','complimentary','transferred','charged_to_room')
     AND coalesce(NEW.grand_total,0) > 0 THEN
    RAISE EXCEPTION 'This order cannot be closed while its payment is %.', NEW.payment_status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('sent','confirmed','preparing','ready','served','partially-served')
     AND coalesce(NEW.payment_status,'unpaid') IN ('paid','settled')
     AND coalesce(NEW.grand_total,0) > 0
     AND coalesce(NEW.paid_total,0) >= coalesce(NEW.grand_total,0) THEN
    RAISE EXCEPTION 'This order is fully paid and cannot remain %. Close the order to complete settlement.', NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $function$;