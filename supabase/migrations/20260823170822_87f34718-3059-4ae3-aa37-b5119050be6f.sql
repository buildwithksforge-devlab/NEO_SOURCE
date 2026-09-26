CREATE OR REPLACE FUNCTION public.neo_event_booking_create(_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  v_branch uuid := nullif(_payload->>'branch_id', '')::uuid;
  v_venue uuid := nullif(_payload->>'venue_id', '')::uuid;
  v_quotation uuid := nullif(_payload->>'quotation_id', '')::uuid;
  v_enquiry uuid := nullif(_payload->>'enquiry_id', '')::uuid;
  v_type uuid := nullif(_payload->>'event_type_id', '')::uuid;
  v_customer uuid := nullif(_payload->>'customer_id', '')::uuid;
  v_corporate uuid := nullif(_payload->>'corporate_account_id', '')::uuid;
  v_coordinator uuid := nullif(_payload->>'coordinator_id', '')::uuid;
  v_name text := nullif(btrim(coalesce(_payload->>'event_name', '')), '');
  v_date date := nullif(_payload->>'event_date', '')::date;
  v_start timestamptz := nullif(_payload->>'start_at', '')::timestamptz;
  v_end timestamptz := nullif(_payload->>'end_at', '')::timestamptz;
  v_idem text := nullif(btrim(coalesce(_payload->>'idempotency_key', '')), '');
  v_existing uuid;
  v_existing_ref text;
  v_ref text;
  v_id uuid;
  v_claimed int;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'No active workspace. Setup is incomplete.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_permission('events', 'bookings', 'create') THEN
    RAISE EXCEPTION 'The events.bookings.create permission is required.' USING ERRCODE = '42501';
  END IF;
  IF v_idem IS NULL THEN
    RAISE EXCEPTION 'A submission reference is required to create an event.' USING ERRCODE = '22023';
  END IF;
  IF v_branch IS NULL THEN
    RAISE EXCEPTION 'Select a property before creating an event — events cannot be created while viewing All Properties.' USING ERRCODE = '22023';
  END IF;
  IF NOT public.neo_branch_in_scope(v_branch) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = v_branch AND organization_id = v_org AND coalesce(active, true)) THEN
    RAISE EXCEPTION 'The selected property is not an active property in this workspace.' USING ERRCODE = '23514';
  END IF;

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'An event name is required.' USING ERRCODE = '22023';
  END IF;
  IF v_date IS NULL THEN
    RAISE EXCEPTION 'An event date is required.' USING ERRCODE = '22023';
  END IF;
  IF v_start IS NULL OR v_end IS NULL THEN
    RAISE EXCEPTION 'A start time and an end time are required.' USING ERRCODE = '22023';
  END IF;
  IF v_start >= v_end THEN
    RAISE EXCEPTION 'The event must end after it starts.' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('neo_event_booking_create:' || v_org::text || ':' || v_idem, 0));

  SELECT i.booking_id, b.event_reference INTO v_existing, v_existing_ref
  FROM public.event_booking_idempotency i
  LEFT JOIN public.event_bookings b ON b.id = i.booking_id
  WHERE i.key = v_idem AND i.organization_id = v_org;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('booking_id', v_existing, 'event_reference', v_existing_ref, 'created', false);
  END IF;

  IF v_type IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.event_types WHERE id = v_type AND organization_id = v_org) THEN
    RAISE EXCEPTION 'The selected event type does not belong to this workspace.' USING ERRCODE = '23514';
  END IF;
  IF v_customer IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customers WHERE id = v_customer AND organization_id = v_org) THEN
    RAISE EXCEPTION 'The selected customer does not belong to this workspace.' USING ERRCODE = '23514';
  END IF;
  IF v_corporate IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.corporate_accounts WHERE id = v_corporate AND organization_id = v_org) THEN
    RAISE EXCEPTION 'The selected corporate account does not belong to this workspace.' USING ERRCODE = '23514';
  END IF;
  IF v_coordinator IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.employees WHERE id = v_coordinator AND organization_id = v_org
    UNION ALL
    SELECT 1 FROM public.profiles WHERE id = v_coordinator AND organization_id = v_org
  ) THEN
    RAISE EXCEPTION 'The selected coordinator does not belong to this workspace.' USING ERRCODE = '23514';
  END IF;

  IF v_venue IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.event_venues WHERE id = v_venue AND organization_id = v_org AND branch_id = v_branch
  ) THEN
    RAISE EXCEPTION 'The selected venue is not available at this property.' USING ERRCODE = '23514';
  END IF;
  IF v_quotation IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.event_quotations WHERE id = v_quotation AND organization_id = v_org AND branch_id = v_branch
  ) THEN
    RAISE EXCEPTION 'The linked quotation belongs to a different property.' USING ERRCODE = '23514';
  END IF;
  IF v_enquiry IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.event_enquiries WHERE id = v_enquiry AND organization_id = v_org AND branch_id = v_branch
  ) THEN
    RAISE EXCEPTION 'The linked enquiry belongs to a different property.' USING ERRCODE = '23514';
  END IF;

  v_ref := public.next_document_number('event_booking', 'EVT', v_branch);

  INSERT INTO public.event_bookings (
    organization_id, branch_id, event_reference, event_name, event_type_id,
    quotation_id, enquiry_id, customer_id, corporate_account_id, primary_contact,
    coordinator_id, venue_id, event_date, start_at, end_at, setup_at, breakdown_at,
    expected_guests, guaranteed_guests, service_style, seating_layout,
    dietary_requirements, accessibility_requirements, internal_notes,
    status, payment_status, deposit_required, total_amount, created_by, updated_by
  ) VALUES (
    v_org, v_branch, v_ref, v_name, v_type,
    v_quotation, v_enquiry, v_customer, v_corporate,
    coalesce(nullif(_payload->>'primary_contact', ''), ''),
    v_coordinator, v_venue, v_date, v_start, v_end,
    nullif(_payload->>'setup_at', '')::timestamptz,
    nullif(_payload->>'breakdown_at', '')::timestamptz,
    coalesce(nullif(_payload->>'expected_guests', '')::int, 0),
    nullif(_payload->>'guaranteed_guests', '')::int,
    coalesce(nullif(_payload->>'service_style', ''), 'buffet'),
    coalesce(nullif(_payload->>'seating_layout', ''), 'banquet'),
    coalesce(nullif(_payload->>'dietary_requirements', ''), ''),
    coalesce(nullif(_payload->>'accessibility_requirements', ''), ''),
    coalesce(nullif(_payload->>'internal_notes', ''), ''),
    coalesce(nullif(_payload->>'status', ''), 'tentative'),
    coalesce(nullif(_payload->>'payment_status', ''), 'unpaid'),
    coalesce(nullif(_payload->>'deposit_required', '')::numeric, 0),
    coalesce(nullif(_payload->>'total_amount', '')::numeric, 0),
    auth.uid(), auth.uid()
  ) RETURNING id INTO v_id;

  INSERT INTO public.event_booking_idempotency (key, organization_id, booking_id)
  VALUES (v_idem, v_org, v_id) ON CONFLICT (organization_id, key) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    RAISE EXCEPTION 'This event submission was already processed. No duplicate event was created.' USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.event_activity_logs (organization_id, booking_id, enquiry_id, action, detail, actor_id)
  VALUES (v_org, v_id, v_enquiry, 'events.booking.created',
          jsonb_build_object('event_reference', v_ref, 'branch_id', v_branch, 'source',
                             coalesce(nullif(_payload->>'source', ''), 'manual')),
          auth.uid());

  RETURN jsonb_build_object('booking_id', v_id, 'event_reference', v_ref, 'created', true);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.neo_event_booking_create(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_event_booking_create(jsonb) TO authenticated;