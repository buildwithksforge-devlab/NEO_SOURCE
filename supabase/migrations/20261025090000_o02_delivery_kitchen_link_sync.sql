-- NEØ O02: Synchronize kitchen readiness when linking a delivery order.
-- No payment, stock, journal or historical transaction changes.

CREATE OR REPLACE FUNCTION public.neo_delivery_initial_kitchen_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_stage text;
BEGIN
    IF NEW.pos_order_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.order_status IN (
        'delivered', 'closed', 'cancelled',
        'rejected', 'failed', 'refunded'
    ) THEN
        RETURN NEW;
    END IF;

    v_stage := public.neo_delivery_kitchen_stage(NEW.pos_order_id);

    IF v_stage IS NULL THEN
        RETURN NEW;
    END IF;

    NEW.kitchen_status := v_stage;

    IF v_stage = 'ready' AND NEW.ready_at IS NULL THEN
        NEW.ready_at := now();
    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_delivery_initial_kitchen_sync
ON public.delivery_orders;

CREATE TRIGGER trg_delivery_initial_kitchen_sync
BEFORE INSERT OR UPDATE OF pos_order_id
ON public.delivery_orders
FOR EACH ROW
EXECUTE FUNCTION public.neo_delivery_initial_kitchen_sync();

REVOKE ALL ON FUNCTION public.neo_delivery_initial_kitchen_sync()
FROM PUBLIC, anon, authenticated;