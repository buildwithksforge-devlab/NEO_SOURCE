
REVOKE ALL ON FUNCTION public.neo_item_group_store(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.inventory_consume_order_item_core(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_item_group_store(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.inventory_consume_order_item_core(uuid) TO service_role;
