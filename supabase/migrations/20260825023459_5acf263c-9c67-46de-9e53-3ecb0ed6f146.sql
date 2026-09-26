REVOKE ALL ON FUNCTION public.neo_department_stock_need_create(text, numeric, text, text, text, text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_department_stock_need_create(text, numeric, text, text, text, text, uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.neo_department_stock_need_review(uuid, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_department_stock_need_review(uuid, text, text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.neo_fo_checkin_readiness_guard() FROM PUBLIC, anon;
