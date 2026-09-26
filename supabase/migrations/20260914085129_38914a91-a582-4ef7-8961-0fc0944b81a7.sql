
CREATE OR REPLACE FUNCTION public.neo_delivery_kitchen_stage(_pos_order uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN count(*) = 0 THEN NULL
    WHEN count(*) FILTER (WHERE t.status <> 'cancelled') = 0 THEN 'cancelled'
    WHEN count(*) FILTER (
      WHERE t.status NOT IN ('cancelled', 'ready', 'served', 'completed')
    ) = 0 THEN 'ready'
    WHEN count(*) FILTER (
      WHERE t.status IN ('accepted', 'preparing', 'partially-ready')
    ) > 0 THEN 'preparing'
    ELSE 'new'
  END
  FROM public.station_tickets t
  WHERE t.order_id = _pos_order;
$$;

CREATE OR REPLACE FUNCTION public.neo_delivery_sync_kitchen_stage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _order uuid := COALESCE(NEW.order_id, OLD.order_id);
  _stage text;
BEGIN
  IF _order IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  _stage := public.neo_delivery_kitchen_stage(_order);
  IF _stage IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  UPDATE public.delivery_orders d
     SET kitchen_status = _stage,
         ready_at = CASE
           WHEN _stage = 'ready' AND d.ready_at IS NULL THEN now()
           ELSE d.ready_at
         END,
         updated_at = now()
   WHERE d.pos_order_id = _order
     AND d.kitchen_status IS DISTINCT FROM _stage
     AND d.order_status NOT IN ('delivered', 'closed', 'cancelled', 'rejected', 'failed', 'refunded');

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_delivery_kitchen_stage ON public.station_tickets;
CREATE TRIGGER trg_delivery_kitchen_stage
AFTER INSERT OR UPDATE OF status OR DELETE ON public.station_tickets
FOR EACH ROW EXECUTE FUNCTION public.neo_delivery_sync_kitchen_stage();

CREATE INDEX IF NOT EXISTS idx_station_tickets_order_status
  ON public.station_tickets (order_id, status);

-- Rebuild the projection for every open delivery order that already has tickets.
UPDATE public.delivery_orders d
   SET kitchen_status = s.stage,
       ready_at = CASE WHEN s.stage = 'ready' AND d.ready_at IS NULL THEN now() ELSE d.ready_at END,
       updated_at = now()
  FROM (
    SELECT o.id, public.neo_delivery_kitchen_stage(o.pos_order_id) AS stage
      FROM public.delivery_orders o
     WHERE o.pos_order_id IS NOT NULL
       AND o.order_status NOT IN ('delivered', 'closed', 'cancelled', 'rejected', 'failed', 'refunded')
  ) s
 WHERE d.id = s.id
   AND s.stage IS NOT NULL
   AND d.kitchen_status IS DISTINCT FROM s.stage;
