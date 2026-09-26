-- These routines are declared authenticated in src/lib/rpc-manifest.ts.
-- Explicit signatures prevent revoking other overloads used by public flows.
REVOKE EXECUTE ON FUNCTION public.neo_platform_set_listing(uuid,text,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_pos_apply_discount(uuid,uuid,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_staff_assignment_save(uuid,text,text,uuid,uuid,uuid[],uuid,uuid,boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_stock_item_save(uuid,uuid,jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_partner_message_send(uuid,text,uuid,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_journal_detail(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_relationship_property(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_guest_payment_availability(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_folio_projection(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_guest_my_hotels() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_partner_threads(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_payment_audit_trail(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_payment_lifecycle(uuid,date,date,uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_commerce_reconciliation(uuid,timestamptz,timestamptz) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_traffic_summary(uuid,date,date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.neo_stay_board(uuid) FROM PUBLIC, anon;

-- The kitchen/settings readiness hook calls this scoped reader directly.
-- It had been revoked from authenticated users, leaving the screen unusable.
GRANT EXECUTE ON FUNCTION public.neo_station_store_readiness(uuid) TO authenticated;
