
-- =========================================================
-- NEØ Events repair — part 2: authoritative workspace RPCs
-- =========================================================

DROP FUNCTION IF EXISTS public.neo_event_workspace(uuid, date, date);
CREATE FUNCTION public.neo_event_workspace(_branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS TABLE (
  booking_id uuid,
  event_reference text,
  event_name text,
  status text,
  payment_status text,
  event_date date,
  start_at timestamptz,
  end_at timestamptz,
  setup_at timestamptz,
  breakdown_at timestamptz,
  branch_id uuid,
  branch_name text,
  venue_id uuid,
  venue_name text,
  customer_id uuid,
  customer_name text,
  corporate_account_id uuid,
  event_type_id uuid,
  event_type_name text,
  coordinator_id uuid,
  quotation_id uuid,
  quotation_number text,
  enquiry_id uuid,
  enquiry_number text,
  expected_guests integer,
  guaranteed_guests integer,
  final_guests integer,
  total_amount numeric,
  paid_amount numeric,
  balance_due numeric,
  deposit_required numeric,
  deposit_paid numeric,
  readiness_total integer,
  readiness_ready integer,
  readiness_blocked integer,
  billing_items integer,
  billing_total numeric,
  resource_reservations integer,
  feedback_responses integer,
  feedback_avg numeric,
  beo_status text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
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
    coalesce(b.total_amount, 0), coalesce(b.paid_amount, 0),
    coalesce(b.total_amount, 0) - coalesce(b.paid_amount, 0),
    coalesce(b.deposit_required, 0), coalesce(b.deposit_paid, 0),
    rd.total::int, rd.ready::int, rd.blocked::int,
    bl.items::int, bl.amount,
    rs.reservations::int,
    fb.responses::int, fb.avg_rating,
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
$$;

-- ---------- create ----------
CREATE OR REPLACE FUNCTION public.neo_event_booking_create(_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.current_org_id();
  v_branch uuid := nullif(_payload->>'branch_id', '')::uuid;
  v_venue uuid := nullif(_payload->>'venue_id', '')::uuid;
  v_quotation uuid := nullif(_payload->>'quotation_id', '')::uuid;
  v_enquiry uuid := nullif(_payload->>'enquiry_id', '')::uuid;
  v_idem text := nullif(_payload->>'idempotency_key', '');
  v_existing uuid;
  v_ref text;
  v_id uuid;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'No active workspace. Setup is incomplete.' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_permission('events', 'bookings', 'create') THEN
    RAISE EXCEPTION 'The events.bookings.create permission is required.' USING ERRCODE = '42501';
  END IF;
  IF v_branch IS NULL THEN
    RAISE EXCEPTION 'Select a property before creating an event — events cannot be created while viewing All Properties.' USING ERRCODE = '22023';
  END IF;
  IF NOT public.neo_branch_in_scope(v_branch) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = v_branch AND organization_id = v_org) THEN
    RAISE EXCEPTION 'The selected property does not belong to this workspace.' USING ERRCODE = '23514';
  END IF;

  IF v_idem IS NOT NULL THEN
    SELECT booking_id INTO v_existing FROM public.event_booking_idempotency
    WHERE key = v_idem AND organization_id = v_org;
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('booking_id', v_existing, 'created', false);
    END IF;
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

  v_ref := coalesce(nullif(_payload->>'event_reference', ''),
                    public.next_document_number('event_booking', 'EVT', v_branch));

  INSERT INTO public.event_bookings (
    organization_id, branch_id, event_reference, event_name, event_type_id,
    quotation_id, enquiry_id, customer_id, corporate_account_id, primary_contact,
    coordinator_id, venue_id, event_date, start_at, end_at, setup_at, breakdown_at,
    expected_guests, guaranteed_guests, service_style, seating_layout,
    dietary_requirements, accessibility_requirements, internal_notes,
    status, payment_status, deposit_required, total_amount, created_by, updated_by
  ) VALUES (
    v_org, v_branch, v_ref,
    nullif(_payload->>'event_name', ''),
    nullif(_payload->>'event_type_id', '')::uuid,
    v_quotation, v_enquiry,
    nullif(_payload->>'customer_id', '')::uuid,
    nullif(_payload->>'corporate_account_id', '')::uuid,
    nullif(_payload->>'primary_contact', ''),
    nullif(_payload->>'coordinator_id', '')::uuid,
    v_venue,
    (_payload->>'event_date')::date,
    (_payload->>'start_at')::timestamptz,
    (_payload->>'end_at')::timestamptz,
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

  IF v_idem IS NOT NULL THEN
    INSERT INTO public.event_booking_idempotency (key, organization_id, booking_id)
    VALUES (v_idem, v_org, v_id) ON CONFLICT (key) DO NOTHING;
  END IF;

  INSERT INTO public.event_activity_logs (organization_id, booking_id, enquiry_id, action, detail, actor_id)
  VALUES (v_org, v_id, v_enquiry, 'events.booking.created',
          jsonb_build_object('event_reference', v_ref, 'branch_id', v_branch, 'source',
                             coalesce(nullif(_payload->>'source', ''), 'manual')),
          auth.uid());

  RETURN jsonb_build_object('booking_id', v_id, 'event_reference', v_ref, 'created', true);
END
$$;

-- ---------- transfer ----------
CREATE OR REPLACE FUNCTION public.neo_event_booking_transfer(_booking uuid, _branch uuid, _reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.current_org_id();
  v_old uuid;
  v_ref text;
BEGIN
  IF NOT public.has_permission('events', 'bookings', 'transfer') THEN
    RAISE EXCEPTION 'The events.bookings.transfer permission is required.' USING ERRCODE = '42501';
  END IF;
  IF coalesce(trim(_reason), '') = '' THEN
    RAISE EXCEPTION 'A reason is required to transfer an event to another property.' USING ERRCODE = '22023';
  END IF;

  SELECT branch_id, event_reference INTO v_old, v_ref
  FROM public.event_bookings WHERE id = _booking AND organization_id = v_org;
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
    RETURN jsonb_build_object('booking_id', _booking, 'moved', false);
  END IF;

  PERFORM set_config('neo.event_transfer', 'on', true);

  UPDATE public.event_bookings
     SET branch_id = _branch,
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

  PERFORM set_config('neo.event_transfer', '', true);

  INSERT INTO public.event_activity_logs (organization_id, booking_id, action, detail, actor_id)
  VALUES (v_org, _booking, 'events.booking.transferred',
          jsonb_build_object('event_reference', v_ref, 'from_branch_id', v_old, 'to_branch_id', _branch, 'reason', _reason),
          auth.uid());

  RETURN jsonb_build_object('booking_id', _booking, 'moved', true, 'from_branch_id', v_old, 'to_branch_id', _branch);
END
$$;

-- ---------- conversions ----------
CREATE OR REPLACE FUNCTION public.neo_event_convert_enquiry(_enquiry uuid, _payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

CREATE OR REPLACE FUNCTION public.neo_event_convert_quotation(_quotation uuid, _payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.current_org_id();
  q public.event_quotations%ROWTYPE;
  v_existing uuid;
  v_result jsonb;
  v_branch uuid;
BEGIN
  IF NOT public.has_permission('events', 'quotations', 'convert') THEN
    RAISE EXCEPTION 'The events.quotations.convert permission is required.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO q FROM public.event_quotations WHERE id = _quotation AND organization_id = v_org;
  IF q.id IS NULL THEN
    RAISE EXCEPTION 'Quotation not found in this workspace.' USING ERRCODE = 'P0002';
  END IF;
  IF q.status NOT IN ('accepted', 'approved') THEN
    RAISE EXCEPTION 'Only an accepted quotation can become an event. This quotation is %.', q.status USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_existing FROM public.event_bookings WHERE quotation_id = _quotation AND organization_id = v_org LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('booking_id', v_existing, 'created', false);
  END IF;

  v_branch := coalesce(nullif(_payload->>'branch_id', '')::uuid, q.branch_id);
  IF v_branch IS NULL THEN
    RAISE EXCEPTION 'Select a property before converting this quotation.' USING ERRCODE = '22023';
  END IF;

  v_result := public.neo_event_booking_create(
    coalesce(_payload, '{}'::jsonb) || jsonb_build_object(
      'branch_id', v_branch,
      'quotation_id', q.id,
      'enquiry_id', q.enquiry_id,
      'customer_id', q.customer_id,
      'corporate_account_id', q.corporate_account_id,
      'event_type_id', q.event_type_id,
      'venue_id', q.venue_id,
      'event_name', coalesce(nullif(_payload->>'event_name', ''), q.title, q.quotation_number),
      'event_date', coalesce(nullif(_payload->>'event_date', ''), q.event_date::text),
      'start_at', coalesce(nullif(_payload->>'start_at', ''),
                           (coalesce(q.event_date, current_date) + coalesce(q.start_time, '09:00'::time))::text),
      'end_at', coalesce(nullif(_payload->>'end_at', ''),
                         (coalesce(q.event_date, current_date) + coalesce(q.end_time, '17:00'::time))::text),
      'expected_guests', coalesce(nullif(_payload->>'expected_guests', ''), q.guest_count::text),
      'total_amount', coalesce(q.grand_total, 0)::text,
      'deposit_required', coalesce(q.deposit_amount, 0)::text,
      'status', coalesce(nullif(_payload->>'status', ''), 'confirmed'),
      'source', 'quotation'
    ));

  INSERT INTO public.event_activity_logs (organization_id, booking_id, enquiry_id, action, detail, actor_id)
  VALUES (v_org, (v_result->>'booking_id')::uuid, q.enquiry_id, 'events.quotation.converted',
          jsonb_build_object('quotation_number', q.quotation_number, 'branch_id', v_branch), auth.uid());

  RETURN v_result;
END
$$;

-- ---------- reports ----------
CREATE OR REPLACE FUNCTION public.neo_event_reports(_branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_org uuid := public.current_org_id();
  v_from date := coalesce(_from, (current_date - 90));
  v_to date := coalesce(_to, (current_date + 180));
  v_out jsonb;
BEGIN
  IF NOT public.has_permission('events', 'reports', 'view') THEN
    RAISE EXCEPTION 'The events.reports.view permission is required.' USING ERRCODE = '42501';
  END IF;
  IF _branch IS NOT NULL AND NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'range', jsonb_build_object('from', v_from, 'to', v_to, 'branch_id', _branch),
    'bookings', jsonb_build_object(
      'total', count(*),
      'confirmed', count(*) FILTER (WHERE b.status = 'confirmed'),
      'tentative', count(*) FILTER (WHERE b.status = 'tentative'),
      'cancelled', count(*) FILTER (WHERE b.status = 'cancelled'),
      'completed', count(*) FILTER (WHERE b.status = 'completed'),
      'guests', coalesce(sum(coalesce(b.final_guests, b.guaranteed_guests, b.expected_guests, 0)), 0)
    ),
    'revenue', jsonb_build_object(
      'contracted', coalesce(sum(b.total_amount), 0),
      'collected', coalesce(sum(b.paid_amount), 0),
      'outstanding', coalesce(sum(coalesce(b.total_amount, 0) - coalesce(b.paid_amount, 0)), 0)
    ),
    'by_status', coalesce((
      SELECT jsonb_agg(jsonb_build_object('status', s.status, 'count', s.n, 'value', s.v) ORDER BY s.n DESC)
      FROM (
        SELECT b2.status, count(*) n, coalesce(sum(b2.total_amount), 0) v
        FROM public.event_bookings b2
        WHERE b2.organization_id = v_org AND (_branch IS NULL OR b2.branch_id = _branch)
          AND b2.event_date BETWEEN v_from AND v_to
        GROUP BY b2.status
      ) s), '[]'::jsonb),
    'by_venue', coalesce((
      SELECT jsonb_agg(jsonb_build_object('venue', coalesce(v.name, 'Unassigned'), 'count', s.n, 'value', s.v) ORDER BY s.n DESC)
      FROM (
        SELECT b3.venue_id, count(*) n, coalesce(sum(b3.total_amount), 0) v
        FROM public.event_bookings b3
        WHERE b3.organization_id = v_org AND (_branch IS NULL OR b3.branch_id = _branch)
          AND b3.event_date BETWEEN v_from AND v_to
        GROUP BY b3.venue_id
      ) s LEFT JOIN public.event_venues v ON v.id = s.venue_id), '[]'::jsonb)
  ) INTO v_out
  FROM public.event_bookings b
  WHERE b.organization_id = v_org
    AND (_branch IS NULL OR b.branch_id = _branch)
    AND b.event_date BETWEEN v_from AND v_to;

  SELECT v_out
    || jsonb_build_object('pipeline', jsonb_build_object(
         'enquiries', (SELECT count(*) FROM public.event_enquiries e
                        WHERE e.organization_id = v_org AND (_branch IS NULL OR e.branch_id = _branch)
                          AND e.created_at::date BETWEEN v_from AND v_to),
         'converted', (SELECT count(*) FROM public.event_enquiries e
                        WHERE e.organization_id = v_org AND (_branch IS NULL OR e.branch_id = _branch)
                          AND e.status = 'converted' AND e.created_at::date BETWEEN v_from AND v_to),
         'quotations', (SELECT count(*) FROM public.event_quotations q
                        WHERE q.organization_id = v_org AND (_branch IS NULL OR q.branch_id = _branch)
                          AND q.created_at::date BETWEEN v_from AND v_to),
         'quotations_accepted', (SELECT count(*) FROM public.event_quotations q
                        WHERE q.organization_id = v_org AND (_branch IS NULL OR q.branch_id = _branch)
                          AND q.status IN ('accepted','approved') AND q.created_at::date BETWEEN v_from AND v_to)))
    || jsonb_build_object('readiness', (
         SELECT jsonb_build_object(
           'total', count(*),
           'ready', count(*) FILTER (WHERE r.readiness IN ('ready','completed')),
           'blocked', count(*) FILTER (WHERE r.readiness = 'blocked'))
         FROM public.event_department_requirements r
         JOIN public.event_bookings b4 ON b4.id = r.booking_id
         WHERE b4.organization_id = v_org AND (_branch IS NULL OR b4.branch_id = _branch)
           AND b4.event_date BETWEEN v_from AND v_to))
  INTO v_out;

  RETURN v_out;
END
$$;

-- ---------- execution rights ----------
DO $g$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.neo_event_workspace(uuid, date, date)',
    'public.neo_event_booking_create(jsonb)',
    'public.neo_event_booking_transfer(uuid, uuid, text)',
    'public.neo_event_convert_enquiry(uuid, jsonb)',
    'public.neo_event_convert_quotation(uuid, jsonb)',
    'public.neo_event_reports(uuid, date, date)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END
$g$;
