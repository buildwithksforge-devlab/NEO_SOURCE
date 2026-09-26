CREATE OR REPLACE FUNCTION public.neo_event_billing(_branch uuid DEFAULT NULL::uuid, _from date DEFAULT NULL::date, _to date DEFAULT NULL::date)
 RETURNS TABLE(booking_id uuid, event_reference text, event_name text, status text, payment_status text, event_date date, branch_id uuid, branch_name text, customer_name text, total_amount numeric, paid_amount numeric, balance_due numeric, deposit_required numeric, deposit_paid numeric, billing_items integer, billing_total numeric)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.has_permission('events', 'billing', 'view') THEN
    RAISE EXCEPTION 'The events.billing.view permission is required.' USING ERRCODE = '42501';
  END IF;
  IF _branch IS NOT NULL AND NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT b.id, b.event_reference, b.event_name, b.status, b.payment_status,
         b.event_date, b.branch_id, br.name,
         nullif(trim(coalesce(c.full_name, '')), ''),
         coalesce(b.total_amount, 0), coalesce(b.paid_amount, 0),
         coalesce(b.total_amount, 0) - coalesce(b.paid_amount, 0),
         coalesce(b.deposit_required, 0), coalesce(b.deposit_paid, 0),
         bl.items::int, bl.amount
  FROM public.event_bookings b
  LEFT JOIN public.branches br ON br.id = b.branch_id
  LEFT JOIN public.customers c ON c.id = b.customer_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS items, coalesce(sum(i.line_total), 0) AS amount
    FROM public.event_billing_items i WHERE i.booking_id = b.id
  ) bl ON true
  WHERE b.organization_id = public.current_org_id()
    AND public.neo_branch_in_scope(b.branch_id)
    AND (_branch IS NULL OR b.branch_id = _branch)
    AND (_from IS NULL OR b.event_date >= _from)
    AND (_to IS NULL OR b.event_date <= _to)
  ORDER BY b.event_date DESC;
END
$function$


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
$function$


CREATE OR REPLACE FUNCTION public.neo_event_booking_dependency_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_org uuid; v_branch uuid;
BEGIN
  IF NEW.booking_id IS NULL THEN
    RAISE EXCEPTION 'This record must belong to an event.' USING ERRCODE = '23514';
  END IF;
  SELECT organization_id, branch_id INTO v_org, v_branch FROM public.event_bookings WHERE id = NEW.booking_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'The parent event does not exist.' USING ERRCODE = '23503';
  END IF;
  IF v_branch IS NULL THEN
    RAISE EXCEPTION 'The parent event has no property assigned.' USING ERRCODE = '23514';
  END IF;
  IF NEW.organization_id IS NULL THEN
    NEW.organization_id := v_org;
  ELSIF NEW.organization_id <> v_org THEN
    RAISE EXCEPTION 'This record belongs to a different organisation than its event.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$


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
  v_enquiry uuid;
  v_quotation uuid;
  v_detached_enquiry uuid;
  v_detached_quotation uuid;
  v_traces_detached int := 0;
  v_documents_detached int := 0;
BEGIN
  IF NOT public.has_permission('events', 'bookings', 'transfer') THEN
    RAISE EXCEPTION 'The events.bookings.transfer permission is required.' USING ERRCODE = '42501';
  END IF;
  IF coalesce(trim(_reason), '') = '' THEN
    RAISE EXCEPTION 'A reason is required to transfer an event to another property.' USING ERRCODE = '22023';
  END IF;

  SELECT branch_id, event_reference, enquiry_id, quotation_id
    INTO v_old, v_ref, v_enquiry, v_quotation
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
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch AND organization_id = v_org AND active) THEN
    RAISE EXCEPTION 'The destination property is not active.' USING ERRCODE = '23514';
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

  -- Source records stay at their own property. Where they are incompatible with
  -- the destination they are detached from this event, never deleted.
  IF v_enquiry IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.event_enquiries e
    WHERE e.id = v_enquiry AND e.branch_id IS DISTINCT FROM _branch
  ) THEN
    v_detached_enquiry := v_enquiry;
  END IF;
  IF v_quotation IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.event_quotations q
    WHERE q.id = v_quotation AND q.branch_id IS DISTINCT FROM _branch
  ) THEN
    v_detached_quotation := v_quotation;
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
         enquiry_id = CASE WHEN v_detached_enquiry IS NOT NULL THEN NULL ELSE enquiry_id END,
         quotation_id = CASE WHEN v_detached_quotation IS NOT NULL THEN NULL ELSE quotation_id END,
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

  -- History and documents stay attached to the event; only an enquiry link that
  -- now points at another property is cleared, so no trace becomes cross-property.
  UPDATE public.event_activity_logs l
     SET enquiry_id = NULL
   WHERE l.booking_id = _booking
     AND l.enquiry_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.event_enquiries e WHERE e.id = l.enquiry_id AND e.branch_id IS DISTINCT FROM _branch);
  GET DIAGNOSTICS v_traces_detached = ROW_COUNT;

  UPDATE public.event_documents d
     SET enquiry_id = NULL
   WHERE d.booking_id = _booking
     AND d.enquiry_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.event_enquiries e WHERE e.id = d.enquiry_id AND e.branch_id IS DISTINCT FROM _branch);
  GET DIAGNOSTICS v_documents_detached = ROW_COUNT;

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
                             'room_blocks_released', v_rooms_released,
                             'detached_enquiry_id', v_detached_enquiry,
                             'detached_quotation_id', v_detached_quotation,
                             'traces_detached', v_traces_detached,
                             'documents_detached', v_documents_detached),
          auth.uid());

  RETURN jsonb_build_object('booking_id', _booking, 'moved', true,
                            'event_reference', v_new_ref,
                            'old_reference', v_ref, 'new_reference', v_new_ref,
                            'reference_reallocated', v_renumbered,
                            'from_branch_id', v_old, 'to_branch_id', _branch,
                            'venue_released', v_venue_released,
                            'venue_blocks_released', v_blocks_released,
                            'resource_reservations_released', v_resources_released,
                            'room_blocks_released', v_rooms_released,
                            'detached_enquiry_id', v_detached_enquiry,
                            'detached_quotation_id', v_detached_quotation,
                            'traces_detached', v_traces_detached,
                            'documents_detached', v_documents_detached);
END
$function$


CREATE OR REPLACE FUNCTION public.neo_event_grandchild_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_org uuid; v_parent uuid;
BEGIN
  IF TG_TABLE_NAME = 'event_menu_items' THEN
    v_parent := NEW.event_menu_id;
    SELECT organization_id INTO v_org FROM public.event_menus WHERE id = v_parent;
  ELSIF TG_TABLE_NAME = 'event_quotation_items' THEN
    v_parent := NEW.quotation_id;
    SELECT organization_id INTO v_org FROM public.event_quotations WHERE id = v_parent;
  ELSE
    v_parent := NEW.package_id;
    SELECT organization_id INTO v_org FROM public.event_packages WHERE id = v_parent;
  END IF;

  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'This line must belong to a parent record.' USING ERRCODE = '23514';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'The parent record does not exist.' USING ERRCODE = '23503';
  END IF;
  IF NEW.organization_id IS NULL THEN
    NEW.organization_id := v_org;
  ELSIF NEW.organization_id <> v_org THEN
    RAISE EXCEPTION 'This line belongs to a different organisation than its parent record.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$


CREATE OR REPLACE FUNCTION public.neo_event_reservation_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_org uuid; v_branch uuid; v_res_org uuid; v_res_branch uuid;
BEGIN
  IF NEW.booking_id IS NOT NULL THEN
    SELECT organization_id, branch_id INTO v_org, v_branch FROM public.event_bookings WHERE id = NEW.booking_id;
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'The parent event does not exist.' USING ERRCODE = '23503';
    END IF;
  END IF;

  IF NEW.resource_id IS NOT NULL THEN
    SELECT organization_id, branch_id INTO v_res_org, v_res_branch FROM public.event_resources WHERE id = NEW.resource_id;
    IF v_res_org IS NULL THEN
      RAISE EXCEPTION 'The selected resource does not exist.' USING ERRCODE = '23503';
    END IF;
    IF v_org IS NOT NULL AND v_res_org <> v_org THEN
      RAISE EXCEPTION 'The resource belongs to a different organisation than the event.' USING ERRCODE = '23514';
    END IF;
    IF v_branch IS NOT NULL AND v_res_branch IS NOT NULL AND v_res_branch <> v_branch THEN
      RAISE EXCEPTION 'The selected resource belongs to a different property than the event.' USING ERRCODE = '23514';
    END IF;
    IF v_org IS NULL THEN v_org := v_res_org; END IF;
  END IF;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'A reservation must reference an event or a resource.' USING ERRCODE = '23514';
  END IF;
  IF NEW.organization_id IS NULL THEN
    NEW.organization_id := v_org;
  ELSIF NEW.organization_id <> v_org THEN
    RAISE EXCEPTION 'This reservation belongs to a different organisation.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$


CREATE OR REPLACE FUNCTION public.neo_event_scope_booking(_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.event_bookings b
                 WHERE b.id = _id AND b.organization_id = public.current_org_id()
                   AND public.neo_branch_in_scope(b.branch_id));
$function$


CREATE OR REPLACE FUNCTION public.neo_event_scope_enquiry(_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.event_enquiries e
                 WHERE e.id = _id AND e.organization_id = public.current_org_id()
                   AND public.neo_branch_in_scope(e.branch_id));
$function$


CREATE OR REPLACE FUNCTION public.neo_event_scope_menu(_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.event_menus m
                 WHERE m.id = _id AND m.organization_id = public.current_org_id()
                   AND public.neo_event_scope_booking(m.booking_id));
$function$


CREATE OR REPLACE FUNCTION public.neo_event_scope_package(_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.event_packages p
                 WHERE p.id = _id AND p.organization_id = public.current_org_id()
                   AND public.neo_branch_in_scope(p.branch_id));
$function$


CREATE OR REPLACE FUNCTION public.neo_event_scope_quotation(_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.event_quotations q
                 WHERE q.id = _id AND q.organization_id = public.current_org_id()
                   AND public.neo_branch_in_scope(q.branch_id));
$function$


CREATE OR REPLACE FUNCTION public.neo_event_scope_resource(_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.event_resources r
                 WHERE r.id = _id AND r.organization_id = public.current_org_id()
                   AND public.neo_branch_in_scope(r.branch_id));
$function$


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
$function$


CREATE OR REPLACE FUNCTION public.neo_event_workspace(_branch uuid DEFAULT NULL::uuid, _from date DEFAULT NULL::date, _to date DEFAULT NULL::date)
 RETURNS TABLE(booking_id uuid, event_reference text, event_name text, status text, payment_status text, event_date date, start_at timestamp with time zone, end_at timestamp with time zone, setup_at timestamp with time zone, breakdown_at timestamp with time zone, branch_id uuid, branch_name text, venue_id uuid, venue_name text, customer_id uuid, customer_name text, corporate_account_id uuid, event_type_id uuid, event_type_name text, coordinator_id uuid, quotation_id uuid, quotation_number text, enquiry_id uuid, enquiry_number text, expected_guests integer, guaranteed_guests integer, final_guests integer, total_amount numeric, paid_amount numeric, balance_due numeric, deposit_required numeric, deposit_paid numeric, readiness_total integer, readiness_ready integer, readiness_blocked integer, billing_items integer, billing_total numeric, resource_reservations integer, feedback_responses integer, feedback_avg numeric, beo_status text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_financial boolean := public.has_permission('events', 'billing', 'view');
  v_readiness boolean := public.has_permission('events', 'readiness', 'view');
  v_resources boolean := public.has_permission('events', 'resources', 'view');
  v_feedback boolean := public.has_permission('events', 'feedback', 'view');
BEGIN
  IF NOT public.has_permission('events', 'bookings', 'view') THEN
    RAISE EXCEPTION 'The events.bookings.view permission is required.' USING ERRCODE = '42501';
  END IF;
  IF _branch IS NOT NULL AND NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    b.id, b.event_reference, b.event_name, b.status, b.payment_status,
    b.event_date, b.start_at, b.end_at, b.setup_at, b.breakdown_at,
    b.branch_id, br.name, b.venue_id, v.name,
    b.customer_id,
    nullif(trim(coalesce(c.full_name, '')), ''),
    b.corporate_account_id, b.event_type_id, et.name, b.coordinator_id,
    b.quotation_id, q.quotation_number, b.enquiry_id, e.enquiry_number,
    b.expected_guests, b.guaranteed_guests, b.final_guests,
    CASE WHEN v_financial THEN coalesce(b.total_amount, 0) END,
    CASE WHEN v_financial THEN coalesce(b.paid_amount, 0) END,
    CASE WHEN v_financial THEN coalesce(b.total_amount, 0) - coalesce(b.paid_amount, 0) END,
    CASE WHEN v_financial THEN coalesce(b.deposit_required, 0) END,
    CASE WHEN v_financial THEN coalesce(b.deposit_paid, 0) END,
    CASE WHEN v_readiness THEN rd.total::int END,
    CASE WHEN v_readiness THEN rd.ready::int END,
    CASE WHEN v_readiness THEN rd.blocked::int END,
    CASE WHEN v_financial THEN bl.items::int END,
    CASE WHEN v_financial THEN bl.amount END,
    CASE WHEN v_resources THEN rs.reservations::int END,
    CASE WHEN v_feedback THEN fb.responses::int END,
    CASE WHEN v_feedback THEN fb.avg_rating END,
    beo.status,
    b.created_at
  FROM public.event_bookings b
  LEFT JOIN public.branches br ON br.id = b.branch_id
  LEFT JOIN public.event_venues v ON v.id = b.venue_id
  LEFT JOIN public.customers c ON c.id = b.customer_id
  LEFT JOIN public.event_types et ON et.id = b.event_type_id
  LEFT JOIN public.event_quotations q ON q.id = b.quotation_id
  LEFT JOIN public.event_enquiries e ON e.id = b.enquiry_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS total,
           count(*) FILTER (WHERE r.readiness IN ('ready', 'completed')) AS ready,
           count(*) FILTER (WHERE r.readiness = 'blocked') AS blocked
    FROM public.event_department_requirements r WHERE r.booking_id = b.id
  ) rd ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS items, coalesce(sum(i.line_total), 0) AS amount
    FROM public.event_billing_items i WHERE i.booking_id = b.id
  ) bl ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS reservations
    FROM public.event_resource_reservations rr
    WHERE rr.booking_id = b.id AND coalesce(rr.status, '') <> 'released'
  ) rs ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS responses, round(avg(f.rating_overall)::numeric, 2) AS avg_rating
    FROM public.event_feedback f WHERE f.booking_id = b.id
  ) fb ON true
  LEFT JOIN LATERAL (
    SELECT o.status FROM public.banquet_event_orders o
    WHERE o.booking_id = b.id ORDER BY o.created_at DESC LIMIT 1
  ) beo ON true
  WHERE b.organization_id = public.current_org_id()
    AND (_branch IS NULL OR b.branch_id = _branch)
    AND (_from IS NULL OR b.event_date >= _from)
    AND (_to IS NULL OR b.event_date <= _to)
  ORDER BY b.event_date DESC, b.created_at DESC;
END
$function$

-- POLICIES
CREATE POLICY 'banquet_event_orders admin delete' ON public.banquet_event_orders FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'banquet_event_orders staff read' ON public.banquet_event_orders FOR SELECT USING (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'banquet_event_orders staff update' ON public.banquet_event_orders FOR UPDATE USING (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text)));
CREATE POLICY 'banquet_event_orders staff write' ON public.banquet_event_orders FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text)));
CREATE POLICY 'event_activity_logs staff update' ON public.event_activity_logs FOR UPDATE USING (((organization_id = current_org_id()) AND (neo_event_scope_booking(booking_id) OR neo_event_scope_enquiry(enquiry_id)) AND has_permission('events'::text, 'bookings'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND (neo_event_scope_booking(booking_id) OR neo_event_scope_enquiry(enquiry_id)) AND has_permission('events'::text, 'bookings'::text, 'edit'::text)));
CREATE POLICY 'event_activity_logs admin delete' ON public.event_activity_logs FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_activity_logs staff read' ON public.event_activity_logs FOR SELECT USING (((organization_id = current_org_id()) AND (neo_event_scope_booking(booking_id) OR neo_event_scope_enquiry(enquiry_id)) AND has_permission('events'::text, 'bookings'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'event_activity_logs staff write' ON public.event_activity_logs FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND (neo_event_scope_booking(booking_id) OR neo_event_scope_enquiry(enquiry_id)) AND has_permission('events'::text, 'bookings'::text, 'view'::text)));
CREATE POLICY 'event_billing_items admin delete' ON public.event_billing_items FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_billing_items staff read' ON public.event_billing_items FOR SELECT USING (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'billing'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'event_billing_items staff update' ON public.event_billing_items FOR UPDATE USING (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'billing'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'billing'::text, 'edit'::text)));
CREATE POLICY 'event_billing_items staff write' ON public.event_billing_items FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'billing'::text, 'create'::text)));
CREATE POLICY 'event_booking_idempotency staff read' ON public.event_booking_idempotency FOR SELECT USING ((organization_id = current_org_id())) WITH CHECK (-);
CREATE POLICY 'event_bookings staff write' ON public.event_bookings FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'bookings'::text, 'create'::text)));
CREATE POLICY 'event_bookings admin delete' ON public.event_bookings FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_bookings owner read' ON public.event_bookings FOR SELECT USING ((customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.auth_user_id = auth.uid())))) WITH CHECK (-);
CREATE POLICY 'event_bookings staff read' ON public.event_bookings FOR SELECT USING (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'bookings'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'event_bookings staff update' ON public.event_bookings FOR UPDATE USING (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text)));
CREATE POLICY 'event_change_requests staff write' ON public.event_change_requests FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text)));
CREATE POLICY 'event_change_requests admin delete' ON public.event_change_requests FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_change_requests staff read' ON public.event_change_requests FOR SELECT USING (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'event_change_requests staff update' ON public.event_change_requests FOR UPDATE USING (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text)));
CREATE POLICY 'event_department_requirements staff write' ON public.event_department_requirements FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'readiness'::text, 'create'::text)));
CREATE POLICY 'event_department_requirements admin delete' ON public.event_department_requirements FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_department_requirements staff read' ON public.event_department_requirements FOR SELECT USING (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'readiness'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'event_department_requirements staff update' ON public.event_department_requirements FOR UPDATE USING (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'readiness'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'readiness'::text, 'edit'::text)));
CREATE POLICY 'event_documents staff write' ON public.event_documents FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND (neo_event_scope_booking(booking_id) OR neo_event_scope_enquiry(enquiry_id)) AND has_permission('events'::text, 'bookings'::text, 'edit'::text)));
CREATE POLICY 'event_documents owner read' ON public.event_documents FOR SELECT USING ((visible_to_client AND (customer_id IS NOT NULL) AND (customer_id = my_customer_id()) AND ((EXISTS ( SELECT 1
   FROM event_bookings b
  WHERE ((b.id = event_documents.booking_id) AND (b.customer_id = event_documents.customer_id) AND (b.organization_id = event_documents.organization_id)))) OR (EXISTS ( SELECT 1
   FROM event_enquiries e
  WHERE ((e.id = event_documents.enquiry_id) AND (e.customer_id = event_documents.customer_id) AND (e.organization_id = event_documents.organization_id))))))) WITH CHECK (-);
CREATE POLICY 'event_documents admin delete' ON public.event_documents FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_documents staff update' ON public.event_documents FOR UPDATE USING (((organization_id = current_org_id()) AND (neo_event_scope_booking(booking_id) OR neo_event_scope_enquiry(enquiry_id)) AND has_permission('events'::text, 'bookings'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND (neo_event_scope_booking(booking_id) OR neo_event_scope_enquiry(enquiry_id)) AND has_permission('events'::text, 'bookings'::text, 'edit'::text)));
CREATE POLICY 'event_documents staff read' ON public.event_documents FOR SELECT USING (((organization_id = current_org_id()) AND (neo_event_scope_booking(booking_id) OR neo_event_scope_enquiry(enquiry_id)) AND has_permission('events'::text, 'bookings'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'event_enquiries staff read' ON public.event_enquiries FOR SELECT USING (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'enquiries'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'event_enquiries admin delete' ON public.event_enquiries FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_enquiries staff update' ON public.event_enquiries FOR UPDATE USING (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'enquiries'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'enquiries'::text, 'edit'::text)));
CREATE POLICY 'event_enquiries staff write' ON public.event_enquiries FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'enquiries'::text, 'create'::text)));
CREATE POLICY 'event_enquiries owner read' ON public.event_enquiries FOR SELECT USING ((customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.auth_user_id = auth.uid())))) WITH CHECK (-);
CREATE POLICY 'event_feedback staff write' ON public.event_feedback FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'feedback'::text, 'create'::text)));
CREATE POLICY 'event_feedback staff update' ON public.event_feedback FOR UPDATE USING (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'feedback'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'feedback'::text, 'edit'::text)));
CREATE POLICY 'event_feedback staff read' ON public.event_feedback FOR SELECT USING (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'feedback'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'event_feedback owner read' ON public.event_feedback FOR SELECT USING ((customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.auth_user_id = auth.uid())))) WITH CHECK (-);
CREATE POLICY 'event_feedback admin delete' ON public.event_feedback FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_guest_counts admin delete' ON public.event_guest_counts FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_guest_counts staff read' ON public.event_guest_counts FOR SELECT USING (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'event_guest_counts staff update' ON public.event_guest_counts FOR UPDATE USING (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text)));
CREATE POLICY 'event_guest_counts staff write' ON public.event_guest_counts FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text)));
CREATE POLICY 'event_menu_items staff write' ON public.event_menu_items FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_menu(event_menu_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text)));
CREATE POLICY 'event_menu_items admin delete' ON public.event_menu_items FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_menu_items staff read' ON public.event_menu_items FOR SELECT USING (((organization_id = current_org_id()) AND neo_event_scope_menu(event_menu_id) AND has_permission('events'::text, 'bookings'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'event_menu_items staff update' ON public.event_menu_items FOR UPDATE USING (((organization_id = current_org_id()) AND neo_event_scope_menu(event_menu_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_menu(event_menu_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text)));
CREATE POLICY 'event_menus admin delete' ON public.event_menus FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_menus staff write' ON public.event_menus FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text)));
CREATE POLICY 'event_menus staff update' ON public.event_menus FOR UPDATE USING (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text)));
CREATE POLICY 'event_menus staff read' ON public.event_menus FOR SELECT USING (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'event_milestones admin delete' ON public.event_milestones FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_milestones staff read' ON public.event_milestones FOR SELECT USING (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'event_milestones staff update' ON public.event_milestones FOR UPDATE USING (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text)));
CREATE POLICY 'event_milestones staff write' ON public.event_milestones FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text)));
CREATE POLICY 'event_package_items staff update' ON public.event_package_items FOR UPDATE USING (((organization_id = current_org_id()) AND neo_event_scope_package(package_id) AND has_permission('events'::text, 'packages'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_package(package_id) AND has_permission('events'::text, 'packages'::text, 'edit'::text)));
CREATE POLICY 'event_package_items admin delete' ON public.event_package_items FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_package_items staff read' ON public.event_package_items FOR SELECT USING (((organization_id = current_org_id()) AND neo_event_scope_package(package_id) AND has_permission('events'::text, 'packages'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'event_package_items staff write' ON public.event_package_items FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_package(package_id) AND has_permission('events'::text, 'packages'::text, 'create'::text)));
CREATE POLICY 'event_packages staff write' ON public.event_packages FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'packages'::text, 'create'::text)));
CREATE POLICY 'event_packages admin delete' ON public.event_packages FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_packages staff read' ON public.event_packages FOR SELECT USING (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'packages'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'event_packages staff update' ON public.event_packages FOR UPDATE USING (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'packages'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'packages'::text, 'edit'::text)));
CREATE POLICY 'event_quotation_items staff read' ON public.event_quotation_items FOR SELECT USING (((organization_id = current_org_id()) AND neo_event_scope_quotation(quotation_id) AND has_permission('events'::text, 'quotations'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'event_quotation_items admin delete' ON public.event_quotation_items FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_quotation_items staff update' ON public.event_quotation_items FOR UPDATE USING (((organization_id = current_org_id()) AND neo_event_scope_quotation(quotation_id) AND has_permission('events'::text, 'quotations'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_quotation(quotation_id) AND has_permission('events'::text, 'quotations'::text, 'edit'::text)));
CREATE POLICY 'event_quotation_items staff write' ON public.event_quotation_items FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_quotation(quotation_id) AND has_permission('events'::text, 'quotations'::text, 'create'::text)));
CREATE POLICY 'event_quotations staff read' ON public.event_quotations FOR SELECT USING (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'quotations'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'event_quotations staff update' ON public.event_quotations FOR UPDATE USING (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'quotations'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'quotations'::text, 'edit'::text)));
CREATE POLICY 'event_quotations staff write' ON public.event_quotations FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'quotations'::text, 'create'::text)));
CREATE POLICY 'event_quotations admin delete' ON public.event_quotations FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_quotations owner read' ON public.event_quotations FOR SELECT USING (((status = ANY (ARRAY['sent'::text, 'viewed'::text, 'accepted'::text, 'rejected'::text, 'revision-requested'::text, 'expired'::text, 'converted'::text])) AND (customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.auth_user_id = auth.uid()))))) WITH CHECK (-);
CREATE POLICY 'event_requirements admin delete' ON public.event_requirements FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_requirements staff write' ON public.event_requirements FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'readiness'::text, 'create'::text)));
CREATE POLICY 'event_requirements staff update' ON public.event_requirements FOR UPDATE USING (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'readiness'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'readiness'::text, 'edit'::text)));
CREATE POLICY 'event_requirements staff read' ON public.event_requirements FOR SELECT USING (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'readiness'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'event_resource_reservations admin delete' ON public.event_resource_reservations FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_resource_reservations staff read' ON public.event_resource_reservations FOR SELECT USING (((organization_id = current_org_id()) AND (neo_event_scope_booking(booking_id) OR ((booking_id IS NULL) AND neo_event_scope_resource(resource_id))) AND has_permission('events'::text, 'resources'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'event_resource_reservations staff update' ON public.event_resource_reservations FOR UPDATE USING (((organization_id = current_org_id()) AND (neo_event_scope_booking(booking_id) OR ((booking_id IS NULL) AND neo_event_scope_resource(resource_id))) AND has_permission('events'::text, 'resources'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND (neo_event_scope_booking(booking_id) OR ((booking_id IS NULL) AND neo_event_scope_resource(resource_id))) AND has_permission('events'::text, 'resources'::text, 'edit'::text)));
CREATE POLICY 'event_resource_reservations staff write' ON public.event_resource_reservations FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND (neo_event_scope_booking(booking_id) OR ((booking_id IS NULL) AND neo_event_scope_resource(resource_id))) AND has_permission('events'::text, 'resources'::text, 'edit'::text)));
CREATE POLICY 'event_resources staff update' ON public.event_resources FOR UPDATE USING (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'resources'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'resources'::text, 'edit'::text)));
CREATE POLICY 'event_resources staff write' ON public.event_resources FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'resources'::text, 'create'::text)));
CREATE POLICY 'event_resources staff read' ON public.event_resources FOR SELECT USING (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'resources'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'event_resources admin delete' ON public.event_resources FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_room_blocks admin delete' ON public.event_room_blocks FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_room_blocks staff update' ON public.event_room_blocks FOR UPDATE USING (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text)));
CREATE POLICY 'event_room_blocks staff read' ON public.event_room_blocks FOR SELECT USING (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'event_room_blocks staff write' ON public.event_room_blocks FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text)));
CREATE POLICY 'event_types admin delete' ON public.event_types FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_types staff write' ON public.event_types FOR INSERT USING (-) WITH CHECK ((organization_id = current_org_id()));
CREATE POLICY 'event_types staff update' ON public.event_types FOR UPDATE USING ((organization_id = current_org_id())) WITH CHECK ((organization_id = current_org_id()));
CREATE POLICY 'event_types staff read' ON public.event_types FOR SELECT USING ((organization_id = current_org_id())) WITH CHECK (-);
CREATE POLICY 'event_vendors staff write' ON public.event_vendors FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text)));
CREATE POLICY 'event_vendors admin delete' ON public.event_vendors FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_vendors staff read' ON public.event_vendors FOR SELECT USING (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'event_vendors staff update' ON public.event_vendors FOR UPDATE USING (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND neo_event_scope_booking(booking_id) AND has_permission('events'::text, 'bookings'::text, 'edit'::text)));
CREATE POLICY 'event_venues admin delete' ON public.event_venues FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'event_venues staff write' ON public.event_venues FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'venues'::text, 'create'::text)));
CREATE POLICY 'event_venues staff update' ON public.event_venues FOR UPDATE USING (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'venues'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'venues'::text, 'edit'::text)));
CREATE POLICY 'event_venues staff read' ON public.event_venues FOR SELECT USING (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'venues'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'site_visits staff read' ON public.site_visits FOR SELECT USING (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'site-visits'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'site_visits staff write' ON public.site_visits FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'site-visits'::text, 'create'::text)));
CREATE POLICY 'site_visits admin delete' ON public.site_visits FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'site_visits staff update' ON public.site_visits FOR UPDATE USING (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'site-visits'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'site-visits'::text, 'edit'::text)));
CREATE POLICY 'venue_blocks staff write' ON public.venue_blocks FOR INSERT USING (-) WITH CHECK (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'venues'::text, 'edit'::text)));
CREATE POLICY 'venue_blocks admin delete' ON public.venue_blocks FOR DELETE USING (((organization_id = current_org_id()) AND is_org_admin())) WITH CHECK (-);
CREATE POLICY 'venue_blocks staff read' ON public.venue_blocks FOR SELECT USING (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'venues'::text, 'view'::text))) WITH CHECK (-);
CREATE POLICY 'venue_blocks staff update' ON public.venue_blocks FOR UPDATE USING (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'venues'::text, 'edit'::text))) WITH CHECK (((organization_id = current_org_id()) AND neo_branch_in_scope(branch_id) AND has_permission('events'::text, 'venues'::text, 'edit'::text)));
-- CONSTRAINTS
FOREIGN KEY (booking_id) REFERENCES event_bookings(id) ON DELETE CASCADE -- event_booking_idempotency
PRIMARY KEY (organization_id, key) -- event_booking_idempotency
CREATE UNIQUE INDEX event_bookings_org_branch_reference_key ON public.event_bookings USING btree (organization_id, branch_id, event_reference)
-- TRIGGERS
event_types_touch ON event_types
event_venues_touch ON event_venues
event_resources_touch ON event_resources
event_packages_touch ON event_packages
event_package_items_touch ON event_package_items
event_enquiries_touch ON event_enquiries
event_quotations_touch ON event_quotations
event_quotation_items_touch ON event_quotation_items
event_bookings_touch ON event_bookings
event_resource_reservations_touch ON event_resource_reservations
event_milestones_touch ON event_milestones
event_guest_counts_touch ON event_guest_counts
event_department_requirements_touch ON event_department_requirements
event_requirements_touch ON event_requirements
event_menus_touch ON event_menus
event_menu_items_touch ON event_menu_items
event_room_blocks_touch ON event_room_blocks
event_vendors_touch ON event_vendors
event_billing_items_touch ON event_billing_items
event_feedback_touch ON event_feedback
event_change_requests_touch ON event_change_requests
event_documents_touch ON event_documents
event_activity_logs_touch ON event_activity_logs
event_resource_capacity ON event_resource_reservations
event_booking_events_trg ON event_bookings
ev_event_booking_status_trg ON event_bookings
event_bookings_autopost_txn ON event_bookings
tg_neo_event_booking_guard ON event_bookings
tg_neo_event_child_branch ON event_billing_items
tg_neo_event_child_branch ON event_department_requirements
tg_neo_event_child_branch ON event_feedback
tg_neo_event_child_branch ON event_room_blocks
tg_neo_event_dependency ON event_requirements
tg_neo_event_dependency ON event_menus
tg_neo_event_dependency ON event_milestones
tg_neo_event_dependency ON event_vendors
tg_neo_event_dependency ON event_change_requests
tg_neo_event_dependency ON event_guest_counts
tg_neo_event_reservation_guard ON event_resource_reservations
tg_neo_event_grandchild ON event_menu_items
tg_neo_event_grandchild ON event_quotation_items
tg_neo_event_grandchild ON event_package_items
tg_neo_event_trace ON event_documents
tg_neo_event_trace ON event_activity_logs
