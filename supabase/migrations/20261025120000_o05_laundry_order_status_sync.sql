-- NEØ O05: Keep guest laundry order readiness synchronized
-- with the linked laundry production batch.
--
-- Does not post guest charges, create linen movements,
-- or automatically confirm delivery.

CREATE OR REPLACE FUNCTION public.neo_laundry_batch_order_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN

    IF NEW.guest_order_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE'
       AND NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.guest_order_id IS NOT DISTINCT FROM OLD.guest_order_id
    THEN
        RETURN NEW;
    END IF;

    -- Production is ready, but customer handover has not occurred.
    IF NEW.status IN ('ready', 'handed-over', 'completed') THEN

        UPDATE public.guest_laundry_orders g
           SET status = 'ready-for-delivery',
               updated_at = now()
         WHERE g.id = NEW.guest_order_id
           AND g.organization_id = NEW.organization_id
           AND g.branch_id IS NOT DISTINCT FROM NEW.branch_id
           AND g.status = 'collected'

           -- Never release an order while another linked
           -- production batch remains unfinished.
           AND NOT EXISTS (
               SELECT 1
               FROM public.laundry_batches b
               WHERE b.guest_order_id = NEW.guest_order_id
                 AND b.organization_id = NEW.organization_id
                 AND b.id <> NEW.id
                 AND b.status NOT IN (
                     'ready',
                     'handed-over',
                     'completed',
                     'cancelled'
                 )
           );

    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_laundry_batch_order_sync
ON public.laundry_batches;

CREATE TRIGGER trg_laundry_batch_order_sync
AFTER INSERT OR UPDATE OF status, guest_order_id
ON public.laundry_batches
FOR EACH ROW
EXECUTE FUNCTION public.neo_laundry_batch_order_sync();

REVOKE ALL ON FUNCTION public.neo_laundry_batch_order_sync()
FROM PUBLIC, anon, authenticated;
