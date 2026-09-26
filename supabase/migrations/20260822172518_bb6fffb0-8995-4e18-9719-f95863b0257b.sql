
-- =========================================================
-- NEØ Events repair — part 1: property assignment & scoping
-- =========================================================

-- ---------- 1. Idempotency ledger for event creation ----------
CREATE TABLE IF NOT EXISTS public.event_booking_idempotency (
  key text PRIMARY KEY,
  organization_id uuid NOT NULL,
  booking_id uuid NOT NULL REFERENCES public.event_bookings(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.event_booking_idempotency TO authenticated;
GRANT ALL ON public.event_booking_idempotency TO service_role;
ALTER TABLE public.event_booking_idempotency ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "event_booking_idempotency staff read" ON public.event_booking_idempotency;
CREATE POLICY "event_booking_idempotency staff read" ON public.event_booking_idempotency
  FOR SELECT TO authenticated USING (organization_id = public.current_org_id());

-- ---------- 2. Transactional backfill: Zawadi -> Nairobi ----------
DO $backfill$
DECLARE
  v_org uuid := 'f8cf89cf-3523-4ca4-a1fb-886802b32d19';
  v_branch uuid := 'ebec27a4-8842-4342-a1b1-f33caed67090';
  v_booking record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = v_branch AND organization_id = v_org) THEN
    RAISE NOTICE 'Nairobi branch not found for Zawadi org — backfill skipped';
    RETURN;
  END IF;

  UPDATE public.event_venues      SET branch_id = v_branch WHERE organization_id = v_org AND branch_id IS NULL;
  UPDATE public.event_enquiries   SET branch_id = v_branch WHERE organization_id = v_org AND branch_id IS NULL;
  UPDATE public.event_quotations  SET branch_id = v_branch WHERE organization_id = v_org AND branch_id IS NULL;
  UPDATE public.site_visits       SET branch_id = v_branch WHERE organization_id = v_org AND branch_id IS NULL;
  UPDATE public.event_resources   SET branch_id = v_branch WHERE organization_id = v_org AND branch_id IS NULL;
  UPDATE public.venue_blocks      SET branch_id = v_branch WHERE organization_id = v_org AND branch_id IS NULL;
  UPDATE public.event_bookings    SET branch_id = v_branch WHERE organization_id = v_org AND branch_id IS NULL;

  UPDATE public.event_billing_items c SET branch_id = b.branch_id
    FROM public.event_bookings b WHERE b.id = c.booking_id AND c.branch_id IS DISTINCT FROM b.branch_id AND b.organization_id = v_org;
  UPDATE public.event_department_requirements c SET branch_id = b.branch_id
    FROM public.event_bookings b WHERE b.id = c.booking_id AND c.branch_id IS DISTINCT FROM b.branch_id AND b.organization_id = v_org;
  UPDATE public.banquet_event_orders c SET branch_id = b.branch_id
    FROM public.event_bookings b WHERE b.id = c.booking_id AND c.branch_id IS DISTINCT FROM b.branch_id AND b.organization_id = v_org;
  UPDATE public.event_feedback c SET branch_id = b.branch_id
    FROM public.event_bookings b WHERE b.id = c.booking_id AND c.branch_id IS DISTINCT FROM b.branch_id AND b.organization_id = v_org;

  FOR v_booking IN SELECT id, event_reference FROM public.event_bookings WHERE organization_id = v_org LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.event_activity_logs
      WHERE booking_id = v_booking.id AND action = 'events.booking.property-backfill'
    ) THEN
      INSERT INTO public.event_activity_logs (organization_id, booking_id, action, detail)
      VALUES (v_org, v_booking.id,
              'events.booking.property-backfill',
              jsonb_build_object(
                'event_reference', v_booking.event_reference,
                'assigned_branch_id', v_branch,
                'note', 'Assigned to the Nairobi property during the Events property repair. Identifiers, amounts, statuses, references and dates were preserved.'));
    END IF;
  END LOOP;
END
$backfill$;

-- ---------- 3. Property guards on event_bookings ----------
CREATE OR REPLACE FUNCTION public.neo_event_booking_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v_venue_branch uuid;
BEGIN
  IF NEW.branch_id IS NULL THEN
    RAISE EXCEPTION 'An event must be assigned to a property. Choose a property before saving.'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = NEW.branch_id AND b.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'The selected property does not belong to this organisation.' USING ERRCODE = '23514';
  END IF;

  IF NEW.venue_id IS NOT NULL THEN
    SELECT branch_id INTO v_venue_branch FROM public.event_venues WHERE id = NEW.venue_id;
    IF v_venue_branch IS NOT NULL AND v_venue_branch <> NEW.branch_id THEN
      RAISE EXCEPTION 'The selected venue belongs to a different property.' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.branch_id IS NOT NULL AND NEW.branch_id <> OLD.branch_id
     AND coalesce(current_setting('neo.event_transfer', true), '') <> 'on' THEN
    RAISE EXCEPTION 'An event cannot be moved between properties by an ordinary edit. Use the authorised event transfer action.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS tg_neo_event_booking_guard ON public.event_bookings;
CREATE TRIGGER tg_neo_event_booking_guard
  BEFORE INSERT OR UPDATE ON public.event_bookings
  FOR EACH ROW EXECUTE FUNCTION public.neo_event_booking_guard();

-- ---------- 4. Child branch inheritance ----------
CREATE OR REPLACE FUNCTION public.neo_event_child_branch_inherit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v_branch uuid; v_org uuid;
BEGIN
  IF NEW.booking_id IS NULL THEN RETURN NEW; END IF;
  SELECT branch_id, organization_id INTO v_branch, v_org FROM public.event_bookings WHERE id = NEW.booking_id;
  IF v_branch IS NULL THEN
    RAISE EXCEPTION 'The parent event has no property assigned.' USING ERRCODE = '23514';
  END IF;
  IF NEW.organization_id IS NOT NULL AND NEW.organization_id <> v_org THEN
    RAISE EXCEPTION 'This record belongs to a different organisation than its event.' USING ERRCODE = '23514';
  END IF;
  IF NEW.branch_id IS NULL THEN
    NEW.branch_id := v_branch;
  ELSIF NEW.branch_id <> v_branch THEN
    RAISE EXCEPTION 'This record cannot belong to a different property than its event.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DO $t$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['event_billing_items','event_department_requirements','banquet_event_orders','event_feedback','venue_blocks'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS tg_neo_event_child_branch ON public.%I', t);
    EXECUTE format('CREATE TRIGGER tg_neo_event_child_branch BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.neo_event_child_branch_inherit()', t);
  END LOOP;
END
$t$;

-- ---------- 5. Property-scoped RLS ----------
DO $rls$
DECLARE
  t text; p record;
  branch_tables text[] := ARRAY['event_bookings','event_enquiries','event_quotations','event_venues','site_visits','venue_blocks','event_resources'];
  child_tables  text[] := ARRAY['event_billing_items','event_department_requirements','event_feedback','banquet_event_orders'];
BEGIN
  FOREACH t IN ARRAY branch_tables || child_tables LOOP
    FOR p IN SELECT policyname FROM pg_policies
             WHERE schemaname = 'public' AND tablename = t
               AND (policyname ILIKE '%staff%' OR policyname ILIKE '% write') LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
    END LOOP;
  END LOOP;

  FOREACH t IN ARRAY branch_tables LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (organization_id = public.current_org_id() AND public.neo_branch_in_scope(branch_id))', t || ' staff read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (organization_id = public.current_org_id() AND public.neo_branch_in_scope(branch_id))', t || ' staff write', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (organization_id = public.current_org_id() AND public.neo_branch_in_scope(branch_id)) WITH CHECK (organization_id = public.current_org_id() AND public.neo_branch_in_scope(branch_id))', t || ' staff update', t);
  END LOOP;

  FOREACH t IN ARRAY child_tables LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (organization_id = public.current_org_id() AND EXISTS (SELECT 1 FROM public.event_bookings b WHERE b.id = booking_id AND public.neo_branch_in_scope(b.branch_id)))', t || ' staff read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (organization_id = public.current_org_id() AND EXISTS (SELECT 1 FROM public.event_bookings b WHERE b.id = booking_id AND public.neo_branch_in_scope(b.branch_id)))', t || ' staff write', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (organization_id = public.current_org_id() AND EXISTS (SELECT 1 FROM public.event_bookings b WHERE b.id = booking_id AND public.neo_branch_in_scope(b.branch_id))) WITH CHECK (organization_id = public.current_org_id() AND EXISTS (SELECT 1 FROM public.event_bookings b WHERE b.id = booking_id AND public.neo_branch_in_scope(b.branch_id)))', t || ' staff update', t);
  END LOOP;
END
$rls$;

-- ---------- 6. Canonical capabilities ----------
INSERT INTO public.permissions (module, feature, action, label)
SELECT v.module, v.feature, v.action, v.label
FROM (VALUES
  ('events','bookings','confirm','Confirm events'),
  ('events','bookings','transfer','Transfer an event to another property'),
  ('events','enquiries','convert','Convert an enquiry into an event'),
  ('events','quotations','convert','Convert an accepted quotation into an event'),
  ('events','packages','view','View event packages'),
  ('events','packages','create','Create event packages'),
  ('events','packages','edit','Edit event packages'),
  ('events','feedback','view','View event feedback'),
  ('events','feedback','create','Record event feedback'),
  ('events','feedback','edit','Respond to event feedback'),
  ('events','reports','view','View event reports'),
  ('events','reports','export','Export event reports'),
  ('events','settings','view','View event settings'),
  ('events','settings','edit','Edit event settings')
) AS v(module, feature, action, label)
WHERE NOT EXISTS (
  SELECT 1 FROM public.permissions p
  WHERE p.module = v.module AND p.feature = v.feature AND p.action = v.action
);

-- Grant each new capability to the roles that already hold its closest sibling.
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT DISTINCT src.role_key, 'events', m.feature, m.action
FROM (VALUES
  ('bookings','confirm','bookings','edit'),
  ('enquiries','convert','enquiries','edit'),
  ('quotations','convert','quotations','edit'),
  ('packages','view','venues','view'),
  ('packages','create','venues','create'),
  ('packages','edit','venues','edit'),
  ('feedback','view','bookings','view'),
  ('feedback','create','bookings','edit'),
  ('feedback','edit','bookings','edit'),
  ('reports','view','overview','view'),
  ('reports','export','overview','export'),
  ('settings','view','venues','view'),
  ('settings','edit','venues','edit'),
  ('bookings','transfer','overview','approve')
) AS m(feature, action, src_feature, src_action)
JOIN public.role_feature_templates src
  ON src.module = 'events' AND src.feature = m.src_feature AND src.action = m.src_action
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_feature_templates x
  WHERE x.role_key = src.role_key AND x.module = 'events' AND x.feature = m.feature AND x.action = m.action
);
