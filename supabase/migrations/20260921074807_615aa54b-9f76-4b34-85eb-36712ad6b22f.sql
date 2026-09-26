REVOKE EXECUTE ON FUNCTION public.pms_record_payment(uuid, numeric, text, text, text, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.neo_financial_accounts(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.neo_fin_activate_due_periods(uuid, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.neo_inventory_allows_negative(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pms_record_payment(uuid, numeric, text, text, text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_financial_accounts(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_fin_activate_due_periods(uuid, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_inventory_allows_negative(uuid, uuid) TO authenticated, service_role;