-- NEØ Events E01/E02 handoff integrity
-- Generated from existing application migration contracts.
-- E01: return explicit billing failure warning from BEO publishing.
-- E02: prevent requisitioned status without a valid linked Stores requisition.
--
-- REVIEW BEFORE DATABASE DEPLOYMENT.
-- No live business data is changed by generating this file.
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
  billing_warning text := NULL;
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

  -- Billing handoff. Preserve operational publication,
  -- but never hide a failed financial handoff.
  BEGIN
    PERFORM public.neo_event_billing_build(b.id);
  EXCEPTION WHEN OTHERS THEN
    billing_warning := 'Event billing could not be completed. Finance must review this event. SQLSTATE: ' || SQLSTATE;
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
    'billing_items', billing_items,
    'billing_warning', billing_warning
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.neo_department_stock_need_review(
  _need uuid,
  _decision text,
  _notes text DEFAULT NULL,
  _requisition uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid := public.current_org_id(); _row public.department_stock_needs; _status text;
BEGIN
  SELECT * INTO _row FROM public.department_stock_needs
   WHERE id = _need AND organization_id = _org FOR UPDATE;
  IF _row.id IS NULL THEN RAISE EXCEPTION 'Stock need not found'; END IF;

  IF NOT public.has_permission(_row.module, 'requisitions', 'create') THEN
    RAISE EXCEPTION 'Not permitted to review stock needs for this department';
  END IF;

  _status := CASE lower(coalesce(_decision, ''))
    WHEN 'acknowledge' THEN 'acknowledged'
    WHEN 'acknowledged' THEN 'acknowledged'
    WHEN 'requisition' THEN 'requisitioned'
    WHEN 'requisitioned' THEN 'requisitioned'
    WHEN 'decline' THEN 'declined'
    WHEN 'declined' THEN 'declined'
    WHEN 'close' THEN 'closed'
    ELSE NULL END;
  IF _status IS NULL THEN RAISE EXCEPTION 'Unknown decision %', _decision; END IF;

  -- A need cannot become requisitioned without an actual
  -- Stores requisition belonging to the same workspace/property.
  IF _status = 'requisitioned' THEN

    IF COALESCE(_requisition, _row.requisition_id) IS NULL THEN
      RAISE EXCEPTION
        'Create a Stores requisition before marking this stock need requisitioned';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.internal_requisitions r
      WHERE r.id = COALESCE(_requisition, _row.requisition_id)
        AND r.organization_id = _org
        AND r.branch_id IS NOT DISTINCT FROM _row.branch_id
        AND (
          _row.department_id IS NULL
          OR r.department_id IS NOT DISTINCT FROM _row.department_id
        )
    ) THEN
      RAISE EXCEPTION
        'The linked requisition does not belong to this stock need''s workspace, property and department';
    END IF;

  END IF;
  UPDATE public.department_stock_needs
     SET status = _status,
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         review_notes = coalesce(nullif(btrim(_notes), ''), review_notes),
         requisition_id = coalesce(_requisition, requisition_id),
         updated_at = now()
   WHERE id = _need;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'stock_need.' || _status, _row.module, _need::text,
          jsonb_build_object('item', _row.item, 'status', _status), _notes);

  RETURN jsonb_build_object('id', _need, 'status', _status);
END;
$$;
