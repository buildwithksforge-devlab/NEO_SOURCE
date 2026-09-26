-- ============================================================
-- NEØ Main Kitchen department execution layer
-- ============================================================

CREATE TABLE IF NOT EXISTS public.kitchen_hygiene_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT public.current_org_id(),
  branch_id uuid,
  station_id uuid,
  check_type text NOT NULL DEFAULT 'hygiene',
  area text NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  status text NOT NULL DEFAULT 'submitted',
  completed_by uuid,
  completed_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.kitchen_hygiene_checks TO authenticated;
GRANT ALL ON public.kitchen_hygiene_checks TO service_role;
ALTER TABLE public.kitchen_hygiene_checks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "kitchen hygiene readable in scope" ON public.kitchen_hygiene_checks;
CREATE POLICY "kitchen hygiene readable in scope"
  ON public.kitchen_hygiene_checks FOR SELECT TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (
      completed_by = auth.uid()
      OR public.has_permission('kitchen', 'hygiene', 'view')
      OR public.has_permission('kitchen', 'quality', 'view')
    )
  );

DROP POLICY IF EXISTS "kitchen hygiene reviewable" ON public.kitchen_hygiene_checks;
CREATE POLICY "kitchen hygiene reviewable"
  ON public.kitchen_hygiene_checks FOR UPDATE TO authenticated
  USING (organization_id = public.current_org_id() AND public.has_permission('kitchen', 'quality', 'edit'))
  WITH CHECK (organization_id = public.current_org_id());

CREATE TABLE IF NOT EXISTS public.kitchen_breakages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT public.current_org_id(),
  branch_id uuid,
  station_id uuid,
  item text NOT NULL,
  quantity numeric NOT NULL DEFAULT 1,
  unit text NOT NULL DEFAULT 'piece',
  estimated_cost numeric,
  reason text,
  status text NOT NULL DEFAULT 'reported',
  reported_by uuid,
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.kitchen_breakages TO authenticated;
GRANT ALL ON public.kitchen_breakages TO service_role;
ALTER TABLE public.kitchen_breakages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "kitchen breakages readable in scope" ON public.kitchen_breakages;
CREATE POLICY "kitchen breakages readable in scope"
  ON public.kitchen_breakages FOR SELECT TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (
      reported_by = auth.uid()
      OR public.has_permission('kitchen', 'waste', 'view')
      OR public.has_permission('kitchen', 'stewarding', 'view')
    )
  );

DROP TRIGGER IF EXISTS set_kitchen_hygiene_updated_at ON public.kitchen_hygiene_checks;
CREATE TRIGGER set_kitchen_hygiene_updated_at
  BEFORE UPDATE ON public.kitchen_hygiene_checks
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS set_kitchen_breakages_updated_at ON public.kitchen_breakages;
CREATE TRIGGER set_kitchen_breakages_updated_at
  BEFORE UPDATE ON public.kitchen_breakages
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE INDEX IF NOT EXISTS kitchen_hygiene_org_branch_idx ON public.kitchen_hygiene_checks (organization_id, branch_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS kitchen_breakages_org_branch_idx ON public.kitchen_breakages (organization_id, branch_id, created_at DESC);

-- ============================================================
-- A chef's own assigned work — no bill, no payment, no guest money
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_kitchen_my_work(_branch uuid DEFAULT NULL)
RETURNS TABLE(
  item_id uuid, ticket_id uuid, ticket_number text, ticket_status text, item_status text,
  station_id uuid, station_name text, menu_item text, quantity numeric, modifiers text,
  allergy_alert text, dietary_notes text, special_instructions text, course text,
  target_minutes integer, table_code text, order_type text, received_at timestamptz,
  started_at timestamptz, ready_at timestamptz, age_minutes integer
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT
    sti.id,
    t.id,
    t.ticket_number,
    t.status,
    sti.status,
    t.station_id,
    s.name,
    oi.item_name,
    oi.quantity,
    (SELECT string_agg(m.option_name, ', ') FROM public.pos_order_item_modifiers m WHERE m.order_item_id = oi.id),
    coalesce(oi.allergy_note, o.allergy_alert),
    o.dietary_notes,
    oi.special_instructions,
    t.course,
    COALESCE(t.target_minutes, 15),
    rt.code,
    o.order_type,
    COALESCE(t.received_at, t.created_at),
    sti.started_at,
    sti.ready_at,
    GREATEST(0, (EXTRACT(EPOCH FROM (now() - COALESCE(t.received_at, t.created_at))) / 60)::int)
  FROM public.station_ticket_items sti
  JOIN public.station_tickets t ON t.id = sti.ticket_id
  LEFT JOIN public.operational_stations s ON s.id = t.station_id
  LEFT JOIN public.pos_order_items oi ON oi.id = sti.order_item_id
  LEFT JOIN public.pos_orders o ON o.id = t.order_id
  LEFT JOIN public.restaurant_tables rt ON rt.id = o.table_id
  WHERE t.organization_id = current_org_id()
    AND (_branch IS NULL OR t.branch_id = _branch)
    AND (sti.chef_id = auth.uid() OR t.assigned_chef_id = auth.uid())
    AND COALESCE(sti.status, 'new') NOT IN ('served', 'cancelled', 'completed')
    AND public.has_permission('kitchen', 'my-station', 'view')
  ORDER BY COALESCE(t.received_at, t.created_at) ASC
  LIMIT 200;
$$;

REVOKE EXECUTE ON FUNCTION public.neo_kitchen_my_work(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_my_work(uuid) TO authenticated;

-- ============================================================
-- Supervisor / Head Chef assigns a chef to a ticket or an item
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_kitchen_assign_chef(_ticket uuid, _chef uuid, _item uuid DEFAULT NULL, _reason text DEFAULT NULL)
RETURNS public.station_tickets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_row public.station_tickets;
BEGIN
  IF NOT public.has_permission('kitchen', 'production', 'edit') THEN
    RAISE EXCEPTION 'You are not permitted to assign kitchen work';
  END IF;

  SELECT * INTO v_row FROM public.station_tickets WHERE id = _ticket AND organization_id = current_org_id();
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Kitchen order not found'; END IF;

  IF _item IS NULL THEN
    UPDATE public.station_tickets SET assigned_chef_id = _chef, updated_at = now()
    WHERE id = _ticket RETURNING * INTO v_row;
    UPDATE public.station_ticket_items SET chef_id = _chef, updated_at = now()
    WHERE ticket_id = _ticket AND COALESCE(status, 'new') NOT IN ('served', 'cancelled', 'completed');
  ELSE
    UPDATE public.station_ticket_items SET chef_id = _chef, updated_at = now()
    WHERE id = _item AND ticket_id = _ticket;
  END IF;

  INSERT INTO public.ticket_assignments (
    organization_id, branch_id, ticket_id, ticket_item_id, station_id, chef_id, assigned_by, method, reason
  ) VALUES (
    current_org_id(), v_row.branch_id, _ticket, _item, v_row.station_id, _chef, auth.uid(), 'manual', nullif(btrim(_reason), '')
  );

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_kitchen_assign_chef(uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_assign_chef(uuid, uuid, uuid, text) TO authenticated;

-- ============================================================
-- Stewarding tasks — created by supervisor/head chef, worked by the steward
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_kitchen_task_create(
  _title text, _assignee uuid DEFAULT NULL, _description text DEFAULT NULL,
  _priority text DEFAULT 'normal', _due timestamptz DEFAULT NULL, _branch uuid DEFAULT NULL
)
RETURNS public.tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_row public.tasks; v_branch uuid; v_dept uuid;
BEGIN
  IF NOT public.has_permission('kitchen', 'stewarding', 'edit') THEN
    RAISE EXCEPTION 'You are not permitted to assign kitchen tasks';
  END IF;
  IF coalesce(btrim(_title), '') = '' THEN RAISE EXCEPTION 'Describe the task'; END IF;

  SELECT coalesce(_branch, p.branch_id), p.department_id INTO v_branch, v_dept
  FROM public.profiles p WHERE p.id = auth.uid();

  INSERT INTO public.tasks (
    organization_id, branch_id, department_id, title, description, assignee_id, created_by, due_at, priority, status
  ) VALUES (
    current_org_id(), v_branch, v_dept, btrim(_title), nullif(btrim(_description), ''), _assignee, auth.uid(),
    _due, coalesce(nullif(btrim(_priority), ''), 'normal'), 'open'
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_kitchen_task_create(text, uuid, text, text, timestamptz, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_task_create(text, uuid, text, text, timestamptz, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_kitchen_task_advance(_task uuid, _status text, _note text DEFAULT NULL)
RETURNS public.tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_row public.tasks;
BEGIN
  SELECT * INTO v_row FROM public.tasks WHERE id = _task AND organization_id = current_org_id();
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Task not found'; END IF;

  IF v_row.assignee_id IS DISTINCT FROM auth.uid()
     AND NOT public.has_permission('kitchen', 'stewarding', 'edit') THEN
    RAISE EXCEPTION 'You can only update a task assigned to you';
  END IF;

  IF _status NOT IN ('in-progress', 'completed') THEN
    RAISE EXCEPTION 'A kitchen task moves to in-progress and then completed';
  END IF;
  IF v_row.status = 'completed' THEN
    RAISE EXCEPTION 'This task is already completed';
  END IF;
  IF _status = 'completed' AND v_row.status NOT IN ('in-progress') THEN
    RAISE EXCEPTION 'Start the task before completing it';
  END IF;

  UPDATE public.tasks
     SET status = _status,
         progress = CASE WHEN _status = 'completed' THEN 100 ELSE 50 END,
         completed_at = CASE WHEN _status = 'completed' THEN now() ELSE NULL END,
         description = CASE WHEN nullif(btrim(_note), '') IS NULL THEN description
                            ELSE coalesce(description || E'\n', '') || btrim(_note) END,
         updated_at = now()
   WHERE id = _task
  RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_kitchen_task_advance(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_task_advance(uuid, text, text) TO authenticated;

-- ============================================================
-- Hygiene and sanitation checklists
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_kitchen_hygiene_submit(
  _area text, _check_type text DEFAULT 'hygiene', _items jsonb DEFAULT '[]'::jsonb,
  _notes text DEFAULT NULL, _station uuid DEFAULT NULL, _branch uuid DEFAULT NULL
)
RETURNS public.kitchen_hygiene_checks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_row public.kitchen_hygiene_checks; v_branch uuid;
BEGIN
  IF NOT public.has_permission('kitchen', 'hygiene', 'create') THEN
    RAISE EXCEPTION 'You are not permitted to submit kitchen hygiene checks';
  END IF;
  IF coalesce(btrim(_area), '') = '' THEN RAISE EXCEPTION 'Name the area you checked'; END IF;
  IF _check_type NOT IN ('hygiene', 'sanitation', 'cleaning') THEN
    RAISE EXCEPTION 'Unknown checklist type';
  END IF;

  SELECT coalesce(_branch, p.branch_id) INTO v_branch FROM public.profiles p WHERE p.id = auth.uid();

  INSERT INTO public.kitchen_hygiene_checks (
    organization_id, branch_id, station_id, check_type, area, items, notes, completed_by
  ) VALUES (
    current_org_id(), v_branch, _station, _check_type, btrim(_area),
    coalesce(_items, '[]'::jsonb), nullif(btrim(_notes), ''), auth.uid()
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_kitchen_hygiene_submit(text, text, jsonb, text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_hygiene_submit(text, text, jsonb, text, uuid, uuid) TO authenticated;

-- ============================================================
-- Breakages
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_kitchen_breakage_record(
  _item text, _quantity numeric DEFAULT 1, _unit text DEFAULT 'piece',
  _estimated_cost numeric DEFAULT NULL, _reason text DEFAULT NULL,
  _station uuid DEFAULT NULL, _branch uuid DEFAULT NULL
)
RETURNS public.kitchen_breakages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_row public.kitchen_breakages; v_branch uuid;
BEGIN
  IF NOT public.has_permission('kitchen', 'stewarding', 'create')
     AND NOT public.has_permission('kitchen', 'waste', 'create') THEN
    RAISE EXCEPTION 'You are not permitted to record a kitchen breakage';
  END IF;
  IF coalesce(btrim(_item), '') = '' THEN RAISE EXCEPTION 'Name what was broken'; END IF;
  IF coalesce(_quantity, 0) <= 0 THEN RAISE EXCEPTION 'Quantity must be greater than zero'; END IF;

  SELECT coalesce(_branch, p.branch_id) INTO v_branch FROM public.profiles p WHERE p.id = auth.uid();

  INSERT INTO public.kitchen_breakages (
    organization_id, branch_id, station_id, item, quantity, unit, estimated_cost, reason, reported_by
  ) VALUES (
    current_org_id(), v_branch, _station, btrim(_item), _quantity,
    coalesce(nullif(btrim(_unit), ''), 'piece'), _estimated_cost, nullif(btrim(_reason), ''), auth.uid()
  ) RETURNING * INTO v_row;

  INSERT INTO public.notifications (organization_id, branch_id, category, title, body, link)
  VALUES (current_org_id(), v_branch, 'operations', 'Kitchen breakage reported',
          btrim(_item) || ' — ' || _quantity::text || ' ' || coalesce(_unit, 'piece'),
          '/kitchen/stewarding');

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_kitchen_breakage_record(text, numeric, text, numeric, text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_breakage_record(text, numeric, text, numeric, text, uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_kitchen_breakage_review(_breakage uuid, _decision text, _notes text DEFAULT NULL)
RETURNS public.kitchen_breakages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_row public.kitchen_breakages;
BEGIN
  IF NOT public.has_permission('kitchen', 'waste', 'edit') THEN
    RAISE EXCEPTION 'You are not permitted to review kitchen breakages';
  END IF;
  IF _decision NOT IN ('acknowledged', 'written-off', 'rejected') THEN
    RAISE EXCEPTION 'Unknown decision';
  END IF;

  SELECT * INTO v_row FROM public.kitchen_breakages WHERE id = _breakage AND organization_id = current_org_id();
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Breakage record not found'; END IF;
  IF v_row.reported_by = auth.uid() THEN
    RAISE EXCEPTION 'You cannot review a breakage you reported yourself';
  END IF;

  UPDATE public.kitchen_breakages
     SET status = _decision, reviewed_by = auth.uid(), reviewed_at = now(),
         review_notes = nullif(btrim(_notes), ''), updated_at = now()
   WHERE id = _breakage
  RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_kitchen_breakage_review(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_breakage_review(uuid, text, text) TO authenticated;

-- ============================================================
-- Head Chef alone turns reported kitchen needs into one Stores requisition
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_kitchen_requisition_from_needs(
  _needs uuid[], _required_date date DEFAULT NULL, _priority text DEFAULT 'normal', _reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_lines jsonb; v_req jsonb; v_branch uuid; v_dept uuid; v_id uuid;
BEGIN
  IF NOT public.has_permission('kitchen', 'requisition', 'create') THEN
    RAISE EXCEPTION 'Only the Kitchen Manager / Head Chef can send a Stores requisition for the Main Kitchen';
  END IF;
  IF _needs IS NULL OR array_length(_needs, 1) IS NULL THEN
    RAISE EXCEPTION 'Select at least one reported need';
  END IF;

  SELECT jsonb_agg(jsonb_build_object('item_name', n.item, 'quantity', n.quantity, 'unit', n.unit, 'notes', n.notes)),
         min(n.branch_id), min(n.department_id)
    INTO v_lines, v_branch, v_dept
  FROM public.department_stock_needs n
  WHERE n.id = ANY(_needs)
    AND n.organization_id = current_org_id()
    AND n.module = 'kitchen'
    AND n.status IN ('reported', 'acknowledged');

  IF v_lines IS NULL THEN RAISE EXCEPTION 'No open kitchen needs match that selection'; END IF;

  v_req := to_jsonb(public.neo_department_requisition_create(
    v_branch, v_lines, v_dept, _required_date,
    coalesce(nullif(btrim(_priority), ''), 'normal'),
    coalesce(nullif(btrim(_reason), ''), 'Main Kitchen consolidated requisition'),
    NULL
  ));

  v_id := nullif(v_req->>'id', '')::uuid;

  UPDATE public.department_stock_needs
     SET status = 'requisitioned', reviewed_by = auth.uid(), reviewed_at = now(),
         requisition_id = v_id, updated_at = now()
   WHERE id = ANY(_needs) AND organization_id = current_org_id() AND module = 'kitchen';

  RETURN v_req;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_kitchen_requisition_from_needs(uuid[], date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_kitchen_requisition_from_needs(uuid[], date, text, text) TO authenticated;

-- ============================================================
-- Role access — the department contract, expressed as permissions
-- ============================================================

-- Hot Kitchen Chef: own station work, recipes, report a need, report waste
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'hot-kitchen-chef', 'kitchen', f, a
FROM (VALUES ('my-station'), ('needs')) v(f)
CROSS JOIN (VALUES ('view'), ('create'), ('edit')) w(a)
ON CONFLICT DO NOTHING;

INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'hot-kitchen-chef', 'kitchen', 'waste', a FROM (VALUES ('view'), ('create')) w(a)
ON CONFLICT DO NOTHING;

-- Hot Kitchen Supervisor: coordinates production, stewarding and consolidates needs
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'hot-kitchen-supervisor', 'kitchen', f, a
FROM (VALUES ('my-station'), ('needs'), ('stewarding'), ('waste'), ('quality'), ('hygiene')) v(f)
CROSS JOIN (VALUES ('view'), ('create'), ('edit')) w(a)
ON CONFLICT DO NOTHING;

-- Kitchen Steward: own tasks, checklists, breakages and stock needs only
DELETE FROM public.role_feature_templates
 WHERE role_key = 'kitchen-steward' AND module = 'kitchen' AND feature IN ('queue', 'waste');

INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'kitchen-steward', 'kitchen', f, a
FROM (VALUES ('stewarding'), ('hygiene'), ('needs')) v(f)
CROSS JOIN (VALUES ('view'), ('create')) w(a)
ON CONFLICT DO NOTHING;

-- Head Chef already holds kitchen.* which covers requisition, stewarding and hygiene.
SELECT public.neo_apply_feature_templates(o.id) FROM public.organizations o;
