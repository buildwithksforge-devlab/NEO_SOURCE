CREATE OR REPLACE FUNCTION public.neo_guest_room_offers(
  _org uuid,
  _branch uuid,
  _arrival date,
  _departure date,
  _adults integer DEFAULT 1,
  _children integer DEFAULT 0
)
RETURNS TABLE(
  room_type_id uuid,
  room_type_name text,
  description text,
  max_occupancy integer,
  amenities jsonb,
  rooms_available integer,
  rate_plan_id uuid,
  rate_plan_name text,
  nightly_rate numeric,
  currency text,
  tax_rate numeric,
  service_charge_rate numeric,
  nights integer,
  total_amount numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _nights integer;
BEGIN
  IF _org IS NULL OR _branch IS NULL THEN RETURN; END IF;
  IF _arrival IS NULL OR _departure IS NULL OR _departure <= _arrival THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = _branch AND b.organization_id = _org) THEN RETURN; END IF;
  _nights := (_departure - _arrival);

  RETURN QUERY
  WITH types AS (
    SELECT rt.id, rt.name, rt.description, rt.max_occupancy, COALESCE(rt.amenities, '[]'::jsonb) AS amenities
      FROM public.room_types rt
     WHERE rt.organization_id = _org
       AND rt.branch_id = _branch
       AND COALESCE(rt.status,'active') = 'active'
       AND COALESCE(rt.max_occupancy, 99) >= (COALESCE(_adults,1) + COALESCE(_children,0))
  ), avail AS (
    SELECT t.id,
           (SELECT count(*) FROM public.pms_available_rooms(_branch,_arrival,_departure,t.id,_adults,_children,NULL))::integer AS free
      FROM types t
  ), plan AS (
    SELECT DISTINCT ON (rp.room_type_id)
           rp.room_type_id, rp.id, rp.name, rp.base_rate, rp.currency,
           COALESCE(rp.tax_rate,0) AS tax_rate, COALESCE(rp.service_charge_rate,0) AS service_charge_rate
      FROM public.rate_plans rp
     WHERE rp.organization_id = _org
       AND rp.branch_id = _branch
       AND COALESCE(rp.status,'active') = 'active'
       AND (rp.valid_from IS NULL OR rp.valid_from <= _arrival)
       AND (rp.valid_to IS NULL OR rp.valid_to >= _departure)
       AND rp.room_type_id IS NOT NULL
     ORDER BY rp.room_type_id, rp.base_rate ASC NULLS LAST
  )
  SELECT t.id, t.name, t.description, t.max_occupancy, t.amenities,
         a.free,
         p.id, p.name,
         COALESCE(p.base_rate,0),
         COALESCE(p.currency,'KES'),
         COALESCE(p.tax_rate,0),
         COALESCE(p.service_charge_rate,0),
         _nights,
         ROUND(COALESCE(p.base_rate,0) * _nights
               * (1 + COALESCE(p.tax_rate,0)/100 + COALESCE(p.service_charge_rate,0)/100), 2)
    FROM types t
    JOIN avail a ON a.id = t.id
    LEFT JOIN plan p ON p.room_type_id = t.id
   WHERE a.free > 0
   ORDER BY COALESCE(p.base_rate, 0) ASC, t.name;
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_guest_room_offers(uuid,uuid,date,date,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_guest_room_offers(uuid,uuid,date,date,integer,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_guest_create_booking(
  _org uuid,
  _branch uuid,
  _room_type uuid,
  _arrival date,
  _departure date,
  _adults integer DEFAULT 1,
  _children integer DEFAULT 0,
  _special_requests text DEFAULT NULL,
  _intent_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _customer public.customers;
  _key text := NULLIF(btrim(COALESCE(_intent_key,'')),'');
  _existing public.reservations;
  _offer record;
  _nights integer;
  _confirmation text;
  _created public.reservations;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to book a stay' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF _key IS NULL THEN RAISE EXCEPTION 'A booking reference key is required'; END IF;

  SELECT * INTO _customer FROM public.customers
   WHERE organization_id = _org AND auth_user_id = auth.uid() LIMIT 1;
  IF _customer.id IS NULL THEN RAISE EXCEPTION 'No guest profile for this account' USING ERRCODE = 'insufficient_privilege'; END IF;

  SELECT * INTO _existing FROM public.reservations
   WHERE organization_id = _org AND idempotency_key = 'guest:' || _key LIMIT 1;
  IF _existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'idempotent',true,'id',_existing.id,
                              'confirmation_number',_existing.confirmation_number,
                              'total_amount',_existing.total_amount);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = _branch AND b.organization_id = _org) THEN
    RAISE EXCEPTION 'Select a valid property';
  END IF;
  IF _arrival IS NULL OR _departure IS NULL OR _departure <= _arrival THEN
    RAISE EXCEPTION 'Departure must be after arrival';
  END IF;
  IF _arrival < CURRENT_DATE THEN RAISE EXCEPTION 'Arrival cannot be in the past'; END IF;

  SELECT * INTO _offer
    FROM public.neo_guest_room_offers(_org,_branch,_arrival,_departure,_adults,_children) o
   WHERE o.room_type_id = _room_type;
  IF _offer.room_type_id IS NULL THEN
    RAISE EXCEPTION 'That room type is no longer available for these dates';
  END IF;

  _nights := (_departure - _arrival);
  _confirmation := public.neo_reservation_confirmation_number(_org);

  INSERT INTO public.reservations
    (organization_id, branch_id, confirmation_number, customer_id, booking_source, reservation_type,
     arrival_date, departure_date, nights, adults, children, room_type_id, rate_plan_id,
     nightly_rate, tax_amount, discount_amount, total_amount, deposit_required, balance,
     guarantee_method, special_requests, status, rate_source, idempotency_key, created_by)
  VALUES
    (_org, _branch, _confirmation, _customer.id, 'guest-app', 'individual',
     _arrival, _departure, _nights, COALESCE(_adults,1), COALESCE(_children,0), _room_type, _offer.rate_plan_id,
     COALESCE(_offer.nightly_rate,0),
     ROUND(COALESCE(_offer.nightly_rate,0) * _nights * COALESCE(_offer.tax_rate,0)/100, 2),
     0,
     COALESCE(_offer.total_amount,0), 0, COALESCE(_offer.total_amount,0),
     'none', COALESCE(NULLIF(btrim(COALESCE(_special_requests,'')),''),''), 'tentative',
     'rate-plan', 'guest:' || _key, auth.uid())
  RETURNING * INTO _created;

  INSERT INTO public.reservation_history (organization_id, reservation_id, action, new_value, changed_by)
  VALUES (_org, _created.id, 'created',
          jsonb_build_object('source','guest-app','confirmation_number',_confirmation),
          auth.uid());

  PERFORM public.neo_guest_record_event(_org, 'booking.created', 'reservation', _created.id::text,
                                        jsonb_build_object('confirmation_number',_confirmation),
                                        'booking:' || _key, 'guest_app');

  RETURN jsonb_build_object('ok',true,'idempotent',false,'id',_created.id,
                            'confirmation_number',_confirmation,
                            'total_amount',_created.total_amount);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_guest_create_booking(uuid,uuid,uuid,date,date,integer,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_guest_create_booking(uuid,uuid,uuid,date,date,integer,integer,text,text) TO authenticated;