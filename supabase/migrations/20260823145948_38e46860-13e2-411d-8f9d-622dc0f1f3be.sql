REVOKE ALL ON FUNCTION public.tg_pos_recalc_order_totals() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_pos_order_totals_authoritative() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tg_pos_recalc_order_totals() TO service_role;
GRANT EXECUTE ON FUNCTION public.tg_pos_order_totals_authoritative() TO service_role;