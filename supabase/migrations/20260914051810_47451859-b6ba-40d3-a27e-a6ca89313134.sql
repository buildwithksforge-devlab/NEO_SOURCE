CREATE OR REPLACE FUNCTION public.neo_delivery_fulfilment_stock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_fulfilled boolean; v_undone boolean;
BEGIN
  IF NEW.pos_order_id IS NULL THEN RETURN NEW; END IF;

  v_fulfilled := lower(COALESCE(NEW.order_status,'')) IN ('delivered','collected','completed')
                 AND lower(COALESCE(OLD.order_status,'')) IS DISTINCT FROM lower(COALESCE(NEW.order_status,''));

  v_undone := (lower(COALESCE(NEW.order_status,'')) IN ('cancelled','refunded')
               OR lower(COALESCE(NEW.payment_status,'')) = 'refunded')
              AND (lower(COALESCE(OLD.order_status,'')) IS DISTINCT FROM lower(COALESCE(NEW.order_status,''))
                   OR lower(COALESCE(OLD.payment_status,'')) IS DISTINCT FROM lower(COALESCE(NEW.payment_status,'')));

  IF v_fulfilled THEN
    -- The kitchen status machine only allows ready -> served, so a line that is
    -- still sent/accepted/preparing is walked through 'ready' first. Marking the
    -- lines served is what triggers the single, idempotent deduction; the
    -- order-line id keeps it to exactly one.
    UPDATE pos_order_items
       SET status = 'ready'
     WHERE order_id = NEW.pos_order_id
       AND COALESCE(status,'') IN ('sent','accepted','preparing');

    UPDATE pos_order_items
       SET status = 'served',
           served_at = COALESCE(served_at, now())
     WHERE order_id = NEW.pos_order_id
       AND COALESCE(status,'') IN ('ready','cancel-pending');
    RETURN NEW;
  END IF;

  IF v_undone THEN
    -- Same rule in reverse: everything reaches 'voided' through 'cancel-pending'.
    UPDATE pos_order_items
       SET status = 'cancel-pending'
     WHERE order_id = NEW.pos_order_id
       AND COALESCE(status,'') IN ('sent','accepted','preparing','ready','served');

    UPDATE pos_order_items
       SET status = 'voided'
     WHERE order_id = NEW.pos_order_id
       AND COALESCE(status,'') = 'cancel-pending';

    UPDATE pos_order_items
       SET status = 'cancelled'
     WHERE order_id = NEW.pos_order_id
       AND COALESCE(status,'') = 'draft';
  END IF;

  RETURN NEW;
END;
$function$;