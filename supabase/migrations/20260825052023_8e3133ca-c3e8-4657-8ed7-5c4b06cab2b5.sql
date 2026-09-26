-- ============================================================
-- NEØ Pastry & Bakery department execution layer
-- Head Pastry Chef -> Pastry Chef(s). Only the Head Pastry Chef
-- may send a Stores requisition.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.pastry_production_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT public.current_org_id(),
  branch_id uuid,
  plan_date date NOT NULL DEFAULT (now()::date),
  status text NOT NULL DEFAULT 'draft',
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pastry_plan_unique_day
  ON public.pastry_production_plans (organization_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), plan_date);

GRANT SELECT ON public.pastry_production_plans TO authenticated;
GRANT ALL ON public.pastry_production_plans TO service_role;
ALTER TABLE public.pastry_production_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pastry plans readable in scope" ON public.pastry_production_plans;
CREATE POLICY "pastry plans readable in scope"
  ON public.pastry_production_plans FOR SELECT TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (
      public.has_permission('kitchen', 'pastry-schedule', 'view')
      OR public.has_permission('kitchen', 'pastry-production', 'view')
    )
  );

CREATE TABLE IF NOT EXISTS public.pastry_production_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT public.current_org_id(),
  branch_id uuid,
  plan_id uuid REFERENCES public.pastry_production_plans(id) ON DELETE CASCADE,
  product text NOT NULL,
  quantity numeric NOT NULL DEFAULT 1,
  unit text NOT NULL DEFAULT 'piece',
  produced_quantity numeric NOT NULL DEFAULT 0,
  sold_quantity numeric NOT NULL DEFAULT 0,
  wasted_quantity numeric NOT NULL DEFAULT 0,
  menu_item_id uuid,
  assignee_id uuid,
  status text NOT NULL DEFAULT 'planned',
  due_at timestamptz,
  special_instructions text,
  started_at timestamptz,
  ready_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.pastry_production_items TO authenticated;
GRANT ALL ON public.pastry_production_items TO service_role;
ALTER TABLE public.pastry_production_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pastry production readable in scope" ON public.pastry_production_items;
CREATE POLICY "pastry production readable in scope"
  ON public.pastry_production_items FOR SELECT TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND (
      assignee_id = auth.uid()
      OR public.has_permission('kitchen', 'pastry-schedule', 'view')
    )
  );

CREATE TABLE IF NOT EXISTS public.pastry_custom_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT public.current_org_id(),
  branch_id uuid,
  order_number text NOT NULL,
  customer_name text NOT NULL,
  customer_phone text,
  product text NOT NULL,
  size_kg numeric,
  flavour text,
  cake_message text,
  decoration_notes text,
  required_at timestamptz,
  status text NOT NULL DEFAULT 'new',
  assignee_id uuid,
  quoted_amount numeric,
  production_notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pastry_custom_order_number_unique
  ON public.pastry_custom_orders (organization_id, order_number);

GRANT SELECT ON public.pastry_custom_orders TO authenticated;
GRANT ALL ON public.pastry_custom_orders TO service_role;
ALTER TABLE public.pastry_custom_orders ENABLE ROW LEVEL SECURITY;

-- The full record, including the quoted amount, belongs to the Head Pastry
-- Chef. A Pastry Chef reaches their own assigned cakes through
-- neo_pastry_my_production(), which never returns the money.
DROP POLICY IF EXISTS "pastry custom orders readable by supervisors" ON public.pastry_custom_orders;
CREATE POLICY "pastry custom orders readable by supervisors"
  ON public.pastry_custom_orders FOR SELECT TO authenticated
  USING (
    organization_id = public.current_org_id()
    AND public.has_permission('kitchen', 'pastry-custom-orders', 'view')
  );

DROP TRIGGER IF EXISTS set_pastry_plans_updated_at ON public.pastry_production_plans;
CREATE TRIGGER set_pastry_plans_updated_at
  BEFORE UPDATE ON public.pastry_production_plans
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS set_pastry_items_updated_at ON public.pastry_production_items;
CREATE TRIGGER set_pastry_items_updated_at
  BEFORE UPDATE ON public.pastry_production_items
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS set_pastry_custom_orders_updated_at ON public.pastry_custom_orders;
CREATE TRIGGER set_pastry_custom_orders_updated_at
  BEFORE UPDATE ON public.pastry_custom_orders
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE INDEX IF NOT EXISTS pastry_items_plan_idx ON public.pastry_production_items (organization_id, plan_id, status);
CREATE INDEX IF NOT EXISTS pastry_items_assignee_idx ON public.pastry_production_items (organization_id, assignee_id, status);
CREATE INDEX IF NOT EXISTS pastry_custom_orders_idx ON public.pastry_custom_orders (organization_id, branch_id, required_at);

-- ============================================================
-- Production plan — Head Pastry Chef
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_pastry_plan_upsert(
  _plan_date date DEFAULT NULL, _branch uuid DEFAULT NULL, _notes text DEFAULT NULL
)
RETURNS public.pastry_production_plans
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_row public.pastry_production_plans; v_branch uuid; v_date date;
BEGIN
  IF NOT public.has_permission('kitchen', 'pastry-schedule', 'create') THEN
    RAISE EXCEPTION 'Only the Head Pastry Chef can plan pastry production';
  END IF;

  SELECT coalesce(_branch, p.branch_id) INTO v_branch FROM public.profiles p WHERE p.id = auth.uid();
  v_date := coalesce(_plan_date, now()::date);

  SELECT * INTO v_row FROM public.pastry_production_plans
   WHERE organization_id = current_org_id()
     AND plan_date = v_date
     AND coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = coalesce(v_branch, '00000000-0000-0000-0000-000000000000'::uuid);

  IF v_row.id IS NULL THEN
    INSERT INTO public.pastry_production_plans (organization_id, branch_id, plan_date, notes, created_by)
    VALUES (current_org_id(), v_branch, v_date, nullif(btrim(_notes), ''), auth.uid())
    RETURNING * INTO v_row;
  ELSIF nullif(btrim(_notes), '') IS NOT NULL THEN
    UPDATE public.pastry_production_plans SET notes = btrim(_notes), updated_at = now()
     WHERE id = v_row.id RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_pastry_plan_upsert(date, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pastry_plan_upsert(date, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_pastry_plan_item_add(
  _plan uuid, _product text, _quantity numeric DEFAULT 1, _unit text DEFAULT 'piece',
  _assignee uuid DEFAULT NULL, _due timestamptz DEFAULT NULL, _instructions text DEFAULT NULL
)
RETURNS public.pastry_production_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_row public.pastry_production_items; v_plan public.pastry_production_plans;
BEGIN
  IF NOT public.has_permission('kitchen', 'pastry-schedule', 'create') THEN
    RAISE EXCEPTION 'Only the Head Pastry Chef can add planned production';
  END IF;
  IF coalesce(btrim(_product), '') = '' THEN RAISE EXCEPTION 'Name the product to produce'; END IF;
  IF coalesce(_quantity, 0) <= 0 THEN RAISE EXCEPTION 'Quantity must be greater than zero'; END IF;

  SELECT * INTO v_plan FROM public.pastry_production_plans
   WHERE id = _plan AND organization_id = current_org_id();
  IF v_plan.id IS NULL THEN RAISE EXCEPTION 'Production plan not found'; END IF;

  INSERT INTO public.pastry_production_items (
    organization_id, branch_id, plan_id, product, quantity, unit, assignee_id,
    status, due_at, special_instructions, created_by
  ) VALUES (
    current_org_id(), v_plan.branch_id, v_plan.id, btrim(_product), _quantity,
    coalesce(nullif(btrim(_unit), ''), 'piece'), _assignee,
    CASE WHEN _assignee IS NULL THEN 'planned' ELSE 'assigned' END,
    _due, nullif(btrim(_instructions), ''), auth.uid()
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_pastry_plan_item_add(uuid, text, numeric, text, uuid, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pastry_plan_item_add(uuid, text, numeric, text, uuid, timestamptz, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_pastry_item_assign(_item uuid, _assignee uuid)
RETURNS public.pastry_production_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_row public.pastry_production_items;
BEGIN
  IF NOT public.has_permission('kitchen', 'pastry-schedule', 'edit') THEN
    RAISE EXCEPTION 'Only the Head Pastry Chef can assign pastry production';
  END IF;

  SELECT * INTO v_row FROM public.pastry_production_items
   WHERE id = _item AND organization_id = current_org_id();
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Production item not found'; END IF;
  IF v_row.status IN ('ready', 'completed', 'cancelled') THEN
    RAISE EXCEPTION 'That production is already finished';
  END IF;

  UPDATE public.pastry_production_items
     SET assignee_id = _assignee,
         status = CASE WHEN status = 'planned' THEN 'assigned' ELSE status END,
         updated_at = now()
   WHERE id = _item
  RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_pastry_item_assign(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pastry_item_assign(uuid, uuid) TO authenticated;

-- ============================================================
-- A Pastry Chef's own work — production and assigned custom cakes,
-- with no customer financial information
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_pastry_my_production(_branch uuid DEFAULT NULL)
RETURNS TABLE(
  source text, id uuid, reference text, product text, quantity numeric, unit text,
  status text, due_at timestamptz, special_instructions text, flavour text,
  cake_message text, produced_quantity numeric
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT
    'plan'::text, i.id, coalesce(to_char(pl.plan_date, 'YYYY-MM-DD'), 'Plan'),
    i.product, i.quantity, i.unit, i.status, i.due_at, i.special_instructions,
    NULL::text, NULL::text, i.produced_quantity
  FROM public.pastry_production_items i
  LEFT JOIN public.pastry_production_plans pl ON pl.id = i.plan_id
  WHERE i.organization_id = current_org_id()
    AND (_branch IS NULL OR i.branch_id = _branch)
    AND i.assignee_id = auth.uid()
    AND i.status NOT IN ('completed', 'cancelled')
    AND public.has_permission('kitchen', 'pastry-production', 'view')
  UNION ALL
  SELECT
    'custom'::text, c.id, c.order_number, c.product, coalesce(c.size_kg, 1), 'kg',
    c.status, c.required_at, coalesce(c.decoration_notes, c.production_notes),
    c.flavour, c.cake_message, NULL::numeric
  FROM public.pastry_custom_orders c
  WHERE c.organization_id = current_org_id()
    AND (_branch IS NULL OR c.branch_id = _branch)
    AND c.assignee_id = auth.uid()
    AND c.status NOT IN ('collected', 'cancelled')
    AND public.has_permission('kitchen', 'pastry-production', 'view')
  ORDER BY 8 NULLS LAST
  LIMIT 200;
$$;

REVOKE EXECUTE ON FUNCTION public.neo_pastry_my_production(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pastry_my_production(uuid) TO authenticated;

-- ============================================================
-- Production progression: planned -> assigned -> in-preparation
-- -> decorating -> ready -> completed
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_pastry_item_advance(
  _item uuid, _status text, _produced numeric DEFAULT NULL
)
RETURNS public.pastry_production_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_row public.pastry_production_items; v_allowed text[];
BEGIN
  SELECT * INTO v_row FROM public.pastry_production_items
   WHERE id = _item AND organization_id = current_org_id();
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Production item not found'; END IF;

  IF v_row.assignee_id IS DISTINCT FROM auth.uid()
     AND NOT public.has_permission('kitchen', 'pastry-schedule', 'edit') THEN
    RAISE EXCEPTION 'You can only update production assigned to you';
  END IF;

  v_allowed := CASE v_row.status
    WHEN 'planned' THEN ARRAY['assigned', 'in-preparation']
    WHEN 'assigned' THEN ARRAY['in-preparation']
    WHEN 'in-preparation' THEN ARRAY['decorating', 'ready']
    WHEN 'decorating' THEN ARRAY['ready']
    WHEN 'ready' THEN ARRAY['completed']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (_status = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'Production cannot move from % to %', v_row.status, _status;
  END IF;

  UPDATE public.pastry_production_items
     SET status = _status,
         produced_quantity = CASE WHEN _produced IS NULL THEN produced_quantity ELSE greatest(_produced, 0) END,
         started_at = CASE WHEN _status = 'in-preparation' AND started_at IS NULL THEN now() ELSE started_at END,
         ready_at = CASE WHEN _status = 'ready' THEN now() ELSE ready_at END,
         updated_at = now()
   WHERE id = _item
  RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_pastry_item_advance(uuid, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pastry_item_advance(uuid, text, numeric) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_pastry_item_record_sales(_item uuid, _sold numeric, _wasted numeric DEFAULT NULL)
RETURNS public.pastry_production_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_row public.pastry_production_items;
BEGIN
  IF NOT public.has_permission('kitchen', 'pastry-schedule', 'edit') THEN
    RAISE EXCEPTION 'Only the Head Pastry Chef can reconcile produced against sold';
  END IF;

  SELECT * INTO v_row FROM public.pastry_production_items
   WHERE id = _item AND organization_id = current_org_id();
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Production item not found'; END IF;
  IF coalesce(_sold, 0) < 0 OR coalesce(_wasted, 0) < 0 THEN
    RAISE EXCEPTION 'Quantities cannot be negative';
  END IF;
  IF coalesce(_sold, 0) + coalesce(_wasted, v_row.wasted_quantity) > v_row.produced_quantity THEN
    RAISE EXCEPTION 'Sold and wasted cannot exceed what was produced';
  END IF;

  UPDATE public.pastry_production_items
     SET sold_quantity = coalesce(_sold, sold_quantity),
         wasted_quantity = coalesce(_wasted, wasted_quantity),
         updated_at = now()
   WHERE id = _item
  RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_pastry_item_record_sales(uuid, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pastry_item_record_sales(uuid, numeric, numeric) TO authenticated;

-- ============================================================
-- Custom cake orders
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_pastry_custom_order_create(
  _customer_name text, _product text, _required_at timestamptz DEFAULT NULL,
  _size_kg numeric DEFAULT NULL, _flavour text DEFAULT NULL, _cake_message text DEFAULT NULL,
  _customer_phone text DEFAULT NULL, _decoration_notes text DEFAULT NULL,
  _quoted_amount numeric DEFAULT NULL, _branch uuid DEFAULT NULL
)
RETURNS public.pastry_custom_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_row public.pastry_custom_orders; v_branch uuid; v_seq bigint;
BEGIN
  IF NOT public.has_permission('kitchen', 'pastry-custom-orders', 'create') THEN
    RAISE EXCEPTION 'You are not permitted to take custom cake orders';
  END IF;
  IF coalesce(btrim(_customer_name), '') = '' THEN RAISE EXCEPTION 'Record who the cake is for'; END IF;
  IF coalesce(btrim(_product), '') = '' THEN RAISE EXCEPTION 'Describe the cake'; END IF;

  SELECT coalesce(_branch, p.branch_id) INTO v_branch FROM public.profiles p WHERE p.id = auth.uid();

  SELECT count(*) + 1 INTO v_seq FROM public.pastry_custom_orders WHERE organization_id = current_org_id();

  INSERT INTO public.pastry_custom_orders (
    organization_id, branch_id, order_number, customer_name, customer_phone, product,
    size_kg, flavour, cake_message, decoration_notes, required_at, quoted_amount, created_by
  ) VALUES (
    current_org_id(), v_branch,
    'CAKE-' || to_char(now(), 'YYMM') || '-' || lpad(v_seq::text, 4, '0'),
    btrim(_customer_name), nullif(btrim(_customer_phone), ''), btrim(_product),
    _size_kg, nullif(btrim(_flavour), ''), nullif(btrim(_cake_message), ''),
    nullif(btrim(_decoration_notes), ''), _required_at, _quoted_amount, auth.uid()
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_pastry_custom_order_create(text, text, timestamptz, numeric, text, text, text, text, numeric, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pastry_custom_order_create(text, text, timestamptz, numeric, text, text, text, text, numeric, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_pastry_custom_order_assign(_order uuid, _assignee uuid)
RETURNS public.pastry_custom_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_row public.pastry_custom_orders;
BEGIN
  IF NOT public.has_permission('kitchen', 'pastry-custom-orders', 'edit') THEN
    RAISE EXCEPTION 'Only the Head Pastry Chef assigns custom cake production';
  END IF;

  SELECT * INTO v_row FROM public.pastry_custom_orders
   WHERE id = _order AND organization_id = current_org_id();
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Custom cake order not found'; END IF;

  UPDATE public.pastry_custom_orders
     SET assignee_id = _assignee,
         status = CASE WHEN status = 'new' THEN 'assigned' ELSE status END,
         updated_at = now()
   WHERE id = _order
  RETURNING * INTO v_row;

  INSERT INTO public.notifications (organization_id, branch_id, category, title, body, link)
  VALUES (current_org_id(), v_row.branch_id, 'operations', 'Custom cake assigned',
          v_row.order_number || ' — ' || v_row.product, '/pastry/my-production');

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_pastry_custom_order_assign(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pastry_custom_order_assign(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_pastry_custom_order_advance(_order uuid, _status text, _note text DEFAULT NULL)
RETURNS public.pastry_custom_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_row public.pastry_custom_orders; v_allowed text[];
BEGIN
  SELECT * INTO v_row FROM public.pastry_custom_orders
   WHERE id = _order AND organization_id = current_org_id();
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Custom cake order not found'; END IF;

  IF v_row.assignee_id IS DISTINCT FROM auth.uid()
     AND NOT public.has_permission('kitchen', 'pastry-custom-orders', 'edit') THEN
    RAISE EXCEPTION 'You can only update a cake assigned to you';
  END IF;

  v_allowed := CASE v_row.status
    WHEN 'new' THEN ARRAY['assigned', 'cancelled']
    WHEN 'assigned' THEN ARRAY['in-preparation', 'cancelled']
    WHEN 'in-preparation' THEN ARRAY['decorating', 'ready']
    WHEN 'decorating' THEN ARRAY['ready']
    WHEN 'ready' THEN ARRAY['collected']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (_status = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'A custom cake cannot move from % to %', v_row.status, _status;
  END IF;

  IF _status IN ('cancelled', 'collected')
     AND NOT public.has_permission('kitchen', 'pastry-custom-orders', 'edit') THEN
    RAISE EXCEPTION 'Only the Head Pastry Chef closes a custom cake order';
  END IF;

  UPDATE public.pastry_custom_orders
     SET status = _status,
         production_notes = CASE WHEN nullif(btrim(_note), '') IS NULL THEN production_notes
                                 ELSE coalesce(production_notes || E'\n', '') || btrim(_note) END,
         updated_at = now()
   WHERE id = _order
  RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_pastry_custom_order_advance(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pastry_custom_order_advance(uuid, text, text) TO authenticated;

-- ============================================================
-- Wastage — both roles record, only the Head Pastry Chef reviews
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_pastry_waste_record(
  _item text, _quantity numeric, _unit text DEFAULT 'piece', _reason text DEFAULT NULL,
  _estimated_cost numeric DEFAULT NULL, _branch uuid DEFAULT NULL
)
RETURNS public.waste_records
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_row public.waste_records; v_branch uuid; v_seq bigint;
BEGIN
  IF NOT public.has_permission('kitchen', 'pastry-waste', 'create') THEN
    RAISE EXCEPTION 'You are not permitted to record pastry wastage';
  END IF;
  IF coalesce(btrim(_item), '') = '' THEN RAISE EXCEPTION 'Name the product or ingredient wasted'; END IF;
  IF coalesce(_quantity, 0) <= 0 THEN RAISE EXCEPTION 'Quantity must be greater than zero'; END IF;

  SELECT coalesce(_branch, p.branch_id) INTO v_branch FROM public.profiles p WHERE p.id = auth.uid();
  SELECT count(*) + 1 INTO v_seq FROM public.waste_records WHERE organization_id = current_org_id();

  INSERT INTO public.waste_records (
    organization_id, branch_id, waste_number, ingredient_name, quantity, unit,
    estimated_cost, category, reason, status, recorded_by
  ) VALUES (
    current_org_id(), v_branch,
    'WST-' || to_char(now(), 'YYMM') || '-' || lpad(v_seq::text, 5, '0'),
    btrim(_item), _quantity, coalesce(nullif(btrim(_unit), ''), 'piece'),
    _estimated_cost, 'pastry', nullif(btrim(_reason), ''), 'pending-review', auth.uid()
  ) RETURNING * INTO v_row;

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_pastry_waste_record(text, numeric, text, text, numeric, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pastry_waste_record(text, numeric, text, text, numeric, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_pastry_waste_review(_record uuid, _decision text, _comment text DEFAULT NULL)
RETURNS public.waste_records
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_row public.waste_records;
BEGIN
  IF NOT public.has_permission('kitchen', 'pastry-waste', 'approve') THEN
    RAISE EXCEPTION 'Only the Head Pastry Chef reviews pastry wastage';
  END IF;
  IF _decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'Unknown decision'; END IF;

  SELECT * INTO v_row FROM public.waste_records WHERE id = _record AND organization_id = current_org_id();
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Waste record not found'; END IF;
  IF v_row.recorded_by = auth.uid() THEN
    RAISE EXCEPTION 'You cannot review wastage you recorded yourself';
  END IF;

  UPDATE public.waste_records
     SET status = _decision, reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
   WHERE id = _record
  RETURNING * INTO v_row;

  INSERT INTO public.waste_approval_actions (organization_id, waste_record_id, action, comment, acted_by)
  VALUES (current_org_id(), _record, _decision, nullif(btrim(_comment), ''), auth.uid());

  RETURN v_row;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_pastry_waste_review(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pastry_waste_review(uuid, text, text) TO authenticated;

-- ============================================================
-- Head Pastry Chef alone turns reported needs into a Stores requisition
-- ============================================================
CREATE OR REPLACE FUNCTION public.neo_pastry_requisition_from_needs(
  _needs uuid[], _required_date date DEFAULT NULL, _priority text DEFAULT 'normal', _reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_lines jsonb; v_req jsonb; v_branch uuid; v_dept uuid; v_id uuid;
BEGIN
  IF NOT public.has_permission('kitchen', 'pastry-requisition', 'create') THEN
    RAISE EXCEPTION 'Only the Head Pastry Chef can send a Stores requisition for Pastry & Bakery';
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
    AND n.module = 'pastry'
    AND n.status IN ('reported', 'acknowledged');

  IF v_lines IS NULL THEN RAISE EXCEPTION 'No open pastry needs match that selection'; END IF;

  v_req := to_jsonb(public.neo_department_requisition_create(
    v_branch, v_lines, v_dept, _required_date,
    coalesce(nullif(btrim(_priority), ''), 'normal'),
    coalesce(nullif(btrim(_reason), ''), 'Pastry & Bakery consolidated requisition'),
    NULL
  ));

  v_id := nullif(v_req->>'id', '')::uuid;

  UPDATE public.department_stock_needs
     SET status = 'requisitioned', reviewed_by = auth.uid(), reviewed_at = now(),
         requisition_id = v_id, updated_at = now()
   WHERE id = ANY(_needs)
     AND organization_id = current_org_id()
     AND module = 'pastry'
     AND status IN ('reported', 'acknowledged');

  RETURN v_req;
END; $$;

REVOKE EXECUTE ON FUNCTION public.neo_pastry_requisition_from_needs(uuid[], date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_pastry_requisition_from_needs(uuid[], date, text, text) TO authenticated;