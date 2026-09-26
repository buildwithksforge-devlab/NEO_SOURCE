-- ============================================================
-- Sales, Events & Banqueting: assignments, tasks, issue reports
-- ============================================================

CREATE OR REPLACE FUNCTION public.neo_events_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- ---------------- assignments ----------------
CREATE TABLE IF NOT EXISTS public.event_staff_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT current_org_id(),
  branch_id uuid,
  booking_id uuid NOT NULL REFERENCES public.event_bookings(id) ON DELETE CASCADE,
  staff_user_id uuid NOT NULL,
  station text NOT NULL DEFAULT '',
  duties text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'assigned',
  assigned_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, staff_user_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_staff_assignments TO authenticated;
GRANT ALL ON public.event_staff_assignments TO service_role;
ALTER TABLE public.event_staff_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS event_staff_assignments_read ON public.event_staff_assignments;
CREATE POLICY event_staff_assignments_read
  ON public.event_staff_assignments FOR SELECT TO authenticated
  USING (
    organization_id = current_org_id() AND is_active_staff()
    AND (staff_user_id = auth.uid() OR has_permission('events', 'banqueting', 'view'))
  );

DROP POLICY IF EXISTS event_staff_assignments_write ON public.event_staff_assignments;
CREATE POLICY event_staff_assignments_write
  ON public.event_staff_assignments FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('events', 'banqueting', 'edit'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('events', 'banqueting', 'edit'));

CREATE INDEX IF NOT EXISTS event_staff_assignments_staff_idx
  ON public.event_staff_assignments (organization_id, staff_user_id);

DROP TRIGGER IF EXISTS event_staff_assignments_touch ON public.event_staff_assignments;
CREATE TRIGGER event_staff_assignments_touch BEFORE UPDATE ON public.event_staff_assignments
  FOR EACH ROW EXECUTE FUNCTION public.neo_events_touch_updated_at();

-- ---------------- banqueting tasks ----------------
CREATE TABLE IF NOT EXISTS public.event_banquet_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT current_org_id(),
  branch_id uuid,
  booking_id uuid NOT NULL REFERENCES public.event_bookings(id) ON DELETE CASCADE,
  assignee_user_id uuid,
  title text NOT NULL,
  instruction text NOT NULL DEFAULT '',
  station text NOT NULL DEFAULT '',
  due_at timestamptz,
  sequence integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'not-started',
  blocker text NOT NULL DEFAULT '',
  started_at timestamptz,
  completed_at timestamptz,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_banquet_tasks TO authenticated;
GRANT ALL ON public.event_banquet_tasks TO service_role;
ALTER TABLE public.event_banquet_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS event_banquet_tasks_read ON public.event_banquet_tasks;
CREATE POLICY event_banquet_tasks_read
  ON public.event_banquet_tasks FOR SELECT TO authenticated
  USING (
    organization_id = current_org_id() AND is_active_staff()
    AND (assignee_user_id = auth.uid() OR has_permission('events', 'banqueting', 'view'))
  );

DROP POLICY IF EXISTS event_banquet_tasks_manage ON public.event_banquet_tasks;
CREATE POLICY event_banquet_tasks_manage
  ON public.event_banquet_tasks FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('events', 'banqueting', 'edit'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('events', 'banqueting', 'edit'));

CREATE INDEX IF NOT EXISTS event_banquet_tasks_assignee_idx
  ON public.event_banquet_tasks (organization_id, assignee_user_id, status);

DROP TRIGGER IF EXISTS event_banquet_tasks_touch ON public.event_banquet_tasks;
CREATE TRIGGER event_banquet_tasks_touch BEFORE UPDATE ON public.event_banquet_tasks
  FOR EACH ROW EXECUTE FUNCTION public.neo_events_touch_updated_at();

-- ---------------- issue reports ----------------
CREATE TABLE IF NOT EXISTS public.event_issue_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT current_org_id(),
  branch_id uuid,
  booking_id uuid REFERENCES public.event_bookings(id) ON DELETE SET NULL,
  task_id uuid REFERENCES public.event_banquet_tasks(id) ON DELETE SET NULL,
  category text NOT NULL DEFAULT 'other',
  detail text NOT NULL,
  route_to text NOT NULL DEFAULT 'events',
  status text NOT NULL DEFAULT 'open',
  resolution text NOT NULL DEFAULT '',
  reported_by uuid NOT NULL DEFAULT auth.uid(),
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.event_issue_reports TO authenticated;
GRANT ALL ON public.event_issue_reports TO service_role;
ALTER TABLE public.event_issue_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS event_issue_reports_read ON public.event_issue_reports;
CREATE POLICY event_issue_reports_read
  ON public.event_issue_reports FOR SELECT TO authenticated
  USING (
    organization_id = current_org_id() AND is_active_staff()
    AND (reported_by = auth.uid() OR has_permission('events', 'banqueting', 'view'))
  );

DROP POLICY IF EXISTS event_issue_reports_insert ON public.event_issue_reports;
CREATE POLICY event_issue_reports_insert
  ON public.event_issue_reports FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = current_org_id() AND is_active_staff() AND reported_by = auth.uid()
  );

DROP POLICY IF EXISTS event_issue_reports_resolve ON public.event_issue_reports;
CREATE POLICY event_issue_reports_resolve
  ON public.event_issue_reports FOR UPDATE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('events', 'banqueting', 'edit'))
  WITH CHECK (organization_id = current_org_id());

DROP TRIGGER IF EXISTS event_issue_reports_touch ON public.event_issue_reports;
CREATE TRIGGER event_issue_reports_touch BEFORE UPDATE ON public.event_issue_reports
  FOR EACH ROW EXECUTE FUNCTION public.neo_events_touch_updated_at();

-- ------------------------------------------------------------
-- Forward-only task progression
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_event_task_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old int;
  v_new int;
  v_rank constant text[] := ARRAY['not-started', 'in-progress', 'ready', 'completed'];
BEGIN
  IF NEW.status = 'blocked' OR OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  v_old := array_position(v_rank, OLD.status);
  v_new := array_position(v_rank, NEW.status);
  IF v_new IS NULL THEN
    RAISE EXCEPTION 'Unknown banqueting task status %', NEW.status;
  END IF;
  IF v_old IS NOT NULL AND v_new < v_old AND NOT has_permission('events', 'banqueting', 'edit') THEN
    RAISE EXCEPTION 'Banqueting task progress cannot be moved backwards';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS neo_event_task_guard_trg ON public.event_banquet_tasks;
CREATE TRIGGER neo_event_task_guard_trg BEFORE UPDATE ON public.event_banquet_tasks
  FOR EACH ROW EXECUTE FUNCTION public.neo_event_task_guard();

-- ------------------------------------------------------------
-- Assign banqueting staff to an event
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_event_assign_staff(
  _booking uuid,
  _staff uuid,
  _station text DEFAULT '',
  _duties text DEFAULT ''
)
RETURNS public.event_staff_assignments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.event_staff_assignments;
  v_branch uuid;
BEGIN
  IF NOT has_permission('events', 'banqueting', 'edit') THEN
    RAISE EXCEPTION 'You are not permitted to assign banqueting staff';
  END IF;

  SELECT branch_id INTO v_branch FROM public.event_bookings
   WHERE id = _booking AND organization_id = current_org_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event booking not found';
  END IF;

  INSERT INTO public.event_staff_assignments (organization_id, branch_id, booking_id, staff_user_id, station, duties)
  VALUES (current_org_id(), v_branch, _booking, _staff, COALESCE(_station, ''), COALESCE(_duties, ''))
  ON CONFLICT (booking_id, staff_user_id) DO UPDATE
    SET station = EXCLUDED.station, duties = EXCLUDED.duties, status = 'assigned'
  RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_event_assign_staff(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_event_assign_staff(uuid, uuid, text, text) TO authenticated;

-- ------------------------------------------------------------
-- Create a banqueting task
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_event_task_create(
  _booking uuid,
  _title text,
  _assignee uuid DEFAULT NULL,
  _instruction text DEFAULT '',
  _station text DEFAULT '',
  _due timestamptz DEFAULT NULL
)
RETURNS public.event_banquet_tasks
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.event_banquet_tasks;
  v_branch uuid;
BEGIN
  IF NOT has_permission('events', 'banqueting', 'edit') THEN
    RAISE EXCEPTION 'You are not permitted to create banqueting tasks';
  END IF;
  IF coalesce(btrim(_title), '') = '' THEN
    RAISE EXCEPTION 'A task title is required';
  END IF;

  SELECT branch_id INTO v_branch FROM public.event_bookings
   WHERE id = _booking AND organization_id = current_org_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event booking not found';
  END IF;

  IF _assignee IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.event_staff_assignments
     WHERE booking_id = _booking AND staff_user_id = _assignee AND organization_id = current_org_id()
  ) THEN
    RAISE EXCEPTION 'Assign the staff member to this event before giving them a task';
  END IF;

  INSERT INTO public.event_banquet_tasks
    (organization_id, branch_id, booking_id, assignee_user_id, title, instruction, station, due_at, sequence)
  VALUES (
    current_org_id(), v_branch, _booking, _assignee, btrim(_title),
    COALESCE(_instruction, ''), COALESCE(_station, ''), _due,
    COALESCE((SELECT max(sequence) + 1 FROM public.event_banquet_tasks WHERE booking_id = _booking), 1)
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_event_task_create(uuid, text, uuid, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_event_task_create(uuid, text, uuid, text, text, timestamptz) TO authenticated;

-- ------------------------------------------------------------
-- Advance a banqueting task (assignee or manager)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_event_task_advance(
  _task uuid,
  _status text,
  _blocker text DEFAULT ''
)
RETURNS public.event_banquet_tasks
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.event_banquet_tasks;
BEGIN
  SELECT * INTO v_row FROM public.event_banquet_tasks
   WHERE id = _task AND organization_id = current_org_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Banqueting task not found';
  END IF;

  IF v_row.assignee_user_id IS DISTINCT FROM auth.uid()
     AND NOT has_permission('events', 'banqueting', 'edit') THEN
    RAISE EXCEPTION 'Only the assigned staff member or the Sales & Events Manager can update this task';
  END IF;

  IF _status NOT IN ('not-started', 'in-progress', 'ready', 'completed', 'blocked') THEN
    RAISE EXCEPTION 'Unknown banqueting task status %', _status;
  END IF;

  UPDATE public.event_banquet_tasks
     SET status = _status,
         blocker = CASE WHEN _status = 'blocked' THEN COALESCE(_blocker, '') ELSE '' END,
         started_at = CASE WHEN _status = 'in-progress' AND started_at IS NULL THEN now() ELSE started_at END,
         completed_at = CASE WHEN _status = 'completed' THEN now() ELSE NULL END
   WHERE id = _task
  RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_event_task_advance(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_event_task_advance(uuid, text, text) TO authenticated;

-- ------------------------------------------------------------
-- Report an event issue (any assigned staff member)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_event_issue_report(
  _booking uuid,
  _category text,
  _detail text,
  _task uuid DEFAULT NULL
)
RETURNS public.event_issue_reports
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.event_issue_reports;
  v_branch uuid;
  v_route text;
BEGIN
  IF NOT is_active_staff() THEN
    RAISE EXCEPTION 'Only active staff can report an event issue';
  END IF;
  IF coalesce(btrim(_detail), '') = '' THEN
    RAISE EXCEPTION 'Describe the issue before reporting it';
  END IF;

  SELECT branch_id INTO v_branch FROM public.event_bookings
   WHERE id = _booking AND organization_id = current_org_id();

  IF _booking IS NOT NULL AND v_branch IS NULL AND NOT FOUND THEN
    RAISE EXCEPTION 'Event booking not found';
  END IF;

  IF _booking IS NOT NULL
     AND NOT has_permission('events', 'banqueting', 'edit')
     AND NOT EXISTS (
       SELECT 1 FROM public.event_staff_assignments
        WHERE booking_id = _booking AND staff_user_id = auth.uid() AND organization_id = current_org_id()
     ) THEN
    RAISE EXCEPTION 'You can only report issues for events you are assigned to';
  END IF;

  v_route := CASE lower(COALESCE(_category, 'other'))
    WHEN 'maintenance' THEN 'maintenance'
    WHEN 'damaged-equipment' THEN 'maintenance'
    WHEN 'missing-equipment' THEN 'stores'
    WHEN 'missing-setup-item' THEN 'stores'
    WHEN 'stock-shortage' THEN 'stores'
    WHEN 'safety' THEN 'security'
    WHEN 'guest-service' THEN 'events'
    WHEN 'event-delay' THEN 'events'
    ELSE 'events'
  END;

  INSERT INTO public.event_issue_reports
    (organization_id, branch_id, booking_id, task_id, category, detail, route_to)
  VALUES (current_org_id(), v_branch, _booking, _task, lower(COALESCE(_category, 'other')), btrim(_detail), v_route)
  RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_event_issue_report(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_event_issue_report(uuid, text, text, uuid) TO authenticated;

-- ------------------------------------------------------------
-- Resolve an event issue (manager only, never your own report
-- unless you also hold the approval authority)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_event_issue_resolve(
  _issue uuid,
  _status text,
  _resolution text DEFAULT ''
)
RETURNS public.event_issue_reports
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.event_issue_reports;
BEGIN
  IF NOT has_permission('events', 'banqueting', 'edit') THEN
    RAISE EXCEPTION 'You are not permitted to action event issues';
  END IF;
  IF _status NOT IN ('open', 'acknowledged', 'resolved', 'closed') THEN
    RAISE EXCEPTION 'Unknown issue status %', _status;
  END IF;

  SELECT * INTO v_row FROM public.event_issue_reports
   WHERE id = _issue AND organization_id = current_org_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Issue not found';
  END IF;

  UPDATE public.event_issue_reports
     SET status = _status,
         resolution = COALESCE(_resolution, ''),
         resolved_by = CASE WHEN _status IN ('resolved', 'closed') THEN auth.uid() ELSE NULL END,
         resolved_at = CASE WHEN _status IN ('resolved', 'closed') THEN now() ELSE NULL END
   WHERE id = _issue
  RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_event_issue_resolve(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_event_issue_resolve(uuid, text, text) TO authenticated;