
-- 1. Grounds areas master ------------------------------------------------
CREATE TABLE IF NOT EXISTS public.grounds_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT public.current_org_id(),
  branch_id uuid REFERENCES public.branches(id),
  name text NOT NULL,
  code text,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.grounds_areas TO authenticated;
GRANT ALL ON public.grounds_areas TO service_role;

ALTER TABLE public.grounds_areas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS grounds_areas_read ON public.grounds_areas;
CREATE POLICY grounds_areas_read ON public.grounds_areas FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_active_staff());

DROP POLICY IF EXISTS grounds_areas_manage ON public.grounds_areas;
CREATE POLICY grounds_areas_manage ON public.grounds_areas FOR ALL TO authenticated
  USING (organization_id = public.current_org_id()
         AND (public.has_permission('maintenance','grounds','edit')
              OR public.has_permission('maintenance','landscaping','edit')
              OR public.is_org_admin_for(organization_id)))
  WITH CHECK (organization_id = public.current_org_id()
         AND (public.has_permission('maintenance','grounds','edit')
              OR public.has_permission('maintenance','landscaping','edit')
              OR public.is_org_admin_for(organization_id)));

CREATE UNIQUE INDEX IF NOT EXISTS grounds_areas_name_unique
  ON public.grounds_areas (organization_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)));

DROP TRIGGER IF EXISTS grounds_areas_touch ON public.grounds_areas;
CREATE TRIGGER grounds_areas_touch BEFORE UPDATE ON public.grounds_areas
  FOR EACH ROW EXECUTE FUNCTION public.neo_maint_touch_updated_at();

-- 2. Area + equipment on grounds work ------------------------------------
ALTER TABLE public.grounds_tasks
  ADD COLUMN IF NOT EXISTS area_id uuid REFERENCES public.grounds_areas(id),
  ADD COLUMN IF NOT EXISTS equipment_asset_id uuid REFERENCES public.assets(id);

ALTER TABLE public.landscaping_schedules
  ADD COLUMN IF NOT EXISTS area_id uuid REFERENCES public.grounds_areas(id),
  ADD COLUMN IF NOT EXISTS equipment_asset_id uuid REFERENCES public.assets(id);

CREATE OR REPLACE FUNCTION public.neo_grounds_task_create(
  _title text, _area text DEFAULT '', _instruction text DEFAULT '',
  _assignee uuid DEFAULT NULL, _priority text DEFAULT 'normal',
  _due timestamptz DEFAULT NULL, _branch uuid DEFAULT NULL,
  _area_id uuid DEFAULT NULL, _equipment uuid DEFAULT NULL)
RETURNS public.grounds_tasks
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.grounds_tasks; v_org uuid := current_org_id(); v_area text := btrim(coalesce(_area,''));
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No active organisation'; END IF;
  IF NOT has_permission('maintenance','grounds','edit') THEN
    RAISE EXCEPTION 'You are not permitted to create grounds work';
  END IF;
  IF coalesce(btrim(_title),'') = '' THEN RAISE EXCEPTION 'Describe the grounds work'; END IF;
  IF _branch IS NULL THEN RAISE EXCEPTION 'Select a property before creating grounds work'; END IF;

  IF _area_id IS NOT NULL THEN
    SELECT name INTO v_area FROM public.grounds_areas
     WHERE id = _area_id AND organization_id = v_org
       AND (branch_id IS NULL OR branch_id = _branch);
    IF v_area IS NULL THEN RAISE EXCEPTION 'That grounds area does not belong to this property'; END IF;
  END IF;

  IF _equipment IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM public.assets WHERE id = _equipment AND organization_id = v_org
       AND (branch_id IS NULL OR branch_id = _branch)) THEN
    RAISE EXCEPTION 'That equipment does not belong to this property';
  END IF;

  INSERT INTO public.grounds_tasks (
    organization_id, branch_id, title, area_label, area_id, equipment_asset_id, instruction,
    priority, due_at, service_date, assignee_user_id, status, created_by)
  VALUES (v_org, _branch, btrim(_title), v_area, _area_id, _equipment, nullif(btrim(coalesce(_instruction,'')),''),
    coalesce(nullif(_priority,''),'normal'), _due, coalesce(_due::date, current_date), _assignee,
    'not-started', auth.uid())
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (v_org, _branch, auth.uid(), '', 'maintenance.grounds_task.created', 'maintenance', v_row.id::text,
    jsonb_build_object('title', v_row.title, 'area', v_row.area_label, 'area_id', _area_id,
                       'equipment_asset_id', _equipment, 'assignee', _assignee, 'due_at', _due));
  RETURN v_row;
END; $$;

CREATE OR REPLACE FUNCTION public.neo_landscaping_schedule_save(
  _name text, _area text DEFAULT '', _frequency text DEFAULT 'weekly', _interval_days integer DEFAULT 7,
  _next_due date DEFAULT NULL, _instructions text DEFAULT '', _assignee uuid DEFAULT NULL,
  _branch uuid DEFAULT NULL, _id uuid DEFAULT NULL, _active boolean DEFAULT true,
  _area_id uuid DEFAULT NULL, _equipment uuid DEFAULT NULL)
RETURNS public.landscaping_schedules
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.landscaping_schedules; v_org uuid := current_org_id(); v_area text := btrim(coalesce(_area,''));
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No active organisation'; END IF;
  IF NOT has_permission('maintenance','landscaping','edit') THEN
    RAISE EXCEPTION 'You are not permitted to manage the landscaping programme';
  END IF;
  IF coalesce(btrim(_name),'') = '' THEN RAISE EXCEPTION 'Name the recurring grounds work'; END IF;
  IF coalesce(_interval_days, 0) <= 0 THEN RAISE EXCEPTION 'The repeat interval must be at least one day'; END IF;

  IF _area_id IS NOT NULL THEN
    SELECT name INTO v_area FROM public.grounds_areas WHERE id = _area_id AND organization_id = v_org;
    IF v_area IS NULL THEN RAISE EXCEPTION 'That grounds area does not exist'; END IF;
  END IF;

  IF _id IS NOT NULL THEN
    UPDATE public.landscaping_schedules SET
      name = btrim(_name), area_label = v_area, area_id = coalesce(_area_id, area_id),
      equipment_asset_id = _equipment, work_type = coalesce(work_type,'grounds'),
      frequency = coalesce(nullif(_frequency,''), frequency), interval_days = _interval_days,
      next_due_date = coalesce(_next_due, next_due_date), instructions = nullif(btrim(coalesce(_instructions,'')),''),
      assignee_user_id = _assignee, active = coalesce(_active, true)
    WHERE id = _id AND organization_id = v_org
    RETURNING * INTO v_row;
    IF v_row.id IS NULL THEN RAISE EXCEPTION 'That landscaping schedule was not found'; END IF;
  ELSE
    IF _branch IS NULL THEN RAISE EXCEPTION 'Select a property before saving a schedule'; END IF;
    INSERT INTO public.landscaping_schedules (
      organization_id, branch_id, name, area_label, area_id, equipment_asset_id, work_type, frequency,
      interval_days, next_due_date, instructions, assignee_user_id, active, created_by)
    VALUES (v_org, _branch, btrim(_name), v_area, _area_id, _equipment, 'grounds',
      coalesce(nullif(_frequency,''),'weekly'), _interval_days, coalesce(_next_due, current_date),
      nullif(btrim(coalesce(_instructions,'')),''), _assignee, coalesce(_active, true), auth.uid())
    RETURNING * INTO v_row;
  END IF;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (v_org, v_row.branch_id, auth.uid(), '', 'maintenance.landscaping_schedule.saved', 'maintenance',
          v_row.id::text, to_jsonb(v_row));
  RETURN v_row;
END; $$;

-- Generated grounds work carries the schedule's area and equipment.
CREATE OR REPLACE FUNCTION public.neo_landscaping_generate_due()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_created int := 0; v_sched record;
BEGIN
  IF NOT has_permission('maintenance', 'landscaping', 'edit') THEN
    RAISE EXCEPTION 'You are not permitted to generate grounds work';
  END IF;

  FOR v_sched IN
    SELECT * FROM public.landscaping_schedules
     WHERE organization_id = current_org_id() AND active AND next_due_date <= current_date
     FOR UPDATE
  LOOP
    INSERT INTO public.grounds_tasks (
      organization_id, branch_id, schedule_id, title, area_label, area_id, equipment_asset_id,
      instruction, priority, service_date, due_at, assignee_user_id
    ) VALUES (
      v_sched.organization_id, v_sched.branch_id, v_sched.id, v_sched.name, v_sched.area_label,
      v_sched.area_id, v_sched.equipment_asset_id, v_sched.instructions, 'normal', v_sched.next_due_date,
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

-- 3. Work order creation keeps the hotel's own category and planning fields
CREATE OR REPLACE FUNCTION public.neo_maintenance_work_order_create(_payload jsonb, _idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  _org uuid := public.current_org_id();
  _branch uuid := NULLIF(_payload->>'branch_id','')::uuid;
  _room uuid := NULLIF(_payload->>'room_id','')::uuid;
  _asset uuid := NULLIF(_payload->>'asset_id','')::uuid;
  _category uuid := NULLIF(_payload->>'category_id','')::uuid;
  _department uuid := NULLIF(_payload->>'requesting_department_id','')::uuid;
  _assignee uuid := NULLIF(_payload->>'assigned_to','')::uuid;
  _description text := btrim(COALESCE(_payload->>'description',''));
  _priority text := COALESCE(NULLIF(_payload->>'priority',''),'normal');
  _blocks boolean := COALESCE((_payload->>'blocks_room')::boolean, false);
  _severity text := COALESCE(NULLIF(_payload->>'block_status',''),'out-of-order');
  _existing public.maintenance_work_orders;
  _wo public.maintenance_work_orders;
  _number text;
  _room_state jsonb;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No active organisation'; END IF;
  IF NOT (public.has_permission('maintenance','edit') OR public.has_permission('housekeeping','edit')
          OR public.has_permission('laundry','edit') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to report maintenance faults';
  END IF;
  IF _description = '' THEN RAISE EXCEPTION 'Describe the fault before reporting it'; END IF;
  IF NULLIF(btrim(COALESCE(_idempotency_key,'')), '') IS NULL THEN RAISE EXCEPTION 'A work-order idempotency key is required'; END IF;
  IF _branch IS NULL OR NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch AND organization_id = _org) THEN
    RAISE EXCEPTION 'Select a valid property';
  END IF;
  IF _room IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.rooms WHERE id = _room AND organization_id = _org AND branch_id = _branch
  ) THEN RAISE EXCEPTION 'The selected room does not belong to this property'; END IF;
  IF _asset IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.assets WHERE id = _asset AND organization_id = _org AND (branch_id IS NULL OR branch_id = _branch)
  ) THEN RAISE EXCEPTION 'The selected asset does not belong to this property'; END IF;
  IF _category IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.maintenance_categories WHERE id = _category AND organization_id = _org
  ) THEN RAISE EXCEPTION 'That maintenance category does not belong to this workspace'; END IF;

  SELECT * INTO _existing FROM public.maintenance_work_orders
   WHERE organization_id = _org AND idempotency_key = _idempotency_key;
  IF _existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'work_order_id', _existing.id,
      'work_order_number', _existing.work_order_number, 'blocks_room', _existing.blocks_room);
  END IF;

  _number := public.next_document_number('work-order');
  INSERT INTO public.maintenance_work_orders
    (organization_id, branch_id, work_order_number, requesting_department_id, requested_by,
     room_id, location_label, asset_id, category_id, fault_category, description, priority, operational_impact,
     guest_impact, attachments, status, assigned_to, estimated_completion, cost_estimate,
     blocks_room, block_status, source_module, source_record_id, idempotency_key, created_by)
  VALUES
    (_org, _branch, _number, _department, auth.uid(), _room, NULLIF(_payload->>'location_label',''),
     _asset, _category,
     COALESCE(NULLIF(_payload->>'fault_category',''),
              (SELECT lower(coalesce(c.code, c.name)) FROM public.maintenance_categories c WHERE c.id = _category),
              'other'),
     _description, _priority,
     NULLIF(_payload->>'operational_impact',''), COALESCE((_payload->>'guest_impact')::boolean,false),
     COALESCE(_payload->'attachments','[]'::jsonb),
     CASE WHEN _assignee IS NOT NULL THEN 'assigned' ELSE 'new' END,
     _assignee,
     NULLIF(_payload->>'estimated_completion','')::timestamptz,
     NULLIF(_payload->>'cost_estimate','')::numeric,
     _blocks AND _room IS NOT NULL,
     CASE WHEN _blocks AND _room IS NOT NULL THEN _severity ELSE NULL END,
     COALESCE(NULLIF(_payload->>'source_module',''),'maintenance'),
     NULLIF(_payload->>'source_record_id','')::uuid, _idempotency_key, auth.uid())
  RETURNING * INTO _wo;

  INSERT INTO public.work_order_status_history
    (organization_id, work_order_id, previous_status, new_status, reason, changed_by)
  VALUES (_org, _wo.id, NULL, _wo.status, 'Work order created', auth.uid());

  IF _blocks AND _room IS NOT NULL THEN
    PERFORM set_config('neo.system_posting', 'on', true);
    _room_state := public.ops_set_room_status(_room, NULL, _severity, _description, 'maintenance', _wo.id, NULL);
  END IF;

  INSERT INTO public.audit_logs
    (organization_id, branch_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, _branch, auth.uid(), '', 'maintenance.work_order.created', 'maintenance', _wo.id::text,
    jsonb_build_object('work_order_number',_number,'room_id',_room,'asset_id',_asset,'category_id',_category,
                       'blocks_room',_wo.blocks_room,'room_state',_room_state));

  RETURN jsonb_build_object('ok', true, 'idempotent', false, 'work_order_id', _wo.id,
    'work_order_number', _number, 'blocks_room', _wo.blocks_room, 'room_state', _room_state);
END; $$;

-- 4. Completed work stays attached to the canonical asset -----------------
CREATE OR REPLACE FUNCTION public.neo_maint_asset_service_record()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_plan public.preventive_maintenance_plans; v_next date;
BEGIN
  IF NEW.asset_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.status NOT IN ('completed','closed') THEN RETURN NEW; END IF;
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.asset_service_history WHERE work_order_id = NEW.id) THEN RETURN NEW; END IF;

  IF NEW.source_module = 'preventive-maintenance' AND NEW.source_record_id IS NOT NULL THEN
    SELECT * INTO v_plan FROM public.preventive_maintenance_plans WHERE id = NEW.source_record_id;
    IF v_plan.id IS NOT NULL THEN v_next := current_date + greatest(coalesce(v_plan.interval_days,0),1); END IF;
  END IF;

  INSERT INTO public.asset_service_history (
    organization_id, asset_id, work_order_id, service_date, service_type, description,
    cost, next_service_date, created_by)
  VALUES (NEW.organization_id, NEW.asset_id, NEW.id, current_date,
    coalesce(nullif(NEW.fault_category,''),'corrective'),
    left(coalesce(nullif(NEW.completion_notes,''), nullif(NEW.diagnosis,''), NEW.description), 2000),
    NEW.actual_cost, v_next, coalesce(NEW.verified_by, NEW.assigned_to, auth.uid()));

  UPDATE public.assets
     SET last_service_date = current_date,
         next_service_date = coalesce(v_next, next_service_date),
         status = CASE WHEN status IN ('under-maintenance','out-of-service') THEN 'in-service' ELSE status END
   WHERE id = NEW.asset_id AND organization_id = NEW.organization_id;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (NEW.organization_id, NEW.branch_id, auth.uid(), '', 'maintenance.asset.serviced', 'maintenance',
          NEW.asset_id::text, jsonb_build_object('work_order_id', NEW.id,
            'work_order_number', NEW.work_order_number, 'status', NEW.status, 'cost', NEW.actual_cost));
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS maintenance_work_orders_asset_service ON public.maintenance_work_orders;
CREATE TRIGGER maintenance_work_orders_asset_service
  AFTER UPDATE OF status ON public.maintenance_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.neo_maint_asset_service_record();

-- 5. Spare parts consumed from Stores produce a real stock movement -------
CREATE OR REPLACE FUNCTION public.neo_maint_consume_part(
  _work_order uuid, _stock_item uuid, _location uuid, _quantity numeric,
  _unit text DEFAULT NULL, _description text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_wo public.maintenance_work_orders; v_item public.stock_items; v_loc public.stock_locations;
        v_cost numeric; v_movement uuid; v_part public.work_order_parts; v_key text;
BEGIN
  SELECT * INTO v_wo FROM public.maintenance_work_orders
   WHERE id = _work_order AND organization_id = current_org_id();
  IF v_wo.id IS NULL THEN RAISE EXCEPTION 'Work order not found'; END IF;
  IF v_wo.assigned_to IS DISTINCT FROM auth.uid()
     AND NOT (has_permission('maintenance','overview','edit') OR has_permission('maintenance','edit')) THEN
    RAISE EXCEPTION 'Only the assigned technician or a supervisor can record materials';
  END IF;
  IF coalesce(_quantity,0) <= 0 THEN RAISE EXCEPTION 'Quantity must be greater than zero'; END IF;

  SELECT * INTO v_item FROM public.stock_items WHERE id = _stock_item AND organization_id = v_wo.organization_id;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'That stock item does not belong to this workspace'; END IF;
  SELECT * INTO v_loc FROM public.stock_locations
   WHERE id = _location AND organization_id = v_wo.organization_id AND active;
  IF v_loc.id IS NULL THEN RAISE EXCEPTION 'Choose the store the part came from'; END IF;
  IF v_loc.branch_id IS NOT NULL AND v_wo.branch_id IS NOT NULL AND v_loc.branch_id <> v_wo.branch_id THEN
    RAISE EXCEPTION 'That store belongs to another property';
  END IF;

  v_key := 'maint:part:' || _work_order::text || ':' || _stock_item::text || ':' ||
           md5(_quantity::text || coalesce(_description,'') || clock_timestamp()::text);
  v_cost := public.neo_stock_average_cost(_stock_item, _location);

  PERFORM set_config('neo.system_posting', 'on', true);
  v_movement := public.inventory_apply_movement(
    _stock_item, _location, -1 * _quantity, coalesce(nullif(btrim(coalesce(_unit,'')),''), v_item.base_unit),
    'issue', v_cost, 'maintenance_work_order', _work_order,
    'Maintenance work order ' || coalesce(v_wo.work_order_number,''), v_key, NULL, NULL);

  INSERT INTO public.work_order_parts (
    organization_id, work_order_id, stock_item_id, description, quantity, unit, unit_cost, status, created_by)
  VALUES (v_wo.organization_id, _work_order, _stock_item,
    coalesce(nullif(btrim(coalesce(_description,'')),''), v_item.name), _quantity,
    coalesce(nullif(btrim(coalesce(_unit,'')),''), v_item.base_unit), v_cost, 'issued', auth.uid())
  RETURNING * INTO v_part;

  UPDATE public.maintenance_work_orders
     SET actual_cost = coalesce(actual_cost, 0) + coalesce(round(_quantity * coalesce(v_cost,0), 2), 0)
   WHERE id = _work_order;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (v_wo.organization_id, v_wo.branch_id, auth.uid(), '', 'maintenance.part.consumed', 'maintenance',
    _work_order::text, jsonb_build_object('stock_item_id', _stock_item, 'location_id', _location,
      'quantity', _quantity, 'unit_cost', v_cost, 'movement_id', v_movement, 'part_id', v_part.id));

  RETURN jsonb_build_object('ok', true, 'part_id', v_part.id, 'movement_id', v_movement,
    'unit_cost', v_cost, 'valued', v_cost IS NOT NULL AND v_cost > 0);
END; $$;

REVOKE ALL ON FUNCTION public.neo_maint_consume_part(uuid, uuid, uuid, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_maint_consume_part(uuid, uuid, uuid, numeric, text, text) TO authenticated;

-- 6. Overdue and breached maintenance escalates once ----------------------
CREATE OR REPLACE FUNCTION public.neo_maint_escalation_scan(_branch uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_org uuid := current_org_id(); v_wo record; v_raised int := 0; v_level int; v_reason text; v_key text;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No active organisation'; END IF;
  IF NOT (has_permission('maintenance','edit') OR has_permission('maintenance','view') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to review maintenance escalations';
  END IF;

  FOR v_wo IN
    SELECT w.*, c.response_target_minutes, c.resolution_target_minutes, c.name AS category_name
      FROM public.maintenance_work_orders w
      LEFT JOIN public.maintenance_categories c ON c.id = w.category_id
     WHERE w.organization_id = v_org
       AND w.status NOT IN ('closed','cancelled','completed','awaiting-verification')
       AND (_branch IS NULL OR w.branch_id = _branch)
  LOOP
    v_level := NULL; v_reason := NULL;

    IF v_wo.resolution_target_minutes IS NOT NULL
       AND now() > v_wo.reported_at + make_interval(mins => v_wo.resolution_target_minutes) THEN
      v_level := 2;
      v_reason := 'Resolution target of ' || v_wo.resolution_target_minutes || ' minutes passed for '
                  || coalesce(v_wo.category_name, v_wo.fault_category);
    ELSIF v_wo.response_target_minutes IS NOT NULL AND v_wo.assigned_to IS NULL
          AND now() > v_wo.reported_at + make_interval(mins => v_wo.response_target_minutes) THEN
      v_level := 1;
      v_reason := 'No technician assigned within the ' || v_wo.response_target_minutes || ' minute response target';
    ELSIF v_wo.estimated_completion IS NOT NULL AND now() > v_wo.estimated_completion THEN
      v_level := 1;
      v_reason := 'Planned completion date passed';
    END IF;

    IF v_level IS NULL THEN CONTINUE; END IF;

    v_key := 'maint:escalation:' || v_wo.id::text || ':' || v_level::text;
    INSERT INTO public.escalation_events (organization_id, branch_id, department_id, subject_type,
      subject_id, level, reason, idempotency_key)
    VALUES (v_org, v_wo.branch_id, v_wo.requesting_department_id, 'maintenance_work_order',
      v_wo.id, v_level, v_reason, v_key)
    ON CONFLICT (idempotency_key) DO NOTHING;

    IF FOUND THEN
      v_raised := v_raised + 1;
      PERFORM public.neo_notify(v_org, NULL, v_wo.branch_id, 'maintenance',
        'Maintenance overdue — ' || coalesce(v_wo.work_order_number,''), v_reason,
        '/maintenance', CASE WHEN v_level >= 2 THEN 'high' ELSE 'normal' END, true,
        'maintenance', v_wo.id, 'maintenance.work_order.escalated', v_key);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('raised', v_raised);
END; $$;

REVOKE ALL ON FUNCTION public.neo_maint_escalation_scan(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_maint_escalation_scan(uuid) TO authenticated;
