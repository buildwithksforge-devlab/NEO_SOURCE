REVOKE EXECUTE ON FUNCTION public.inventory_order_consumption_trigger() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.pms_guard_room_availability() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.inventory_consume_order_item(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.inventory_menu_profitability() FROM PUBLIC, anon;