REVOKE EXECUTE ON FUNCTION public.neo_station_consumption_location(uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_recipe_location_readiness(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_evaluate_low_stock(uuid, uuid, uuid, text, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_pos_item_void_effect() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.neo_pos_order_lifecycle_audit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_recipe_location_readiness(uuid) TO authenticated;