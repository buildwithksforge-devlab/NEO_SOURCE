CREATE OR REPLACE FUNCTION public.neo_autopost_on_finalise()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE _res jsonb; _room text; _changed boolean;
BEGIN
  IF TG_TABLE_NAME = 'pos_orders' THEN
    _changed := (TG_OP = 'INSERT') OR (NEW.status IS DISTINCT FROM OLD.status);
    IF NEW.status IN ('closed','paid','settled','completed')
       AND _changed
       AND NEW.folio_id IS NOT NULL
       AND NEW.folio_post_status IS DISTINCT FROM 'posted' THEN
      PERFORM public.neo_finance_post_source('pos', NEW.id, true);
    END IF;

  ELSIF TG_TABLE_NAME = 'guest_laundry_orders' THEN
    _changed := (TG_OP = 'INSERT')
      OR NEW.status IS DISTINCT FROM OLD.status
      OR NEW.total IS DISTINCT FROM OLD.total
      OR NEW.folio_id IS DISTINCT FROM OLD.folio_id;
    IF NEW.status IN ('delivered','completed','closed')
       AND COALESCE(NEW.posting_status,'unposted') IS DISTINCT FROM 'posted'
       AND _changed THEN
      _res := public.neo_finance_post_source('laundry', NEW.id, true);
      IF NOT COALESCE((_res->>'ok')::boolean, false) THEN
        NEW.posting_status := 'blocked';
        SELECT room_number INTO _room FROM public.rooms WHERE id = NEW.room_id;
        PERFORM public.neo_notify(
          NEW.organization_id, NULL, NEW.branch_id, 'operational-alert',
          format('Guest laundry %s is not billed', COALESCE(NEW.laundry_number, '')),
          COALESCE(_res->>'detail', 'The laundry charge could not reach a guest folio.')
            || CASE WHEN _room IS NOT NULL THEN ' Room ' || _room || '.' ELSE '' END,
          '/laundry?order=' || NEW.id::text, 'high', true,
          'laundry', NEW.id, 'laundry.posting_blocked',
          'laundry-blocked:' || NEW.id::text || ':' || COALESCE(NEW.total,0)::text);
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION public.neo_autopost_txn()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF TG_TABLE_NAME = 'pos_orders' THEN
    IF NEW.status IN ('closed','paid','settled','completed')
       AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status)
       AND NEW.folio_id IS NULL THEN
      PERFORM public.neo_finance_post_txn('pos_order', NEW.id, true);
    END IF;

  ELSIF TG_TABLE_NAME = 'folio_lines' THEN
    IF NEW.status = 'posted' AND coalesce(NEW.line_type,'charge') <> 'payment'
       AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
      PERFORM public.neo_finance_post_txn('folio_charge', NEW.id, true);
    END IF;

  ELSIF TG_TABLE_NAME = 'payments' THEN
    IF NEW.status IN ('confirmed','completed','paid','succeeded','captured')
       AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
      PERFORM public.neo_finance_post_txn('folio_payment', NEW.id, true);
    END IF;

  ELSIF TG_TABLE_NAME = 'invoices' THEN
    IF NEW.status IN ('issued','sent','partially_paid','paid','overdue')
       AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
      PERFORM public.neo_finance_post_txn('event_invoice', NEW.id, true);
    END IF;

  ELSIF TG_TABLE_NAME = 'event_bookings' THEN
    IF coalesce(NEW.deposit_paid,0) > coalesce(OLD.deposit_paid,0) THEN
      PERFORM public.neo_finance_post_txn('event_deposit', NEW.id, true);
    END IF;
    IF NEW.status IN ('completed','closed') AND NEW.status IS DISTINCT FROM OLD.status THEN
      PERFORM public.neo_finance_post_txn('event_earned', NEW.id, true);
    END IF;
    IF NEW.status = 'cancelled' AND NEW.status IS DISTINCT FROM OLD.status THEN
      PERFORM public.neo_finance_post_txn('event_cancellation', NEW.id, true);
    END IF;

  ELSIF TG_TABLE_NAME = 'delivery_orders' THEN
    IF NEW.order_status IN ('delivered','completed')
       AND NEW.order_status IS DISTINCT FROM OLD.order_status THEN
      PERFORM public.neo_finance_post_txn('delivery_order', NEW.id, true);
    END IF;

  ELSIF TG_TABLE_NAME = 'guest_laundry_orders' THEN
    IF NEW.status IN ('delivered','completed','closed')
       AND NEW.status IS DISTINCT FROM OLD.status
       AND NEW.folio_id IS NULL
       AND coalesce(NEW.total,0) > 0 THEN
      PERFORM public.neo_finance_post_txn('laundry_order', NEW.id, true);
    END IF;

  ELSIF TG_TABLE_NAME = 'supplier_invoices' THEN
    IF NEW.approved_at IS NOT NULL AND NEW.status IN ('approved','matched','partially_paid','paid')
       AND (TG_OP = 'INSERT' OR OLD.approved_at IS NULL OR NEW.status IS DISTINCT FROM OLD.status) THEN
      PERFORM public.neo_finance_post_txn('supplier_invoice', NEW.id, true);
    END IF;

  ELSIF TG_TABLE_NAME = 'supplier_payments' THEN
    IF NEW.status IN ('paid','completed','settled')
       AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
      PERFORM public.neo_finance_post_txn('supplier_payment', NEW.id, true);
    END IF;
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS pos_orders_autopost ON public.pos_orders;
CREATE TRIGGER pos_orders_autopost AFTER INSERT OR UPDATE ON public.pos_orders
  FOR EACH ROW EXECUTE FUNCTION public.neo_autopost_on_finalise();

DROP TRIGGER IF EXISTS pos_orders_autopost_txn ON public.pos_orders;
CREATE TRIGGER pos_orders_autopost_txn AFTER INSERT OR UPDATE ON public.pos_orders
  FOR EACH ROW EXECUTE FUNCTION public.neo_autopost_txn();

CREATE OR REPLACE FUNCTION public.neo_kds_stamp_completion()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $fn$
BEGIN
  IF NEW.status IN ('ready','served','completed','collected') AND NEW.ready_at IS NULL THEN
    NEW.ready_at := now();
  END IF;
  IF NEW.status IN ('served','completed','collected') AND NEW.completed_at IS NULL THEN
    NEW.completed_at := COALESCE(NEW.ready_at, now());
  END IF;
  IF NEW.status IN ('cancelled','voided') AND NEW.cancelled_at IS NULL THEN
    NEW.cancelled_at := now();
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS neo_kds_stamp_completion_trg ON public.station_tickets;
CREATE TRIGGER neo_kds_stamp_completion_trg BEFORE INSERT OR UPDATE ON public.station_tickets
  FOR EACH ROW EXECUTE FUNCTION public.neo_kds_stamp_completion();

REVOKE ALL ON FUNCTION public.neo_kds_stamp_completion() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_kds_stamp_completion() TO service_role;