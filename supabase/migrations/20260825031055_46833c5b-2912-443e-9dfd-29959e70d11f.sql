REVOKE ALL ON FUNCTION public.neo_stores_count_submit_variance(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_stores_requisition_reject(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_stores_no_self_approval() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_stores_count_submit_variance(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_stores_requisition_reject(uuid, text) TO authenticated;