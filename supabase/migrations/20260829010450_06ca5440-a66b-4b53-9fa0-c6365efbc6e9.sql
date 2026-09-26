REVOKE ALL ON FUNCTION public.neo_guard_kitchen_allocation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.neo_guard_kitchen_item_allocation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_guard_kitchen_allocation() TO service_role;
GRANT EXECUTE ON FUNCTION public.neo_guard_kitchen_item_allocation() TO service_role;