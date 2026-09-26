ALTER FUNCTION public.neo_guest_cart_set_quantity(uuid, numeric) SECURITY INVOKER;
ALTER FUNCTION public.neo_guest_cart_update(uuid, jsonb) SECURITY INVOKER;
ALTER FUNCTION public.neo_guest_toggle_favourite(uuid, uuid) SECURITY INVOKER;