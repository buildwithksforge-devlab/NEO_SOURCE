-- NEØ Events corrective repair: per-submission idempotency, concurrency-safe
-- creation, cross-property trace guard and transfer reference collisions.

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
  -- Every creation must carry a per-submission key so a retry of the same
  -- attempt is collapsed while two genuinely separate events are not.
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

  -- Serialise every concurrent call that carries the same tenant + submission
  -- key. The lock is transaction scoped, so the loser waits and then observes
  -- the winner's row on the re-check below instead of inserting a duplicate.
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

  -- References are always allocated by the server, never supplied by a client.
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
    nullif(_payload->>'primary_contact', ''),
    v_coordinator, v_venue, v_date, v_start, v_end,
    nullif(_payload->>'setup_at', '')::timestamptz,
    nullif(_payload->>'breakdown_at', '')::timestamptz,
    nullif(_payload->>'expected_guests', '')::int,
    nullif(_payload->>'guaranteed_guests', '')::int,
    nullif(_payload->>'service_style', ''),
    nullif(_payload->>'seating_layout', ''),
    nullif(_payload->>'dietary_requirements', ''),
    nullif(_payload->>'accessibility_requirements', ''),
    nullif(_payload->>'internal_notes', ''),
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
    -- Defensive: the key was claimed elsewhere despite the lock. Abort so the
    -- booking just inserted is rolled back rather than orphaned.
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

-- Conversions stay source keyed: each source converts exactly once, and the
-- key is guaranteed server side so a client can never omit it.
CREATE OR REPLACE FUNCTION public.neo_event_convert_enquiry(_enquiry uuid, _payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  e public.event_enquiries%ROWTYPE;
  v_existing uuid;
  v_result jsonb;
  v_branch uuid;
BEGIN
  IF NOT public.has_permission('events', 'enquiries', 'convert') THEN
    RAISE EXCEPTION 'The events.enquiries.convert permission is required.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO e FROM public.event_enquiries WHERE id = _enquiry AND organization_id = v_org;
  IF e.id IS NULL THEN
    RAISE EXCEPTION 'Enquiry not found in this workspace.' USING ERRCODE = 'P0002';
  END IF;

  SELECT id INTO v_existing FROM public.event_bookings WHERE enquiry_id = _enquiry AND organization_id = v_org LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('booking_id', v_existing, 'created', false);
  END IF;

  v_branch := coalesce(nullif(_payload->>'branch_id', '')::uuid, e.branch_id);
  IF v_branch IS NULL THEN
    RAISE EXCEPTION 'Select a property before converting this enquiry.' USING ERRCODE = '22023';
  END IF;

  v_result := public.neo_event_booking_create(
    coalesce(_payload, '{}'::jsonb) || jsonb_build_object(
      'idempotency_key', 'enquiry:' || _enquiry::text,
      'branch_id', v_branch,
      'enquiry_id', e.id,
      'customer_id', e.customer_id,
      'corporate_account_id', e.corporate_account_id,
      'event_type_id', e.event_type_id,
      'venue_id', CASE WHEN _payload ? 'venue_id' THEN _payload->>'venue_id' ELSE e.venue_id::text END,
      'primary_contact', e.contact_name,
      'coordinator_id', e.coordinator_id,
      'event_name', coalesce(nullif(_payload->>'event_name', ''), e.event_type_label, 'Event'),
      'event_date', coalesce(nullif(_payload->>'event_date', ''), e.proposed_date::text),
      'start_at', coalesce(nullif(_payload->>'start_at', ''),
                           (coalesce(e.proposed_date, current_date) + coalesce(e.start_time, '09:00'::time))::text),
      'end_at', coalesce(nullif(_payload->>'end_at', ''),
                         (coalesce(e.proposed_date, current_date) + coalesce(e.end_time, '17:00'::time))::text),
      'expected_guests', coalesce(nullif(_payload->>'expected_guests', ''),
                                  (coalesce(e.expected_adults, 0) + coalesce(e.expected_children, 0))::text),
      'status', coalesce(nullif(_payload->>'status', ''), 'tentative'),
      'source', 'enquiry'
    ));

  UPDATE public.event_enquiries SET status = 'converted', updated_by = auth.uid(), updated_at = now()
   WHERE id = _enquiry;

  INSERT INTO public.event_activity_logs (organization_id, booking_id, enquiry_id, action, detail, actor_id)
  VALUES (v_org, (v_result->>'booking_id')::uuid, _enquiry, 'events.enquiry.converted',
          jsonb_build_object('enquiry_number', e.enquiry_number, 'branch_id', v_branch), auth.uid());

  RETURN v_result;
END
$function$;

DO $do$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'neo_event_convert_quotation';
  -- Guarantee the quotation conversion always carries its source key.
  v_def := replace(v_def,
    'v_result := public.neo_event_booking_create(' || E'\n' || '    coalesce(_payload, ''{}''::jsonb) || jsonb_build_object(' || E'\n' || '      ''branch_id'', v_branch,',
    'v_result := public.neo_event_booking_create(' || E'\n' || '    coalesce(_payload, ''{}''::jsonb) || jsonb_build_object(' || E'\n' || '      ''idempotency_key'', ''quotation:'' || _quotation::text,' || E'\n' || '      ''branch_id'', v_branch,');
  EXECUTE v_def;
END
$do$;

-- Trace records must not straddle two properties either.
CREATE OR REPLACE FUNCTION public.neo_event_trace_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_booking_org uuid; v_enquiry_org uuid; v_org uuid;
  v_booking_branch uuid; v_enquiry_branch uuid;
BEGIN
  IF NEW.booking_id IS NULL AND NEW.enquiry_id IS NULL THEN
    RAISE EXCEPTION 'This record must reference an event or an enquiry.' USING ERRCODE = '23514';
  END IF;
  IF NEW.booking_id IS NOT NULL THEN
    SELECT organization_id, branch_id INTO v_booking_org, v_booking_branch
    FROM public.event_bookings WHERE id = NEW.booking_id;
    IF v_booking_org IS NULL THEN
      RAISE EXCEPTION 'The referenced event does not exist.' USING ERRCODE = '23503';
    END IF;
  END IF;
  IF NEW.enquiry_id IS NOT NULL THEN
    SELECT organization_id, branch_id INTO v_enquiry_org, v_enquiry_branch
    FROM public.event_enquiries WHERE id = NEW.enquiry_id;
    IF v_enquiry_org IS NULL THEN
      RAISE EXCEPTION 'The referenced enquiry does not exist.' USING ERRCODE = '23503';
    END IF;
  END IF;
  IF v_booking_org IS NOT NULL AND v_enquiry_org IS NOT NULL AND v_booking_org <> v_enquiry_org THEN
    RAISE EXCEPTION 'The event and the enquiry belong to different organisations.' USING ERRCODE = '23514';
  END IF;
  IF v_booking_branch IS NOT NULL AND v_enquiry_branch IS NOT NULL
     AND v_booking_branch <> v_enquiry_branch THEN
    RAISE EXCEPTION 'The event and the enquiry belong to different properties.' USING ERRCODE = '23514';
  END IF;
  v_org := coalesce(v_booking_org, v_enquiry_org);
  IF NEW.organization_id IS NULL THEN
    NEW.organization_id := v_org;
  ELSIF NEW.organization_id <> v_org THEN
    RAISE EXCEPTION 'This record belongs to a different organisation than its event.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

-- Transfers must resolve a reference collision at the destination property.
CREATE OR REPLACE FUNCTION public.neo_event_booking_transfer(_booking uuid, _branch uuid, _reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  v_old uuid;
  v_ref text;
  v_new_ref text;
  v_renumbered boolean := false;
  v_venue_released boolean := false;
  v_resources_released int := 0;
  v_rooms_released int := 0;
  v_blocks_released int := 0;
BEGIN
  IF NOT public.has_permission('events', 'bookings', 'transfer') THEN
    RAISE EXCEPTION 'The events.bookings.transfer permission is required.' USING ERRCODE = '42501';
  END IF;
  IF coalesce(trim(_reason), '') = '' THEN
    RAISE EXCEPTION 'A reason is required to transfer an event to another property.' USING ERRCODE = '22023';
  END IF;

  SELECT branch_id, event_reference INTO v_old, v_ref
  FROM public.event_bookings WHERE id = _booking AND organization_id = v_org
  FOR UPDATE;
  IF v_ref IS NULL THEN
    RAISE EXCEPTION 'Event not found in this workspace.' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.neo_branch_in_scope(v_old) OR NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION 'Both the current and destination property must be within your access scope.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch AND organization_id = v_org) THEN
    RAISE EXCEPTION 'The destination property does not belong to this workspace.' USING ERRCODE = '23514';
  END IF;
  IF v_old = _branch THEN
    RETURN jsonb_build_object('booking_id', _booking, 'moved', false, 'event_reference', v_ref);
  END IF;

  v_new_ref := v_ref;
  IF EXISTS (
    SELECT 1 FROM public.event_bookings
    WHERE organization_id = v_org AND branch_id = _branch AND event_reference = v_ref AND id <> _booking
  ) THEN
    v_new_ref := public.next_document_number('event_booking', 'EVT', _branch);
    v_renumbered := true;
  END IF;

  PERFORM set_config('neo.event_transfer', 'on', true);

  UPDATE public.venue_blocks vb
     SET status = 'released',
         reason = coalesce(nullif(vb.reason, ''), '') || ' · released on property transfer'
   WHERE vb.booking_id = _booking
     AND coalesce(vb.status, '') <> 'released'
     AND NOT EXISTS (SELECT 1 FROM public.event_venues v WHERE v.id = vb.venue_id AND v.branch_id = _branch);
  GET DIAGNOSTICS v_blocks_released = ROW_COUNT;

  UPDATE public.event_resource_reservations rr
     SET status = 'released'
   WHERE rr.booking_id = _booking
     AND coalesce(rr.status, '') <> 'released'
     AND EXISTS (SELECT 1 FROM public.event_resources r WHERE r.id = rr.resource_id AND r.branch_id IS DISTINCT FROM _branch);
  GET DIAGNOSTICS v_resources_released = ROW_COUNT;

  UPDATE public.event_room_blocks
     SET rooms_blocked = 0, notes = coalesce(nullif(notes, ''), '') || ' · rooms released on property transfer'
   WHERE booking_id = _booking AND coalesce(rooms_blocked, 0) > 0;
  GET DIAGNOSTICS v_rooms_released = ROW_COUNT;

  SELECT EXISTS (
    SELECT 1 FROM public.event_bookings b
    WHERE b.id = _booking AND b.venue_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.event_venues v WHERE v.id = b.venue_id AND v.branch_id = _branch)
  ) INTO v_venue_released;

  UPDATE public.event_bookings
     SET branch_id = _branch,
         event_reference = v_new_ref,
         venue_id = CASE WHEN venue_id IS NULL THEN NULL
                         WHEN EXISTS (SELECT 1 FROM public.event_venues v WHERE v.id = venue_id AND v.branch_id = _branch)
                           THEN venue_id ELSE NULL END,
         updated_by = auth.uid(), updated_at = now()
   WHERE id = _booking;

  UPDATE public.event_billing_items SET branch_id = _branch WHERE booking_id = _booking;
  UPDATE public.event_department_requirements SET branch_id = _branch WHERE booking_id = _booking;
  UPDATE public.banquet_event_orders SET branch_id = _branch WHERE booking_id = _booking;
  UPDATE public.event_feedback SET branch_id = _branch WHERE booking_id = _booking;
  UPDATE public.venue_blocks SET branch_id = _branch WHERE booking_id = _booking;
  UPDATE public.event_room_blocks SET branch_id = _branch WHERE booking_id = _booking;

  PERFORM set_config('neo.event_transfer', '', true);

  INSERT INTO public.event_activity_logs (organization_id, booking_id, action, detail, actor_id)
  VALUES (v_org, _booking, 'events.booking.transferred',
          jsonb_build_object('event_reference', v_new_ref,
                             'old_reference', v_ref, 'new_reference', v_new_ref,
                             'reference_reallocated', v_renumbered,
                             'from_branch_id', v_old, 'to_branch_id', _branch,
                             'reason', _reason,
                             'venue_released', v_venue_released,
                             'venue_blocks_released', v_blocks_released,
                             'resource_reservations_released', v_resources_released,
                             'room_blocks_released', v_rooms_released),
          auth.uid());

  RETURN jsonb_build_object('booking_id', _booking, 'moved', true,
                            'event_reference', v_new_ref,
                            'old_reference', v_ref, 'new_reference', v_new_ref,
                            'reference_reallocated', v_renumbered,
                            'from_branch_id', v_old, 'to_branch_id', _branch,
                            'venue_released', v_venue_released,
                            'venue_blocks_released', v_blocks_released,
                            'resource_reservations_released', v_resources_released,
                            'room_blocks_released', v_rooms_released);
END
$function$;

REVOKE ALL ON FUNCTION public.neo_event_booking_create(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_event_booking_transfer(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_event_convert_enquiry(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_event_convert_quotation(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_event_booking_create(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_event_booking_transfer(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_event_convert_enquiry(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_event_convert_quotation(uuid, jsonb) TO authenticated;