CREATE OR REPLACE FUNCTION public.neo_guest_update_profile(
  _org uuid,
  _full_name text DEFAULT NULL,
  _preferred_name text DEFAULT NULL,
  _phone text DEFAULT NULL,
  _avatar_url text DEFAULT NULL,
  _preferred_language text DEFAULT NULL,
  _marketing_consent boolean DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  c public.customers;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  SELECT * INTO c FROM public.customers
   WHERE organization_id = _org AND auth_user_id = uid AND merged_into_id IS NULL
   LIMIT 1;
  IF c.id IS NULL THEN RAISE EXCEPTION 'No guest profile found for this account'; END IF;

  UPDATE public.customers
     SET full_name = COALESCE(NULLIF(btrim(_full_name), ''), full_name),
         preferred_name = COALESCE(_preferred_name, preferred_name),
         phone = COALESCE(NULLIF(btrim(_phone), ''), phone),
         avatar_url = COALESCE(_avatar_url, avatar_url),
         preferred_language = COALESCE(NULLIF(btrim(_preferred_language), ''), preferred_language),
         marketing_consent = COALESCE(_marketing_consent, marketing_consent),
         last_guest_app_activity_at = now(),
         updated_at = now()
   WHERE id = c.id;

  RETURN c.id;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_guest_update_profile(uuid, text, text, text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_guest_update_profile(uuid, text, text, text, text, text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_guest_create_request(
  _org uuid,
  _category text,
  _description text,
  _priority text DEFAULT 'normal'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  SELECT r.id, r.branch_id, r.room_id
    INTO res
    FROM public.reservations r
   WHERE r.organization_id = _org
     AND r.customer_id = c.id
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

REVOKE ALL ON FUNCTION public.neo_guest_create_request(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_guest_create_request(uuid, text, text, text) TO authenticated;