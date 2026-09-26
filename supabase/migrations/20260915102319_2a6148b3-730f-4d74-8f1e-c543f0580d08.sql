CREATE OR REPLACE FUNCTION public.neo_delivery_consume_lines(_delivery uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE r record; v_count integer := 0;
BEGIN
  FOR r IN
    SELECT oi.id, oi.status
      FROM delivery_orders d
      JOIN pos_order_items oi ON oi.order_id = d.pos_order_id
     WHERE d.id = _delivery
       AND COALESCE(oi.status,'') NOT IN ('voided','cancelled','served','completed')
  LOOP
    BEGIN
      IF r.status IN ('sent','accepted','preparing') THEN
        UPDATE pos_order_items SET status = 'ready' WHERE id = r.id;
      END IF;
      UPDATE pos_order_items SET status = 'served' WHERE id = r.id AND status = 'ready';
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.neo_delivery_consume_lines(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_consume_lines(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.neo_delivery_consume_on_ready()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.pos_order_id IS NULL THEN RETURN NEW; END IF;
  IF (lower(COALESCE(NEW.kitchen_status,'')) IN ('ready','collected','completed')
      AND lower(COALESCE(NEW.kitchen_status,'')) IS DISTINCT FROM lower(COALESCE(OLD.kitchen_status,'')))
     OR (lower(COALESCE(NEW.order_status,'')) IN ('delivered','completed')
      AND lower(COALESCE(NEW.order_status,'')) IS DISTINCT FROM lower(COALESCE(OLD.order_status,'')))
  THEN
    PERFORM public.neo_delivery_consume_lines(NEW.id);
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.neo_delivery_consume_on_ready() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS neo_delivery_consume_on_ready_trg ON public.delivery_orders;
CREATE TRIGGER neo_delivery_consume_on_ready_trg
AFTER UPDATE OF kitchen_status, order_status ON public.delivery_orders
FOR EACH ROW EXECUTE FUNCTION public.neo_delivery_consume_on_ready();