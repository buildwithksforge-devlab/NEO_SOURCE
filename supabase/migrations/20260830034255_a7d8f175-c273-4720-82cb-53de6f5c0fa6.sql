CREATE OR REPLACE FUNCTION public.neo_reservation_history_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'Reservation history is immutable';
END;
$$;