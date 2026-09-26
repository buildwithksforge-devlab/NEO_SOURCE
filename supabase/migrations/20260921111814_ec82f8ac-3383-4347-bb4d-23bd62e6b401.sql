
CREATE OR REPLACE FUNCTION public.neo_guest_create_request(
  _org uuid, _category text, _description text, _priority text DEFAULT 'normal'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  c public.customers;
  res record;
  new_id uuid;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF _description IS NULL OR btrim(_description) = '' THEN
    RAISE EXCEPTION 'Describe what you need so the team can act on it';
  END IF;
  IF _category NOT IN ('housekeeping','maintenance','concierge','amenities','laundry','food-beverage','front-office','transport') THEN
    RAISE EXCEPTION 'Unsupported request category';
  END IF;

  SELECT * INTO c FROM public.customers
   WHERE organization_id = _org AND auth_user_id = uid AND merged_into_id IS NULL
   LIMIT 1;
  IF c.id IS NULL THEN RAISE EXCEPTION 'No guest profile found for this account'; END IF;

  -- The stay that gives this request its property and room: either booked
  -- under this customer, or one they have proved is theirs.
  SELECT r.id, r.branch_id, r.room_id
    INTO res
    FROM public.reservations r
    LEFT JOIN public.neo_stay_verifications v
      ON v.reservation_id = r.id AND v.auth_user_id = uid AND v.revoked_at IS NULL
   WHERE r.organization_id = _org
     AND (r.customer_id = c.id OR v.id IS NOT NULL)
     AND r.status IN ('checked_in','in_house')
   ORDER BY r.arrival_date DESC
   LIMIT 1;

  INSERT INTO public.guest_requests (
    organization_id, branch_id, reservation_id, customer_id, room_id,
    category, description, priority, status, request_type, created_by)
  VALUES (
    _org, COALESCE(res.branch_id, c.primary_branch_id), res.id, c.id, res.room_id,
    _category, btrim(_description), COALESCE(NULLIF(btrim(_priority), ''), 'normal'),
    'new', 'service', uid)
  RETURNING id INTO new_id;

  UPDATE public.customers SET last_guest_app_activity_at = now() WHERE id = c.id;

  PERFORM public.neo_guest_record_event(
    _org, 'request.created', 'guest_request', new_id::text,
    jsonb_build_object('category', _category), 'request:' || new_id::text, 'guest_app');

  RETURN new_id;
END;
$$;
