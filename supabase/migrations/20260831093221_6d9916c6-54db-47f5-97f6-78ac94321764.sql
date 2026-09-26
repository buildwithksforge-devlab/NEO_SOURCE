REVOKE ALL ON FUNCTION public.neo_reservation_financial_state_sync(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.neo_reservation_deposit_state_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.neo_room_state_consistency() FROM PUBLIC, anon, authenticated;