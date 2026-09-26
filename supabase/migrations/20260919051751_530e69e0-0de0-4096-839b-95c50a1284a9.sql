REVOKE ALL ON FUNCTION public.neo_can_transfer_stock() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_stores_transfer_create(uuid,uuid,uuid,jsonb,text,uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_stores_transfer_receive(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_stores_transfer_cancel(uuid,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_stock_need_fulfil(uuid,uuid,numeric,uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_stock_need_to_procurement(uuid,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_stock_need_link_item(uuid,uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_can_transfer_stock() TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_stores_transfer_create(uuid,uuid,uuid,jsonb,text,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_stores_transfer_receive(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_stores_transfer_cancel(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_stock_need_fulfil(uuid,uuid,numeric,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_stock_need_to_procurement(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_stock_need_link_item(uuid,uuid) TO authenticated;
