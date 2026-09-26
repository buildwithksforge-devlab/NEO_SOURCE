REVOKE EXECUTE ON FUNCTION public.neo_delivery_pin_notify(uuid, text, text) FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_pin_before_insert() FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_pin_after_insert() FROM public, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_pin_fingerprint(text, uuid) FROM public, anon, authenticated;