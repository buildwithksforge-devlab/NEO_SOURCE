
REVOKE EXECUTE ON FUNCTION public.neo_kitchen_ticket_delay(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.neo_kitchen_backfill_tickets(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.neo_kitchen_aggregate_ticket(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.neo_kitchen_item_transition(uuid, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.neo_kitchen_ticket_transition(uuid, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.kitchen_item_transition(uuid, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.neo_kitchen_invariant_violations() FROM anon;
REVOKE EXECUTE ON FUNCTION public.neo_kitchen_queue(uuid, uuid, text) FROM anon;
