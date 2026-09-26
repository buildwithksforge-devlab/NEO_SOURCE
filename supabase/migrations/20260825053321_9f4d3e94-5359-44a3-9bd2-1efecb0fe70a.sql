-- 1. Register the pastry capabilities -------------------------------------
INSERT INTO public.permissions (module, feature, action, label)
SELECT 'kitchen', v.feature, a.action,
       'Pastry & Bakery — ' || replace(v.feature, 'pastry-', '') || ' (' || a.action || ')'
FROM (VALUES
  ('pastry-schedule'), ('pastry-production'), ('pastry-custom-orders'),
  ('pastry-waste'), ('pastry-needs'), ('pastry-requisition')
) v(feature)
CROSS JOIN (VALUES
  ('view'), ('create'), ('edit'), ('delete'), ('approve'), ('reject'),
  ('export'), ('print'), ('override'), ('void'), ('refund')
) a(action)
WHERE NOT EXISTS (
  SELECT 1 FROM public.permissions p
   WHERE p.module = 'kitchen' AND p.feature = v.feature AND p.action = a.action
);

-- 2. Head Pastry Chef — department scope over the whole bakery -------------
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'head-pastry-chef', 'kitchen', v.feature, a.action
FROM (VALUES
  ('pastry-schedule'), ('pastry-production'), ('pastry-custom-orders'),
  ('pastry-waste'), ('pastry-needs'), ('pastry-requisition')
) v(feature)
CROSS JOIN (VALUES ('view'), ('create'), ('edit'), ('approve'), ('export'), ('print')) a(action)
ON CONFLICT DO NOTHING;

-- 3. Pastry Chef — own production, report a need, record wastage -----------
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT 'pastry-chef', 'kitchen', v.feature, a.action
FROM (VALUES ('pastry-production'), ('pastry-waste'), ('pastry-needs')) v(feature)
CROSS JOIN (VALUES ('view'), ('create'), ('edit')) a(action)
ON CONFLICT DO NOTHING;

-- A Pastry Chef never sees the schedule, cake pricing or the requisition.
DELETE FROM public.role_feature_templates
 WHERE role_key = 'pastry-chef'
   AND module = 'kitchen'
   AND feature IN ('pastry-schedule', 'pastry-custom-orders', 'pastry-requisition');

-- 4. Fix the department requisition line mapping ---------------------------
-- `neo_department_requisition_create` expects `description`,
-- `quantity_requested`, `unit` and `notes`, and returns `requisition_id`.
-- Both consolidation routines were sending `item_name`/`quantity` and reading
-- `id`, so every line was skipped and no need was ever linked.
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

  SELECT jsonb_agg(jsonb_build_object(
           'description', n.item, 'quantity_requested', n.quantity,
           'unit', n.unit, 'notes', n.notes)),
         min(n.branch_id), min(n.department_id)
    INTO v_lines, v_branch, v_dept
  FROM public.department_stock_needs n
  WHERE n.id = ANY(_needs)
    AND n.organization_id = current_org_id()
    AND n.module = 'kitchen'
    AND n.status IN ('reported', 'acknowledged');

  IF v_lines IS NULL THEN RAISE EXCEPTION 'No open kitchen needs match that selection'; END IF;

  v_req := public.neo_department_requisition_create(
    v_branch, v_lines, v_dept, _required_date,
    coalesce(nullif(btrim(_priority), ''), 'normal'),
    coalesce(nullif(btrim(_reason), ''), 'Main Kitchen consolidated requisition'),
    NULL
  );

  v_id := nullif(v_req->>'requisition_id', '')::uuid;

  UPDATE public.department_stock_needs
     SET status = 'requisitioned', reviewed_by = auth.uid(), reviewed_at = now(),
         requisition_id = v_id, updated_at = now()
   WHERE id = ANY(_needs) AND organization_id = current_org_id() AND module = 'kitchen';

  RETURN v_req;
END; $$;

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

  SELECT jsonb_agg(jsonb_build_object(
           'description', n.item, 'quantity_requested', n.quantity,
           'unit', n.unit, 'notes', n.notes)),
         min(n.branch_id), min(n.department_id)
    INTO v_lines, v_branch, v_dept
  FROM public.department_stock_needs n
  WHERE n.id = ANY(_needs)
    AND n.organization_id = current_org_id()
    AND n.module = 'pastry'
    AND n.status IN ('reported', 'acknowledged');

  IF v_lines IS NULL THEN RAISE EXCEPTION 'No open pastry needs match that selection'; END IF;

  v_req := public.neo_department_requisition_create(
    v_branch, v_lines, v_dept, _required_date,
    coalesce(nullif(btrim(_priority), ''), 'normal'),
    coalesce(nullif(btrim(_reason), ''), 'Pastry & Bakery consolidated requisition'),
    NULL
  );

  v_id := nullif(v_req->>'requisition_id', '')::uuid;

  UPDATE public.department_stock_needs
     SET status = 'requisitioned', reviewed_by = auth.uid(), reviewed_at = now(),
         requisition_id = v_id, updated_at = now()
   WHERE id = ANY(_needs)
     AND organization_id = current_org_id()
     AND module = 'pastry'
     AND status IN ('reported', 'acknowledged');

  RETURN v_req;
END; $$;

-- 5. Compile the templates into real grants for every organisation ---------
SELECT public.neo_apply_feature_templates(o.id) FROM public.organizations o;