-- =========================================================
-- NEØ Events repair — part 3: corrective contract
-- Composite tenant idempotency, server-only numbering,
-- full dependency property enforcement, feature-level
-- write authorisation and rollup redaction.
-- =========================================================

-- ---------- 1. Composite tenant idempotency ----------
ALTER TABLE public.event_booking_idempotency
  DROP CONSTRAINT IF EXISTS event_booking_idempotency_pkey;
ALTER TABLE public.event_booking_idempotency
  ADD CONSTRAINT event_booking_idempotency_pkey PRIMARY KEY (organization_id, key);

-- ---------- 2. Numbering uniqueness (tenant / property / reference) ----------
CREATE UNIQUE INDEX IF NOT EXISTS event_bookings_org_branch_reference_key
  ON public.event_bookings (organization_id, branch_id, event_reference);

-- ---------- 3. Parent scope helpers ----------
CREATE OR REPLACE FUNCTION public.neo_event_scope_booking(_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.event_bookings b
                 WHERE b.id = _id AND b.organization_id = public.current_org_id()
                   AND public.neo_branch_in_scope(b.branch_id));
$$;

CREATE OR REPLACE FUNCTION public.neo_event_scope_enquiry(_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.event_enquiries e
                 WHERE e.id = _id AND e.organization_id = public.current_org_id()
                   AND public.neo_branch_in_scope(e.branch_id));
$$;

CREATE OR REPLACE FUNCTION public.neo_event_scope_quotation(_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.event_quotations q
                 WHERE q.id = _id AND q.organization_id = public.current_org_id()
                   AND public.neo_branch_in_scope(q.branch_id));
$$;

CREATE OR REPLACE FUNCTION public.neo_event_scope_package(_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.event_packages p
                 WHERE p.id = _id AND p.organization_id = public.current_org_id()
                   AND public.neo_branch_in_scope(p.branch_id));
$$;

CREATE OR REPLACE FUNCTION public.neo_event_scope_menu(_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.event_menus m
                 WHERE m.id = _id AND m.organization_id = public.current_org_id()
                   AND public.neo_event_scope_booking(m.booking_id));
$$;

CREATE OR REPLACE FUNCTION public.neo_event_scope_resource(_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.event_resources r
                 WHERE r.id = _id AND r.organization_id = public.current_org_id()
                   AND public.neo_branch_in_scope(r.branch_id));
$$;

DO $g$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['neo_event_scope_booking','neo_event_scope_enquiry','neo_event_scope_quotation',
                           'neo_event_scope_package','neo_event_scope_menu','neo_event_scope_resource'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(uuid) FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(uuid) TO authenticated, service_role', f);
  END LOOP;
END
$g$;

-- ---------- 4. Dependency guards ----------
DO $t$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['event_room_blocks'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS tg_neo_event_child_branch ON public.%I', t);
    EXECUTE format('CREATE TRIGGER tg_neo_event_child_branch BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.neo_event_child_branch_inherit()', t);
  END LOOP;
END
$t$;

CREATE OR REPLACE FUNCTION public.neo_event_booking_dependency_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
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
$$;

DO $t$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['event_requirements','event_menus','event_milestones','event_vendors',
                           'event_change_requests','event_guest_counts'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS tg_neo_event_dependency ON public.%I', t);
    EXECUTE format('CREATE TRIGGER tg_neo_event_dependency BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.neo_event_booking_dependency_guard()', t);
  END LOOP;
END
$t$;

CREATE OR REPLACE FUNCTION public.neo_event_reservation_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
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
$$;

DROP TRIGGER IF EXISTS tg_neo_event_reservation_guard ON public.event_resource_reservations;
CREATE TRIGGER tg_neo_event_reservation_guard
  BEFORE INSERT OR UPDATE ON public.event_resource_reservations
  FOR EACH ROW EXECUTE FUNCTION public.neo_event_reservation_guard();

CREATE OR REPLACE FUNCTION public.neo_event_grandchild_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
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
$$;

DO $t$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['event_menu_items','event_quotation_items','event_package_items'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS tg_neo_event_grandchild ON public.%I', t);
    EXECUTE format('CREATE TRIGGER tg_neo_event_grandchild BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.neo_event_grandchild_guard()', t);
  END LOOP;
END
$t$;

CREATE OR REPLACE FUNCTION public.neo_event_trace_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_booking_org uuid; v_enquiry_org uuid; v_org uuid;
BEGIN
  IF NEW.booking_id IS NULL AND NEW.enquiry_id IS NULL THEN
    RAISE EXCEPTION 'This record must reference an event or an enquiry.' USING ERRCODE = '23514';
  END IF;
  IF NEW.booking_id IS NOT NULL THEN
    SELECT organization_id INTO v_booking_org FROM public.event_bookings WHERE id = NEW.booking_id;
    IF v_booking_org IS NULL THEN
      RAISE EXCEPTION 'The referenced event does not exist.' USING ERRCODE = '23503';
    END IF;
  END IF;
  IF NEW.enquiry_id IS NOT NULL THEN
    SELECT organization_id INTO v_enquiry_org FROM public.event_enquiries WHERE id = NEW.enquiry_id;
    IF v_enquiry_org IS NULL THEN
      RAISE EXCEPTION 'The referenced enquiry does not exist.' USING ERRCODE = '23503';
    END IF;
  END IF;
  IF v_booking_org IS NOT NULL AND v_enquiry_org IS NOT NULL AND v_booking_org <> v_enquiry_org THEN
    RAISE EXCEPTION 'The event and the enquiry belong to different organisations.' USING ERRCODE = '23514';
  END IF;
  v_org := coalesce(v_booking_org, v_enquiry_org);
  IF NEW.organization_id IS NULL THEN
    NEW.organization_id := v_org;
  ELSIF NEW.organization_id <> v_org THEN
    RAISE EXCEPTION 'This record belongs to a different organisation than its event.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DO $t$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['event_documents','event_activity_logs'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS tg_neo_event_trace ON public.%I', t);
    EXECUTE format('CREATE TRIGGER tg_neo_event_trace BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.neo_event_trace_guard()', t);
  END LOOP;
END
$t$;

-- ---------- 5. Property-scoped RLS with feature-level authorisation ----------
DO $rls$
DECLARE
  r record;
  p record;
  spec jsonb := '[
    {"t":"event_bookings","scope":"organization_id = public.current_org_id() AND public.neo_branch_in_scope(branch_id)","view":"bookings.view","create":"bookings.create","edit":"bookings.edit"},
    {"t":"event_enquiries","scope":"organization_id = public.current_org_id() AND public.neo_branch_in_scope(branch_id)","view":"enquiries.view","create":"enquiries.create","edit":"enquiries.edit"},
    {"t":"event_quotations","scope":"organization_id = public.current_org_id() AND public.neo_branch_in_scope(branch_id)","view":"quotations.view","create":"quotations.create","edit":"quotations.edit"},
    {"t":"event_venues","scope":"organization_id = public.current_org_id() AND public.neo_branch_in_scope(branch_id)","view":"venues.view","create":"venues.create","edit":"venues.edit"},
    {"t":"event_resources","scope":"organization_id = public.current_org_id() AND public.neo_branch_in_scope(branch_id)","view":"resources.view","create":"resources.create","edit":"resources.edit"},
    {"t":"event_packages","scope":"organization_id = public.current_org_id() AND public.neo_branch_in_scope(branch_id)","view":"packages.view","create":"packages.create","edit":"packages.edit"},
    {"t":"site_visits","scope":"organization_id = public.current_org_id() AND public.neo_branch_in_scope(branch_id)","view":"site-visits.view","create":"site-visits.create","edit":"site-visits.edit"},
    {"t":"venue_blocks","scope":"organization_id = public.current_org_id() AND public.neo_branch_in_scope(branch_id)","view":"venues.view","create":"venues.edit","edit":"venues.edit"},
    {"t":"event_room_blocks","scope":"organization_id = public.current_org_id() AND public.neo_event_scope_booking(booking_id)","view":"bookings.view","create":"bookings.edit","edit":"bookings.edit"},
    {"t":"event_billing_items","scope":"organization_id = public.current_org_id() AND public.neo_event_scope_booking(booking_id)","view":"billing.view","create":"billing.create","edit":"billing.edit"},
    {"t":"event_department_requirements","scope":"organization_id = public.current_org_id() AND public.neo_event_scope_booking(booking_id)","view":"readiness.view","create":"readiness.create","edit":"readiness.edit"},
    {"t":"event_requirements","scope":"organization_id = public.current_org_id() AND public.neo_event_scope_booking(booking_id)","view":"readiness.view","create":"readiness.create","edit":"readiness.edit"},
    {"t":"banquet_event_orders","scope":"organization_id = public.current_org_id() AND public.neo_event_scope_booking(booking_id)","view":"bookings.view","create":"bookings.edit","edit":"bookings.edit"},
    {"t":"event_feedback","scope":"organization_id = public.current_org_id() AND public.neo_event_scope_booking(booking_id)","view":"feedback.view","create":"feedback.create","edit":"feedback.edit"},
    {"t":"event_menus","scope":"organization_id = public.current_org_id() AND public.neo_event_scope_booking(booking_id)","view":"bookings.view","create":"bookings.edit","edit":"bookings.edit"},
    {"t":"event_milestones","scope":"organization_id = public.current_org_id() AND public.neo_event_scope_booking(booking_id)","view":"bookings.view","create":"bookings.edit","edit":"bookings.edit"},
    {"t":"event_vendors","scope":"organization_id = public.current_org_id() AND public.neo_event_scope_booking(booking_id)","view":"bookings.view","create":"bookings.edit","edit":"bookings.edit"},
    {"t":"event_change_requests","scope":"organization_id = public.current_org_id() AND public.neo_event_scope_booking(booking_id)","view":"bookings.view","create":"bookings.edit","edit":"bookings.edit"},
    {"t":"event_guest_counts","scope":"organization_id = public.current_org_id() AND public.neo_event_scope_booking(booking_id)","view":"bookings.view","create":"bookings.edit","edit":"bookings.edit"},
    {"t":"event_resource_reservations","scope":"organization_id = public.current_org_id() AND (public.neo_event_scope_booking(booking_id) OR (booking_id IS NULL AND public.neo_event_scope_resource(resource_id)))","view":"resources.view","create":"resources.edit","edit":"resources.edit"},
    {"t":"event_menu_items","scope":"organization_id = public.current_org_id() AND public.neo_event_scope_menu(event_menu_id)","view":"bookings.view","create":"bookings.edit","edit":"bookings.edit"},
    {"t":"event_quotation_items","scope":"organization_id = public.current_org_id() AND public.neo_event_scope_quotation(quotation_id)","view":"quotations.view","create":"quotations.create","edit":"quotations.edit"},
    {"t":"event_package_items","scope":"organization_id = public.current_org_id() AND public.neo_event_scope_package(package_id)","view":"packages.view","create":"packages.create","edit":"packages.edit"},
    {"t":"event_documents","scope":"organization_id = public.current_org_id() AND (public.neo_event_scope_booking(booking_id) OR public.neo_event_scope_enquiry(enquiry_id))","view":"bookings.view","create":"bookings.edit","edit":"bookings.edit"},
    {"t":"event_activity_logs","scope":"organization_id = public.current_org_id() AND (public.neo_event_scope_booking(booking_id) OR public.neo_event_scope_enquiry(enquiry_id))","view":"bookings.view","create":"bookings.view","edit":"bookings.edit"}
  ]'::jsonb;
  v_feature text;
  v_action text;
  v_scope text;
  v_tbl text;
BEGIN
  FOR r IN SELECT * FROM jsonb_array_elements(spec) AS e(v) LOOP
    v_tbl := r.v->>'t';
    v_scope := r.v->>'scope';

    FOR p IN SELECT policyname FROM pg_policies
             WHERE schemaname = 'public' AND tablename = v_tbl
               AND (policyname ILIKE '%staff read' OR policyname ILIKE '%staff write' OR policyname ILIKE '%staff update') LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, v_tbl);
    END LOOP;

    v_feature := split_part(r.v->>'view', '.', 1);
    v_action := split_part(r.v->>'view', '.', 2);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s AND public.has_permission(%L, %L, %L))',
      v_tbl || ' staff read', v_tbl, v_scope, 'events', v_feature, v_action);

    v_feature := split_part(r.v->>'create', '.', 1);
    v_action := split_part(r.v->>'create', '.', 2);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (%s AND public.has_permission(%L, %L, %L))',
      v_tbl || ' staff write', v_tbl, v_scope, 'events', v_feature, v_action);

    v_feature := split_part(r.v->>'edit', '.', 1);
    v_action := split_part(r.v->>'edit', '.', 2);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (%s AND public.has_permission(%L, %L, %L)) WITH CHECK (%s AND public.has_permission(%L, %L, %L))',
      v_tbl || ' staff update', v_tbl, v_scope, 'events', v_feature, v_action, v_scope, 'events', v_feature, v_action);
  END LOOP;
END
$rls$;

DROP POLICY IF EXISTS "event_types staff read" ON public.event_types;
CREATE POLICY "event_types staff read" ON public.event_types
  FOR SELECT TO authenticated USING (organization_id = public.current_org_id());

-- ---------- 6. Server-only numbering and validation on creation ----------
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
  v_type uuid := nullif(_payload->>'event_type_id', '')::uuid;
  v_customer uuid := nullif(_payload->>'customer_id', '')::uuid;
  v_corporate uuid := nullif(_payload->>'corporate_account_id', '')::uuid;
  v_coordinator uuid := nullif(_payload->>'coordinator_id', '')::uuid;
  v_name text := nullif(btrim(coalesce(_payload->>'event_name', '')), '');
  v_date date := nullif(_payload->>'event_date', '')::date;
  v_start timestamptz := nullif(_payload->>'start_at', '')::timestamptz;
  v_end timestamptz := nullif(_payload->>'end_at', '')::timestamptz;
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

  IF v_idem IS NOT NULL THEN
    SELECT booking_id INTO v_existing FROM public.event_booking_idempotency
    WHERE key = v_idem AND organization_id = v_org;
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object('booking_id', v_existing, 'created', false);
    END IF;
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

  IF v_idem IS NOT NULL THEN
    INSERT INTO public.event_booking_idempotency (key, organization_id, booking_id)
    VALUES (v_idem, v_org, v_id) ON CONFLICT (organization_id, key) DO NOTHING;
  END IF;

  INSERT INTO public.event_activity_logs (organization_id, booking_id, enquiry_id, action, detail, actor_id)
  VALUES (v_org, v_id, v_enquiry, 'events.booking.created',
          jsonb_build_object('event_reference', v_ref, 'branch_id', v_branch, 'source',
                             coalesce(nullif(_payload->>'source', ''), 'manual')),
          auth.uid());

  RETURN jsonb_build_object('booking_id', v_id, 'event_reference', v_ref, 'created', true);
END
$$;

-- ---------- 7. Transfer moves every dependency ----------
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
          jsonb_build_object('event_reference', v_ref, 'from_branch_id', v_old, 'to_branch_id', _branch,
                             'reason', _reason,
                             'venue_released', v_venue_released,
                             'venue_blocks_released', v_blocks_released,
                             'resource_reservations_released', v_resources_released,
                             'room_blocks_released', v_rooms_released),
          auth.uid());

  RETURN jsonb_build_object('booking_id', _booking, 'moved', true, 'from_branch_id', v_old, 'to_branch_id', _branch,
                            'venue_released', v_venue_released,
                            'venue_blocks_released', v_blocks_released,
                            'resource_reservations_released', v_resources_released,
                            'room_blocks_released', v_rooms_released);
END
$$;

-- ---------- 8. Rollup redaction in the workspace read model ----------
CREATE OR REPLACE FUNCTION public.neo_event_workspace(_branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS TABLE (
  booking_id uuid, event_reference text, event_name text, status text, payment_status text,
  event_date date, start_at timestamptz, end_at timestamptz, setup_at timestamptz, breakdown_at timestamptz,
  branch_id uuid, branch_name text, venue_id uuid, venue_name text, customer_id uuid, customer_name text,
  corporate_account_id uuid, event_type_id uuid, event_type_name text, coordinator_id uuid,
  quotation_id uuid, quotation_number text, enquiry_id uuid, enquiry_number text,
  expected_guests integer, guaranteed_guests integer, final_guests integer,
  total_amount numeric, paid_amount numeric, balance_due numeric, deposit_required numeric, deposit_paid numeric,
  readiness_total integer, readiness_ready integer, readiness_blocked integer,
  billing_items integer, billing_total numeric,
  resource_reservations integer, feedback_responses integer, feedback_avg numeric,
  beo_status text, created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
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
$$;

-- ---------- 9. Thin billing projection ----------
CREATE OR REPLACE FUNCTION public.neo_event_billing(_branch uuid DEFAULT NULL, _from date DEFAULT NULL, _to date DEFAULT NULL)
RETURNS TABLE (
  booking_id uuid, event_reference text, event_name text, status text, payment_status text,
  event_date date, branch_id uuid, branch_name text, customer_name text,
  total_amount numeric, paid_amount numeric, balance_due numeric,
  deposit_required numeric, deposit_paid numeric, billing_items integer, billing_total numeric
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
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
$$;

REVOKE ALL ON FUNCTION public.neo_event_billing(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_event_billing(uuid, date, date) TO authenticated, service_role;