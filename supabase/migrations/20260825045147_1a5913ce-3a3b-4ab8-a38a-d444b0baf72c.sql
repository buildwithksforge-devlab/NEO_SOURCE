-- ============================================================
-- Maintenance & Landscaping department execution layer
-- ============================================================

CREATE OR REPLACE FUNCTION public.neo_maint_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- ---------------- landscaping schedules ----------------
CREATE TABLE IF NOT EXISTS public.landscaping_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT current_org_id(),
  branch_id uuid,
  name text NOT NULL,
  area_label text NOT NULL DEFAULT '',
  work_type text NOT NULL DEFAULT 'grounds',
  frequency text NOT NULL DEFAULT 'weekly',
  interval_days integer NOT NULL DEFAULT 7,
  next_due_date date NOT NULL DEFAULT current_date,
  instructions text NOT NULL DEFAULT '',
  assignee_user_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.landscaping_schedules TO authenticated;
GRANT ALL ON public.landscaping_schedules TO service_role;
ALTER TABLE public.landscaping_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS landscaping_schedules_read ON public.landscaping_schedules;
CREATE POLICY landscaping_schedules_read
  ON public.landscaping_schedules FOR SELECT TO authenticated
  USING (
    organization_id = current_org_id() AND is_active_staff()
    AND (assignee_user_id = auth.uid() OR has_permission('maintenance', 'landscaping', 'view'))
  );

DROP POLICY IF EXISTS landscaping_schedules_manage ON public.landscaping_schedules;
CREATE POLICY landscaping_schedules_manage
  ON public.landscaping_schedules FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('maintenance', 'landscaping', 'edit'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('maintenance', 'landscaping', 'edit'));

DROP TRIGGER IF EXISTS landscaping_schedules_touch ON public.landscaping_schedules;
CREATE TRIGGER landscaping_schedules_touch BEFORE UPDATE ON public.landscaping_schedules
  FOR EACH ROW EXECUTE FUNCTION public.neo_maint_touch_updated_at();

-- ---------------- grounds tasks ----------------
CREATE TABLE IF NOT EXISTS public.grounds_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT current_org_id(),
  branch_id uuid,
  schedule_id uuid REFERENCES public.landscaping_schedules(id) ON DELETE SET NULL,
  work_order_id uuid REFERENCES public.maintenance_work_orders(id) ON DELETE SET NULL,
  title text NOT NULL,
  area_label text NOT NULL DEFAULT '',
  instruction text NOT NULL DEFAULT '',
  priority text NOT NULL DEFAULT 'normal',
  due_at timestamptz,
  service_date date NOT NULL DEFAULT current_date,
  assignee_user_id uuid,
  status text NOT NULL DEFAULT 'not-started',
  blocker text NOT NULL DEFAULT '',
  completion_notes text NOT NULL DEFAULT '',
  started_at timestamptz,
  completed_at timestamptz,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS grounds_tasks_schedule_day_uniq
  ON public.grounds_tasks (schedule_id, service_date) WHERE schedule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS grounds_tasks_assignee_idx
  ON public.grounds_tasks (organization_id, assignee_user_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.grounds_tasks TO authenticated;
GRANT ALL ON public.grounds_tasks TO service_role;
ALTER TABLE public.grounds_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS grounds_tasks_read ON public.grounds_tasks;
CREATE POLICY grounds_tasks_read
  ON public.grounds_tasks FOR SELECT TO authenticated
  USING (
    organization_id = current_org_id() AND is_active_staff()
    AND (assignee_user_id = auth.uid() OR has_permission('maintenance', 'grounds', 'view'))
  );

DROP POLICY IF EXISTS grounds_tasks_manage ON public.grounds_tasks;
CREATE POLICY grounds_tasks_manage
  ON public.grounds_tasks FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('maintenance', 'grounds', 'edit'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('maintenance', 'grounds', 'edit'));

DROP TRIGGER IF EXISTS grounds_tasks_touch ON public.grounds_tasks;
CREATE TRIGGER grounds_tasks_touch BEFORE UPDATE ON public.grounds_tasks
  FOR EACH ROW EXECUTE FUNCTION public.neo_maint_touch_updated_at();

-- ---------------- forward-only progression ----------------
CREATE OR REPLACE FUNCTION public.neo_grounds_task_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old int; v_new int;
  v_rank constant text[] := ARRAY['not-started', 'in-progress', 'ready', 'completed'];
BEGIN
  IF NEW.status = 'blocked' OR OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  v_old := array_position(v_rank, OLD.status);
  v_new := array_position(v_rank, NEW.status);
  IF v_new IS NULL THEN
    RAISE EXCEPTION 'Unknown grounds task status %', NEW.status;
  END IF;
  IF v_old IS NOT NULL AND v_new < v_old AND NOT has_permission('maintenance', 'grounds', 'approve') THEN
    RAISE EXCEPTION 'Grounds task progress cannot be moved backwards';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS neo_grounds_task_guard_trg ON public.grounds_tasks;
CREATE TRIGGER neo_grounds_task_guard_trg BEFORE UPDATE ON public.grounds_tasks
  FOR EACH ROW EXECUTE FUNCTION public.neo_grounds_task_guard();

-- ------------------------------------------------------------
-- Save (create or update) a landscaping schedule
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_landscaping_schedule_save(
  _name text,
  _area text DEFAULT '',
  _frequency text DEFAULT 'weekly',
  _interval_days integer DEFAULT 7,
  _next_due date DEFAULT NULL,
  _instructions text DEFAULT '',
  _assignee uuid DEFAULT NULL,
  _branch uuid DEFAULT NULL,
  _id uuid DEFAULT NULL,
  _active boolean DEFAULT true
)
RETURNS public.landscaping_schedules
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.landscaping_schedules; v_branch uuid;
BEGIN
  IF NOT has_permission('maintenance', 'landscaping', 'edit') THEN
    RAISE EXCEPTION 'You are not permitted to manage landscaping schedules';
  END IF;
  IF coalesce(btrim(_name), '') = '' THEN
    RAISE EXCEPTION 'Give the schedule a name';
  END IF;
  IF coalesce(_interval_days, 0) <= 0 THEN
    RAISE EXCEPTION 'The interval must be at least one day';
  END IF;

  SELECT coalesce(_branch, p.branch_id) INTO v_branch FROM public.profiles p WHERE p.id = auth.uid();

  IF _id IS NULL THEN
    INSERT INTO public.landscaping_schedules (
      organization_id, branch_id, name, area_label, frequency, interval_days,
      next_due_date, instructions, assignee_user_id, active
    ) VALUES (
      current_org_id(), v_branch, btrim(_name), coalesce(_area, ''), coalesce(_frequency, 'weekly'),
      _interval_days, coalesce(_next_due, current_date), coalesce(_instructions, ''), _assignee,
      coalesce(_active, true)
    ) RETURNING * INTO v_row;
  ELSE
    UPDATE public.landscaping_schedules SET
      name = btrim(_name),
      area_label = coalesce(_area, area_label),
      frequency = coalesce(_frequency, frequency),
      interval_days = _interval_days,
      next_due_date = coalesce(_next_due, next_due_date),
      instructions = coalesce(_instructions, instructions),
      assignee_user_id = _assignee,
      active = coalesce(_active, active)
    WHERE id = _id AND organization_id = current_org_id()
    RETURNING * INTO v_row;
    IF v_row.id IS NULL THEN RAISE EXCEPTION 'Landscaping schedule not found'; END IF;
  END IF;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_landscaping_schedule_save(text, text, text, integer, date, text, uuid, uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_landscaping_schedule_save(text, text, text, integer, date, text, uuid, uuid, uuid, boolean) TO authenticated;

-- ------------------------------------------------------------
-- Turn everything due into a grounds task (idempotent per day)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_landscaping_generate_due()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_created int := 0; v_sched record;
BEGIN
  IF NOT has_permission('maintenance', 'landscaping', 'edit') THEN
    RAISE EXCEPTION 'You are not permitted to generate grounds work';
  END IF;

  FOR v_sched IN
    SELECT * FROM public.landscaping_schedules
     WHERE organization_id = current_org_id()
       AND active
       AND next_due_date <= current_date
     FOR UPDATE
  LOOP
    INSERT INTO public.grounds_tasks (
      organization_id, branch_id, schedule_id, title, area_label, instruction,
      priority, service_date, due_at, assignee_user_id
    ) VALUES (
      v_sched.organization_id, v_sched.branch_id, v_sched.id, v_sched.name, v_sched.area_label,
      v_sched.instructions, 'normal', v_sched.next_due_date,
      (v_sched.next_due_date + time '17:00')::timestamptz, v_sched.assignee_user_id
    )
    ON CONFLICT (schedule_id, service_date) DO NOTHING;

    IF FOUND THEN v_created := v_created + 1; END IF;

    UPDATE public.landscaping_schedules
       SET next_due_date = greatest(current_date + 1, v_sched.next_due_date + v_sched.interval_days)
     WHERE id = v_sched.id;
  END LOOP;

  RETURN jsonb_build_object('created', v_created);
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_landscaping_generate_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_landscaping_generate_due() TO authenticated;

-- ------------------------------------------------------------
-- Create a grounds task directly
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_grounds_task_create(
  _title text,
  _area text DEFAULT '',
  _instruction text DEFAULT '',
  _assignee uuid DEFAULT NULL,
  _priority text DEFAULT 'normal',
  _due timestamptz DEFAULT NULL,
  _branch uuid DEFAULT NULL
)
RETURNS public.grounds_tasks
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.grounds_tasks; v_branch uuid;
BEGIN
  IF NOT has_permission('maintenance', 'grounds', 'edit') THEN
    RAISE EXCEPTION 'You are not permitted to create grounds work';
  END IF;
  IF coalesce(btrim(_title), '') = '' THEN
    RAISE EXCEPTION 'Describe the grounds work';
  END IF;

  SELECT coalesce(_branch, p.branch_id) INTO v_branch FROM public.profiles p WHERE p.id = auth.uid();

  INSERT INTO public.grounds_tasks (
    organization_id, branch_id, title, area_label, instruction, priority, due_at, assignee_user_id
  ) VALUES (
    current_org_id(), v_branch, btrim(_title), coalesce(_area, ''), coalesce(_instruction, ''),
    coalesce(nullif(btrim(_priority), ''), 'normal'), _due, _assignee
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_grounds_task_create(text, text, text, uuid, text, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_grounds_task_create(text, text, text, uuid, text, timestamptz, uuid) TO authenticated;

-- ------------------------------------------------------------
-- Assign / reassign a grounds task
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_grounds_task_assign(_task uuid, _assignee uuid)
RETURNS public.grounds_tasks
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.grounds_tasks;
BEGIN
  IF NOT has_permission('maintenance', 'grounds', 'edit') THEN
    RAISE EXCEPTION 'You are not permitted to assign grounds work';
  END IF;
  UPDATE public.grounds_tasks SET assignee_user_id = _assignee
   WHERE id = _task AND organization_id = current_org_id()
  RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Grounds task not found'; END IF;
  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_grounds_task_assign(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_grounds_task_assign(uuid, uuid) TO authenticated;

-- ------------------------------------------------------------
-- Move a grounds task forward (assignee or supervisor)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_grounds_task_advance(
  _task uuid,
  _status text,
  _note text DEFAULT ''
)
RETURNS public.grounds_tasks
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.grounds_tasks;
BEGIN
  SELECT * INTO v_row FROM public.grounds_tasks
   WHERE id = _task AND organization_id = current_org_id() FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Grounds task not found'; END IF;

  IF v_row.assignee_user_id IS DISTINCT FROM auth.uid()
     AND NOT has_permission('maintenance', 'grounds', 'edit') THEN
    RAISE EXCEPTION 'Only the assigned ground worker or a supervisor can update this task';
  END IF;

  IF _status NOT IN ('not-started', 'in-progress', 'ready', 'completed', 'blocked') THEN
    RAISE EXCEPTION 'Unknown grounds task status %', _status;
  END IF;

  UPDATE public.grounds_tasks SET
    status = _status,
    blocker = CASE WHEN _status = 'blocked' THEN coalesce(nullif(btrim(_note), ''), blocker) ELSE '' END,
    completion_notes = CASE WHEN _status IN ('ready', 'completed')
                            THEN coalesce(nullif(btrim(_note), ''), completion_notes)
                            ELSE completion_notes END,
    started_at = CASE WHEN _status = 'in-progress' AND started_at IS NULL THEN now() ELSE started_at END,
    completed_at = CASE WHEN _status = 'completed' THEN now() ELSE completed_at END
  WHERE id = _task
  RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_grounds_task_advance(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_grounds_task_advance(uuid, text, text) TO authenticated;

-- ------------------------------------------------------------
-- Technician / officer progress on their own work order
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_maint_job_advance(
  _work_order uuid,
  _status text,
  _note text DEFAULT '',
  _diagnosis text DEFAULT ''
)
RETURNS public.maintenance_work_orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.maintenance_work_orders; v_is_supervisor boolean;
BEGIN
  SELECT * INTO v_row FROM public.maintenance_work_orders
   WHERE id = _work_order AND organization_id = current_org_id() FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Work order not found'; END IF;

  v_is_supervisor := has_permission('maintenance', 'overview', 'approve');

  IF v_row.assigned_to IS DISTINCT FROM auth.uid() AND NOT v_is_supervisor THEN
    RAISE EXCEPTION 'Only the assigned technician or a supervisor can update this job';
  END IF;

  IF _status NOT IN ('accepted', 'in-progress', 'on-hold', 'completed', 'verified', 'closed') THEN
    RAISE EXCEPTION 'Unknown work order status %', _status;
  END IF;

  IF _status IN ('verified', 'closed') AND NOT v_is_supervisor THEN
    RAISE EXCEPTION 'Only a maintenance supervisor can verify or close a job';
  END IF;

  IF _status IN ('verified', 'closed') AND v_row.assigned_to = auth.uid() AND NOT
     has_permission('maintenance', 'grounds', 'approve') THEN
    RAISE EXCEPTION 'You cannot verify your own work';
  END IF;

  UPDATE public.maintenance_work_orders SET
    status = _status,
    diagnosis = coalesce(nullif(btrim(_diagnosis), ''), diagnosis),
    completion_notes = CASE WHEN _status IN ('completed', 'verified', 'closed')
                            THEN coalesce(nullif(btrim(_note), ''), completion_notes)
                            ELSE completion_notes END,
    accepted_at = CASE WHEN _status = 'accepted' AND accepted_at IS NULL THEN now() ELSE accepted_at END,
    completed_at = CASE WHEN _status = 'completed' THEN now() ELSE completed_at END,
    verified_by = CASE WHEN _status = 'verified' THEN auth.uid() ELSE verified_by END,
    verified_at = CASE WHEN _status = 'verified' THEN now() ELSE verified_at END,
    closed_at = CASE WHEN _status = 'closed' THEN now() ELSE closed_at END,
    updated_at = now()
  WHERE id = _work_order
  RETURNING * INTO v_row;

  INSERT INTO public.work_order_status_history (organization_id, work_order_id, previous_status, new_status, reason, changed_by)
  VALUES (v_row.organization_id, _work_order, v_row.status, _status, nullif(btrim(_note), ''), auth.uid());

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_maint_job_advance(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_maint_job_advance(uuid, text, text, text) TO authenticated;

-- ------------------------------------------------------------
-- Record parts / materials used on a job
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_maint_record_parts(
  _work_order uuid,
  _description text,
  _quantity numeric DEFAULT 1,
  _unit text DEFAULT 'unit',
  _stock_item uuid DEFAULT NULL
)
RETURNS public.work_order_parts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.work_order_parts; v_wo public.maintenance_work_orders;
BEGIN
  SELECT * INTO v_wo FROM public.maintenance_work_orders
   WHERE id = _work_order AND organization_id = current_org_id();
  IF v_wo.id IS NULL THEN RAISE EXCEPTION 'Work order not found'; END IF;

  IF v_wo.assigned_to IS DISTINCT FROM auth.uid()
     AND NOT has_permission('maintenance', 'overview', 'edit') THEN
    RAISE EXCEPTION 'Only the assigned technician or a supervisor can record materials';
  END IF;
  IF coalesce(btrim(_description), '') = '' THEN
    RAISE EXCEPTION 'Describe the material used';
  END IF;
  IF coalesce(_quantity, 0) <= 0 THEN
    RAISE EXCEPTION 'Quantity must be greater than zero';
  END IF;

  INSERT INTO public.work_order_parts (
    organization_id, work_order_id, stock_item_id, description, quantity, unit, status, created_by
  ) VALUES (
    v_wo.organization_id, _work_order, _stock_item, btrim(_description), _quantity,
    coalesce(nullif(btrim(_unit), ''), 'unit'), 'used', auth.uid()
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_maint_record_parts(uuid, text, numeric, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_maint_record_parts(uuid, text, numeric, text, uuid) TO authenticated;

-- ------------------------------------------------------------
-- Role feature templates
-- ------------------------------------------------------------
DELETE FROM public.role_feature_templates
 WHERE module = 'maintenance'
   AND role_key IN ('maintenance-officer', 'maintenance-technician', 'grounds-worker');

INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT r.role_key, 'maintenance', f.feature, a.action
FROM (VALUES ('maintenance-officer'), ('maintenance-technician')) AS r(role_key)
CROSS JOIN (VALUES ('overview'), ('my-jobs'), ('supplies'), ('grounds')) AS f(feature)
CROSS JOIN (VALUES ('view'), ('create'), ('edit')) AS a(action)
WHERE NOT (f.feature = 'grounds' AND a.action <> 'view')
ON CONFLICT DO NOTHING;

INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'grounds-worker', 'maintenance', f.feature, a.action
FROM (VALUES ('my-tasks'), ('supplies')) AS f(feature)
CROSS JOIN (VALUES ('view'), ('create'), ('edit')) AS a(action)
ON CONFLICT DO NOTHING;
