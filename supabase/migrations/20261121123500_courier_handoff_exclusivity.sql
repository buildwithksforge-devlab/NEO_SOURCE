-- Serialize courier handoff with the existing in-house rider assignment.
CREATE OR REPLACE FUNCTION public.neo_guard_courier_handoff()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  delivery public.delivery_orders%ROWTYPE;
BEGIN
  IF OLD.state <> 'requested' OR NEW.state <> 'sent' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO delivery FROM public.delivery_orders
   WHERE id = NEW.delivery_order_id AND organization_id = NEW.organization_id
   FOR UPDATE;

  IF NOT FOUND OR delivery.rider_id IS NOT NULL
      OR delivery.order_status IN ('rider-assigned', 'out-for-delivery', 'delivered', 'cancelled', 'rejected', 'failed') THEN
    RAISE EXCEPTION 'The delivery already has a rider or is closed.' USING ERRCODE = '23514';
  END IF;

  IF NEW.state_detail = 'Handoff started. Waiting for courier confirmation.' THEN
    INSERT INTO public.delivery_dispatch_events (organization_id, job_id, from_state, to_state, detail)
    VALUES (NEW.organization_id, NEW.id, OLD.state, NEW.state, NEW.state_detail);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.neo_guard_rider_assignment_during_courier_handoff()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.rider_id IS NOT NULL AND NEW.rider_id IS DISTINCT FROM OLD.rider_id AND EXISTS (
    SELECT 1 FROM public.delivery_dispatch_jobs
    WHERE delivery_order_id = NEW.id AND organization_id = NEW.organization_id
      AND state IN ('sent', 'accepted', 'picked_up', 'delivered')
  ) THEN
    RAISE EXCEPTION 'Confirm the existing courier handoff before assigning an in-house rider.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_guard_courier_handoff() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.neo_guard_rider_assignment_during_courier_handoff() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS neo_guard_courier_handoff ON public.delivery_dispatch_jobs;
CREATE TRIGGER neo_guard_courier_handoff BEFORE UPDATE OF state ON public.delivery_dispatch_jobs
FOR EACH ROW EXECUTE FUNCTION public.neo_guard_courier_handoff();

DROP TRIGGER IF EXISTS neo_guard_rider_assignment_during_courier_handoff ON public.delivery_orders;
CREATE TRIGGER neo_guard_rider_assignment_during_courier_handoff BEFORE UPDATE OF rider_id ON public.delivery_orders
FOR EACH ROW EXECUTE FUNCTION public.neo_guard_rider_assignment_during_courier_handoff();
