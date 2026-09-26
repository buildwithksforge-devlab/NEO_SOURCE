
CREATE OR REPLACE FUNCTION public.neo_event_beo_ensure(_booking uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  b public.event_bookings;
  existing uuid;
  new_id uuid;
BEGIN
  SELECT * INTO b FROM public.event_bookings WHERE id = _booking;
  IF b.id IS NULL THEN RAISE EXCEPTION 'Event booking not found'; END IF;
  IF b.organization_id IS DISTINCT FROM public.current_org_id() THEN
    RAISE EXCEPTION 'This event belongs to another workspace';
  END IF;
  IF NOT public.has_permission('events','bookings','edit') THEN
    RAISE EXCEPTION 'You do not have permission to prepare banquet event orders';
  END IF;

  SELECT id INTO existing
    FROM public.banquet_event_orders
   WHERE booking_id = _booking AND status <> 'superseded'
   ORDER BY revision DESC LIMIT 1;
  IF existing IS NOT NULL THEN RETURN existing; END IF;

  INSERT INTO public.banquet_event_orders (
    organization_id, branch_id, booking_id, beo_number, revision, change_summary,
    setup_at, guest_arrival_at, start_at, end_at, breakdown_at,
    guaranteed_guests, seating_layout, dietary_requirements, allergies,
    decor, entertainment, transport, security, status, created_by
  ) VALUES (
    b.organization_id, b.branch_id, b.id,
    'BEO-' || b.event_reference,
    1, 'Initial banquet event order raised from the confirmed booking.',
    b.start_at - interval '3 hours', b.start_at, b.start_at, b.end_at, b.end_at + interval '2 hours',
    GREATEST(b.expected_guests, 0), coalesce(nullif(b.seating_layout,''),'banquet'),
    b.dietary_requirements, b.allergy_warnings, b.decor_plan, b.entertainment,
    b.transport_notes, b.security_notes, 'draft', auth.uid()
  )
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.neo_event_beo_publish(_beo uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  o public.banquet_event_orders;
  b public.event_bookings;
  dept record;
  hk_dept uuid;
  hk_job uuid;
  created_reqs int := 0;
  created_acks int := 0;
  billing_items int := 0;
BEGIN
  SELECT * INTO o FROM public.banquet_event_orders WHERE id = _beo;
  IF o.id IS NULL THEN RAISE EXCEPTION 'Banquet event order not found'; END IF;
  IF o.organization_id IS DISTINCT FROM public.current_org_id() THEN
    RAISE EXCEPTION 'This banquet event order belongs to another workspace';
  END IF;
  IF NOT public.has_permission('events','bookings','edit') THEN
    RAISE EXCEPTION 'You do not have permission to publish banquet event orders';
  END IF;
  SELECT * INTO b FROM public.event_bookings WHERE id = o.booking_id;

  UPDATE public.banquet_event_orders
     SET status = 'published',
         published_at = coalesce(published_at, now()),
         locked = true,
         updated_by = auth.uid(),
         updated_at = now()
   WHERE id = _beo;

  -- Department handoffs: kitchen / food & beverage, housekeeping, front office.
  FOR dept IN
    SELECT * FROM (VALUES
      ('KITC', ARRAY['KITC','REST','FNB'], 'Production plan and service timing for ' || coalesce(nullif(b.event_name,''),'the event')),
      ('HOUS', ARRAY['HOUS'], 'Venue preparation, linen and cleanliness for ' || coalesce(nullif(b.event_name,''),'the event')),
      ('FRON', ARRAY['FRON'], 'Guest arrival, signage and directions for ' || coalesce(nullif(b.event_name,''),'the event'))
    ) AS t(key, codes, requirement)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.event_department_requirements r
       WHERE r.booking_id = b.id AND upper(r.department_key) = dept.key
    ) THEN
      INSERT INTO public.event_department_requirements (
        organization_id, branch_id, booking_id, department_id, department_key,
        requirement, detail, required_by, readiness
      )
      VALUES (
        b.organization_id, b.branch_id, b.id,
        (SELECT d.id FROM public.departments d
          WHERE d.organization_id = b.organization_id
            AND upper(coalesce(d.code,'')) = ANY (dept.codes)
            AND (d.branch_id = b.branch_id OR d.branch_id IS NULL)
          ORDER BY (d.branch_id = b.branch_id) DESC LIMIT 1),
        dept.key, dept.requirement,
        'Guests: ' || coalesce(o.guaranteed_guests,0) || '. Setup from ' || to_char(o.setup_at, 'DD Mon HH24:MI') || '.',
        o.start_at, 'not-started'
      );
      created_reqs := created_reqs + 1;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.beo_department_acknowledgments a
       JOIN public.departments d ON d.id = a.department_id
       WHERE a.beo_id = _beo AND upper(coalesce(d.code,'')) = ANY (dept.codes)
    ) THEN
      INSERT INTO public.beo_department_acknowledgments (organization_id, beo_id, department_id, notes)
      SELECT b.organization_id, _beo, d.id, dept.requirement
        FROM public.departments d
       WHERE d.organization_id = b.organization_id
         AND upper(coalesce(d.code,'')) = ANY (dept.codes)
         AND (d.branch_id = b.branch_id OR d.branch_id IS NULL)
       ORDER BY (d.branch_id = b.branch_id) DESC LIMIT 1;
      created_acks := created_acks + coalesce((SELECT 1), 0);
    END IF;
  END LOOP;

  -- Housekeeping job for the venue turnaround.
  SELECT d.id INTO hk_dept FROM public.departments d
   WHERE d.organization_id = b.organization_id AND upper(coalesce(d.code,'')) = 'HOUS'
     AND (d.branch_id = b.branch_id OR d.branch_id IS NULL)
   ORDER BY (d.branch_id = b.branch_id) DESC LIMIT 1;

  SELECT id INTO hk_job FROM public.housekeeping_jobs
   WHERE organization_id = b.organization_id AND idempotency_key = 'beo:' || _beo::text;
  IF hk_job IS NULL THEN
    INSERT INTO public.housekeeping_jobs (
      organization_id, branch_id, job_type, location_label, department_id,
      priority, status, due_at, inspection_required, inspection_status,
      notes, source, source_record_id, idempotency_key, created_by
    ) VALUES (
      b.organization_id, b.branch_id, 'event-preparation',
      coalesce(nullif(b.event_name,''), b.event_reference), hk_dept,
      'high', 'pending', o.setup_at, true, 'pending',
      'Prepare the venue for ' || coalesce(nullif(b.event_name,''), b.event_reference)
        || ' (' || coalesce(o.guaranteed_guests,0) || ' guests, ' || o.beo_number || ').',
      'events', b.id, 'beo:' || _beo::text, auth.uid()
    )
    RETURNING id INTO hk_job;
  END IF;

  -- Billing handoff.
  BEGIN
    PERFORM public.neo_event_billing_build(b.id);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  SELECT count(*) INTO billing_items FROM public.event_billing_items WHERE booking_id = b.id;

  PERFORM public.neo_notify_event(
    b.organization_id, auth.uid(), b.branch_id, 'events.beo.published', b.id,
    jsonb_build_object('event', b.event_name, 'reference', b.event_reference, 'beo', o.beo_number),
    'beo-published:' || _beo::text
  );

  RETURN jsonb_build_object(
    'beo_id', _beo,
    'booking_id', b.id,
    'requirements_created', created_reqs,
    'acknowledgements_created', created_acks,
    'housekeeping_job_id', hk_job,
    'billing_items', billing_items
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.neo_event_chain_status(_branch uuid DEFAULT NULL)
RETURNS TABLE (
  booking_id uuid,
  event_reference text,
  event_name text,
  branch_id uuid,
  event_date date,
  status text,
  beo_id uuid,
  beo_number text,
  beo_status text,
  kitchen_handoff boolean,
  housekeeping_handoff boolean,
  front_office_handoff boolean,
  housekeeping_job boolean,
  billing_items int,
  billed_amount numeric,
  paid_amount numeric,
  missing text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH scoped AS (
    SELECT b.*
      FROM public.event_bookings b
     WHERE b.organization_id = public.current_org_id()
       AND (_branch IS NULL OR b.branch_id = _branch)
       AND (public.current_access_scope() = 'all' OR b.branch_id = ANY (public.current_branch_ids()))
  ), rows AS (
    SELECT
      b.id, b.event_reference, b.event_name, b.branch_id, b.event_date, b.status,
      o.id AS beo_id, o.beo_number, o.status AS beo_status,
      EXISTS (SELECT 1 FROM public.event_department_requirements r WHERE r.booking_id = b.id AND upper(r.department_key) IN ('KITC','REST','FNB','KITCHEN')) AS kitchen_handoff,
      EXISTS (SELECT 1 FROM public.event_department_requirements r WHERE r.booking_id = b.id AND upper(r.department_key) = 'HOUS') AS housekeeping_handoff,
      EXISTS (SELECT 1 FROM public.event_department_requirements r WHERE r.booking_id = b.id AND upper(r.department_key) = 'FRON') AS front_office_handoff,
      EXISTS (SELECT 1 FROM public.housekeeping_jobs j WHERE j.source_record_id = b.id AND j.source = 'events') AS housekeeping_job,
      (SELECT count(*)::int FROM public.event_billing_items i WHERE i.booking_id = b.id) AS billing_items,
      coalesce((SELECT sum(i.line_total) FROM public.event_billing_items i WHERE i.booking_id = b.id), 0) AS billed_amount,
      coalesce((SELECT sum(p.amount) FROM public.event_payments p WHERE p.booking_id = b.id), 0) AS paid_amount
    FROM scoped b
    LEFT JOIN LATERAL (
      SELECT * FROM public.banquet_event_orders x
       WHERE x.booking_id = b.id AND x.status <> 'superseded'
       ORDER BY x.revision DESC LIMIT 1
    ) o ON true
  )
  SELECT r.id, r.event_reference, r.event_name, r.branch_id, r.event_date, r.status,
         r.beo_id, r.beo_number, r.beo_status,
         r.kitchen_handoff, r.housekeeping_handoff, r.front_office_handoff,
         r.housekeeping_job, r.billing_items, r.billed_amount, r.paid_amount,
         (ARRAY_REMOVE(ARRAY[
            CASE WHEN r.beo_id IS NULL THEN 'Banquet event order' END,
            CASE WHEN r.beo_id IS NOT NULL AND r.beo_status <> 'published' THEN 'Banquet order not published' END,
            CASE WHEN NOT r.kitchen_handoff THEN 'Kitchen handoff' END,
            CASE WHEN NOT r.housekeeping_handoff THEN 'Housekeeping handoff' END,
            CASE WHEN NOT r.front_office_handoff THEN 'Front office handoff' END,
            CASE WHEN NOT r.housekeeping_job THEN 'Venue preparation job' END,
            CASE WHEN r.billing_items = 0 THEN 'Billing' END,
            CASE WHEN r.billing_items > 0 AND r.paid_amount <= 0 THEN 'Payment' END
          ], NULL))::text[]
    FROM rows r
   ORDER BY r.event_date DESC;
$fn$;

REVOKE ALL ON FUNCTION public.neo_event_beo_ensure(uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.neo_event_beo_publish(uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.neo_event_chain_status(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_event_beo_ensure(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_event_beo_publish(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.neo_event_chain_status(uuid) TO authenticated, service_role;
