ALTER FUNCTION public.neo_event_status_normalise(text,text) SET search_path = public;
ALTER FUNCTION public.neo_event_payment_status_normalise(text) SET search_path = public;

CREATE OR REPLACE FUNCTION public.neo_event_booking_normalise_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  NEW.status := public.neo_event_status_normalise(NEW.status, 'provisional-hold');
  NEW.payment_status := public.neo_event_payment_status_normalise(NEW.payment_status);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_event_bookings_normalise_status ON public.event_bookings;
CREATE TRIGGER trg_event_bookings_normalise_status
BEFORE INSERT OR UPDATE OF status, payment_status ON public.event_bookings
FOR EACH ROW EXECUTE FUNCTION public.neo_event_booking_normalise_status();