-- NEØ P0.2: Reservation Deposit Financial Atomicity
-- LOCAL DRAFT — NOT APPROVED FOR DEPLOYMENT
-- Ensures a newly recorded deposit cannot report success
-- when the financial posting function reports failure.
CREATE OR REPLACE FUNCTION public.neo_reservation_deposit_record(
  _reservation uuid, _amount numeric, _method text DEFAULT 'cash'::text,
  _reference text DEFAULT NULL::text, _idempotency_key text DEFAULT NULL::text,
  _notes text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _res public.reservations;
  _id uuid;
  _existing uuid;
  _post jsonb;
BEGIN
  IF NOT (public.has_permission('pms','reservations.edit') OR public.has_permission('finance','collections.record_payment')) THEN
    RAISE EXCEPTION 'Not permitted to record a reservation deposit';
  END IF;
  IF COALESCE(_amount,0) <= 0 THEN RAISE EXCEPTION 'A deposit must be greater than zero'; END IF;
  IF NULLIF(btrim(COALESCE(_idempotency_key,'')), '') IS NULL THEN RAISE EXCEPTION 'A deposit idempotency key is required'; END IF;

  SELECT * INTO _res FROM public.reservations
   WHERE id = _reservation AND organization_id = _org FOR UPDATE;
  IF _res.id IS NULL THEN RAISE EXCEPTION 'Reservation not found'; END IF;

  SELECT id INTO _existing FROM public.reservation_deposits
   WHERE organization_id = _org AND idempotency_key = _idempotency_key;
  IF _existing IS NOT NULL THEN
    _post := public.neo_deposit_post(_existing, true);
    RETURN jsonb_build_object('deposit_id', _existing, 'idempotent', true,
      'position', public.neo_reservation_deposit_position(_reservation), 'finance', _post);
  END IF;

  INSERT INTO public.reservation_deposits
    (organization_id, branch_id, reservation_id, customer_id, amount, method,
     reference, received_by, idempotency_key, notes)
  VALUES
    (_org, _res.branch_id, _reservation, _res.customer_id, round(_amount,2),
     COALESCE(NULLIF(lower(_method),''),'cash'), NULLIF(btrim(COALESCE(_reference,'')),''),
     auth.uid(), _idempotency_key, _notes)
  RETURNING id INTO _id;

  UPDATE public.reservations r
     SET deposit_paid = (SELECT COALESCE(sum(d.amount),0) FROM public.reservation_deposits d
                          WHERE d.reservation_id = _reservation AND d.status IN ('held','applied')),
         updated_at = now()
   WHERE r.id = _reservation;

  _post := public.neo_deposit_post(_id, true);

  IF COALESCE((_post->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Reservation deposit could not be posted to Finance: %',
      COALESCE(_post->>'detail', _post->>'reason', 'unknown failure');
  END IF;
  RETURN jsonb_build_object('deposit_id', _id, 'idempotent', false,
    'position', public.neo_reservation_deposit_position(_reservation), 'finance', _post);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_reservation_deposit_record(uuid,numeric,text,text,text,text)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.neo_reservation_deposit_record(uuid,numeric,text,text,text,text)
TO authenticated;
