CREATE OR REPLACE FUNCTION public.neo_reservation_financial_state_sync(_reservation uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE facts jsonb;
BEGIN
 IF _reservation IS NULL THEN RETURN; END IF;
 -- The existing facts routine verifies the active workspace. Never silently
 -- skip an out-of-context update and leave a stale reservation balance.
 facts:=public.neo_reservation_collection_facts(_reservation);
 UPDATE public.reservations r SET deposit_paid=(facts->>'deposit_paid')::numeric,
   payment_status=facts->>'payment_status',balance=(facts->>'outstanding')::numeric,
   status=CASE WHEN r.status='pending-deposit' AND (facts->>'minimum_deposit_satisfied')::boolean
     THEN 'confirmed' ELSE r.status END,updated_at=now()
 WHERE r.id=_reservation AND r.organization_id=public.current_org_id()
   AND (r.deposit_paid IS DISTINCT FROM (facts->>'deposit_paid')::numeric
     OR r.payment_status IS DISTINCT FROM facts->>'payment_status'
     OR r.balance IS DISTINCT FROM (facts->>'outstanding')::numeric
     OR (r.status='pending-deposit' AND (facts->>'minimum_deposit_satisfied')::boolean));
END $function$;
