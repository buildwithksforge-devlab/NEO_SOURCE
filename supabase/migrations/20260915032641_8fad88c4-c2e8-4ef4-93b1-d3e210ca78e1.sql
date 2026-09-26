CREATE OR REPLACE FUNCTION public.neo_delivery_canonical_owner(_stage text, _fulfilment text)
RETURNS TABLE(owner text, next_action text)
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT
    CASE lower(coalesce(_stage,'pending'))
      WHEN 'pending' THEN CASE WHEN _fulfilment='room-service' THEN 'Kitchen' ELSE 'Delivery' END
      WHEN 'awaiting-payment' THEN 'Delivery'
      WHEN 'accepted' THEN 'Kitchen'
      WHEN 'preparing' THEN 'Kitchen'
      WHEN 'ready' THEN 'Delivery'
      WHEN 'assigned' THEN 'Delivery'
      WHEN 'picked-up' THEN 'Delivery'
      WHEN 'en-route' THEN 'Delivery'
      WHEN 'delivered' THEN 'Finance'
      WHEN 'completed' THEN 'Finance'
      WHEN 'cancelled' THEN 'Finance'
      WHEN 'rejected' THEN 'Delivery'
      ELSE 'Delivery' END,
    CASE lower(coalesce(_stage,'pending'))
      WHEN 'pending' THEN CASE WHEN _fulfilment='room-service' THEN 'Prepare and deliver to the room' ELSE 'Accept the order and assign a rider' END
      WHEN 'awaiting-payment' THEN 'Confirm the payment, then accept the order'
      WHEN 'accepted' THEN 'Prepare the order'
      WHEN 'preparing' THEN 'Finish preparation and mark it ready'
      WHEN 'ready' THEN 'Assign a rider and dispatch'
      WHEN 'assigned' THEN 'Collect the order from the property'
      WHEN 'picked-up' THEN 'Deliver to the customer and capture proof'
      WHEN 'en-route' THEN 'Deliver to the customer and capture proof'
      WHEN 'delivered' THEN 'Settle the order and post the takings'
      WHEN 'completed' THEN 'Settle the order and post the takings'
      WHEN 'cancelled' THEN 'Confirm any refund and close the record'
      WHEN 'rejected' THEN 'Tell the customer and close the record'
      ELSE 'Move the order to its next stage' END;
$$;

REVOKE EXECUTE ON FUNCTION public.neo_delivery_canonical_owner(text, text) FROM anon;

CREATE OR REPLACE FUNCTION public.neo_delivery_canonical_progress()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE m record;
BEGIN
  IF NEW.order_status IS NOT DISTINCT FROM OLD.order_status THEN RETURN NEW; END IF;
  SELECT * INTO m FROM public.neo_delivery_canonical_owner(NEW.order_status, NEW.fulfilment_type);
  UPDATE public.canonical_transaction_states
     SET operational_state = coalesce(NEW.order_status, operational_state),
         current_owner = m.owner,
         next_action = m.next_action,
         updated_at = now()
   WHERE idempotency_key = 'delivery:' || NEW.id::text
     AND operational_state <> 'superseded';
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'delivery canonical progress failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_delivery_canonical_progress ON public.delivery_orders;
CREATE TRIGGER trg_delivery_canonical_progress
AFTER UPDATE OF order_status ON public.delivery_orders
FOR EACH ROW EXECUTE FUNCTION public.neo_delivery_canonical_progress();

UPDATE public.canonical_transaction_states c
   SET operational_state = d.order_status,
       current_owner = m.owner,
       next_action = m.next_action,
       updated_at = now()
  FROM public.delivery_orders d
  CROSS JOIN LATERAL public.neo_delivery_canonical_owner(d.order_status, d.fulfilment_type) m
 WHERE c.idempotency_key = 'delivery:' || d.id::text
   AND c.operational_state <> 'superseded'
   AND (c.operational_state IS DISTINCT FROM d.order_status OR c.next_action IS NULL OR c.current_owner IS NULL);