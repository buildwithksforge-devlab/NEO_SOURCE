CREATE OR REPLACE FUNCTION public.inventory_order_consumption_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r record; v_err text;
BEGIN
  IF lower(COALESCE(NEW.status,'')) NOT IN ('completed','paid','closed') THEN RETURN NEW; END IF;
  -- On UPDATE only react to a real status change; on INSERT an order that is
  -- already complete (quick sales rung up and settled at once) must still
  -- deduct its stock.
  IF TG_OP = 'UPDATE' AND lower(COALESCE(OLD.status,'')) = lower(COALESCE(NEW.status,'')) THEN RETURN NEW; END IF;

  FOR r IN SELECT id FROM pos_order_items WHERE order_id = NEW.id AND COALESCE(status,'') <> 'voided' LOOP
    BEGIN
      PERFORM public.inventory_consume_order_item(r.id);
    EXCEPTION WHEN OTHERS THEN
      -- Never block the sale, but never lose the reason either.
      v_err := SQLERRM;
      BEGIN
        INSERT INTO inventory_posting_events (organization_id, branch_id, order_id, order_item_id,
          posting_type, idempotency_key, status, payload)
        VALUES (NEW.organization_id, NEW.branch_id, NEW.id, r.id, 'consumption',
          'error:' || r.id::text, 'failed',
          jsonb_build_object('reason','consumption-failed','detail', v_err))
        ON CONFLICT DO NOTHING;

        INSERT INTO audit_logs (organization_id, branch_id, user_name, action, module, record_id, new_value, reason)
        VALUES (NEW.organization_id, NEW.branch_id, COALESCE(auth.uid()::text,'system'),
          'stock.consumption.failed', 'inventory', r.id::text,
          jsonb_build_object('order_id', NEW.id, 'detail', v_err),
          'Stock could not be deducted for this sold item');
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    END;
  END LOOP;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS pos_orders_inventory_consumption ON public.pos_orders;
CREATE TRIGGER pos_orders_inventory_consumption
AFTER INSERT OR UPDATE OF status ON public.pos_orders
FOR EACH ROW EXECUTE FUNCTION public.inventory_order_consumption_trigger();