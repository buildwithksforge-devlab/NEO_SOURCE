REVOKE EXECUTE ON FUNCTION public.neo_stock_average_cost(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_stock_average_cost(uuid, uuid) TO authenticated, service_role;