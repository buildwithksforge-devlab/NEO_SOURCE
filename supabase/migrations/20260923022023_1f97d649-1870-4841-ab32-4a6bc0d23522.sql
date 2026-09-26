GRANT EXECUTE ON FUNCTION public.delivery_assign_rider(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delivery_rider_advance(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delivery_confirm_delivery(uuid, text, text, numeric, numeric, numeric) TO authenticated;