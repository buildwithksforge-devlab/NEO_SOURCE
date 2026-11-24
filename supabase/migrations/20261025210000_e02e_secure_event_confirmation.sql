-- NEØ E2E: Secure the existing event confirmation engine.
-- Preserve venue reservations, milestones, tasks, BEO and notifications.
-- Depends on E2C collection verification.
-- Source only: deployment requires compatibility and financial validation.

CREATE OR REPLACE FUNCTION public.events_confirm_booking(_booking uuid, _override_reason text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b public.event_bookings; org uuid; created_tasks integer := 0; beo_id uuid; ms text[];
        dept record; s timestamptz; e timestamptz;
BEGIN
  org := public.current_org_id();

  IF auth.uid() IS NULL OR org IS NULL THEN
    RAISE EXCEPTION 'An authenticated Events workspace is required.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT (
    public.has_permission('events', 'confirm')
    OR public.is_org_admin()
  ) THEN
    RAISE EXCEPTION 'Event confirmation permission required.'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO b
    FROM public.event_bookings
   WHERE id = _booking
     AND organization_id = org
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event booking not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.neo_branch_in_scope(b.branch_id) THEN
    RAISE EXCEPTION 'Event property is outside your access scope.'
      USING ERRCODE = '42501';
  END IF;
  IF b.status IN ('confirmed','in-planning','ready','in-progress','completed','closed') THEN
    RETURN jsonb_build_object('already_confirmed', true, 'booking_id', b.id);
  END IF;

  IF b.status NOT IN (
    'provisional-hold',
    'awaiting-deposit'
  ) THEN
    RAISE EXCEPTION 'Booking cannot be confirmed from status %.',
      b.status USING ERRCODE = '22023';
  END IF;

  IF NULLIF(BTRIM(COALESCE(_override_reason, '')), '') IS NOT NULL THEN
    RAISE EXCEPTION
      'Deposit overrides are not supported. Record payment through Finance.'
      USING ERRCODE = '42501';
  END IF;

  IF public.neo_event_verified_collection_total(b.id)
       < GREATEST(COALESCE(b.deposit_required, 0), 0) THEN
    RAISE EXCEPTION
      'Insufficient event deposit. Required %, verified %.',
      b.deposit_required,
      public.neo_event_verified_collection_total(b.id)
      USING ERRCODE = '23514';
  END IF;
  s := COALESCE(b.setup_at, b.start_at);
  e := COALESCE(b.breakdown_at, b.end_at);

  IF b.venue_id IS NOT NULL THEN
    UPDATE public.venue_blocks SET status = 'confirmed'
      WHERE booking_id = b.id AND status <> 'released';
    IF NOT EXISTS (SELECT 1 FROM public.venue_blocks WHERE booking_id = b.id AND status <> 'released') THEN
      INSERT INTO public.venue_blocks (organization_id, branch_id, venue_id, booking_id, block_type, starts_at, ends_at, status, reason, override_reason, created_by)
      VALUES (org, b.branch_id, b.venue_id, b.id, 'event', s, e, 'confirmed', b.event_name, _override_reason, auth.uid());
    END IF;
  END IF;

  UPDATE public.event_bookings
     SET status = 'confirmed', confirmed_at = now(), confirmed_by = auth.uid(), updated_by = auth.uid()
   WHERE id = b.id;

  -- milestones
  ms := ARRAY['booking-confirmed','menu-selected','guest-count-confirmed','beo-issued','final-payment-due','setup-started','event-started','event-completed','feedback-requested','event-closed'];
  INSERT INTO public.event_milestones (organization_id, booking_id, key, label, due_at, sort_order)
  SELECT org, b.id, k, initcap(replace(k,'-',' ')),
         CASE k WHEN 'booking-confirmed' THEN now()
                WHEN 'guest-count-confirmed' THEN b.start_at - interval '3 days'
                WHEN 'beo-issued' THEN b.start_at - interval '5 days'
                WHEN 'final-payment-due' THEN b.start_at - interval '1 day'
                WHEN 'setup-started' THEN s
                WHEN 'event-started' THEN b.start_at
                WHEN 'event-completed' THEN b.end_at
                ELSE NULL END,
         ord
  FROM unnest(ms) WITH ORDINALITY AS x(k, ord)
  ON CONFLICT (booking_id, key) DO NOTHING;
  UPDATE public.event_milestones SET completed_at = now()
   WHERE booking_id = b.id AND key = 'booking-confirmed' AND completed_at IS NULL;

  -- department tasks (one per department that has a requirement, else skip)
  FOR dept IN
    SELECT DISTINCT r.department_id, r.requirement, r.required_by, r.id AS req_id
      FROM public.event_department_requirements r
     WHERE r.booking_id = b.id AND r.task_id IS NULL
  LOOP
    WITH t AS (
      INSERT INTO public.tasks (organization_id, branch_id, department_id, reference, title, description, due_at, priority, status, created_by)
      VALUES (org, b.branch_id, dept.department_id, public.next_document_number('task'),
              b.event_reference || ' â€” ' || dept.requirement,
              'Auto-generated from event ' || b.event_reference,
              COALESCE(dept.required_by, b.start_at), 'high', 'new', auth.uid())
      RETURNING id
    )
    UPDATE public.event_department_requirements SET task_id = (SELECT id FROM t) WHERE id = dept.req_id;
    created_tasks := created_tasks + 1;
  END LOOP;

  -- BEO draft
  SELECT id INTO beo_id FROM public.banquet_event_orders WHERE booking_id = b.id ORDER BY revision DESC LIMIT 1;
  IF beo_id IS NULL THEN
    INSERT INTO public.banquet_event_orders (organization_id, branch_id, booking_id, beo_number, revision,
      setup_at, guest_arrival_at, start_at, end_at, breakdown_at, guaranteed_guests, seating_layout, status, created_by)
    VALUES (org, b.branch_id, b.id, 'BEO-' || b.event_reference, 1, b.setup_at, b.start_at, b.start_at, b.end_at,
      b.breakdown_at, GREATEST(b.guaranteed_guests, b.expected_guests), b.seating_layout, 'draft', auth.uid())
    RETURNING id INTO beo_id;
  END IF;

  -- notifications to coordinator + org admins channel
  INSERT INTO public.notifications (organization_id, branch_id, user_id, category, title, body, link, priority)
  VALUES (org, b.branch_id, b.coordinator_id, 'operations',
          'Event confirmed: ' || b.event_reference,
          COALESCE(NULLIF(b.event_name,''),'Event') || ' is confirmed for ' || to_char(b.event_date,'DD Mon YYYY'),
          '/events/bookings', 'high');

  INSERT INTO public.event_activity_logs (organization_id, booking_id, action, detail, actor_id)
  VALUES (org, b.id, 'booking.confirmed', jsonb_build_object('tasks', created_tasks, 'beo_id', beo_id, 'override', _override_reason), auth.uid());

  RETURN jsonb_build_object('booking_id', b.id, 'tasks_created', created_tasks, 'beo_id', beo_id, 'already_confirmed', false);
END $$;

REVOKE ALL ON FUNCTION public.events_confirm_booking(uuid, text)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.events_confirm_booking(uuid, text)
TO authenticated;
