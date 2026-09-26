-- 1. Canonical capabilities for the F&B layer -------------------------------
INSERT INTO public.permissions (module, feature, action, label)
SELECT 'restaurant', f.feature, a.action,
       initcap(a.action) || ' · Restaurant ' || initcap(replace(f.feature, '-', ' '))
FROM (VALUES ('requisitions'), ('wastage')) AS f(feature),
     (VALUES ('view'), ('create'), ('edit'), ('approve'), ('reject'), ('export'), ('print')) AS a(action)
ON CONFLICT (module, feature, action) DO NOTHING;

-- 2. Reporting line: Coffee Station Supervisor reports to the F&B Manager ---
UPDATE public.role_catalogue
   SET reports_to_key = 'food-and-beverage-manager',
       reports_to_role_keys = ARRAY['food-and-beverage-manager'],
       updated_at = now()
 WHERE role_key = 'coffee-station-supervisor';

-- 3. Feature templates for the five F&B roles -------------------------------
DELETE FROM public.role_feature_templates
 WHERE role_key IN ('food-and-beverage-manager', 'restaurant-manager',
                    'coffee-station-supervisor', 'waiter', 'barista');

WITH spec(role_key, module, feature, actions) AS (
  VALUES
    -- F&B Manager — whole department, approves wastage, reads reports
    ('food-and-beverage-manager','restaurant','overview',   ARRAY['view','create','edit','approve','export','print']),
    ('food-and-beverage-manager','restaurant','floor',      ARRAY['view','create','edit','approve','export','print']),
    ('food-and-beverage-manager','restaurant','orders',     ARRAY['view','create','edit','approve','export','print']),
    ('food-and-beverage-manager','restaurant','kds',        ARRAY['view','create','edit','approve','export','print']),
    ('food-and-beverage-manager','restaurant','menu',       ARRAY['view','create','edit','approve','export','print']),
    ('food-and-beverage-manager','restaurant','shifts',     ARRAY['view','create','edit','approve','export','print']),
    ('food-and-beverage-manager','restaurant','reports',    ARRAY['view','export','print']),
    ('food-and-beverage-manager','restaurant','approvals',  ARRAY['view','approve','reject']),
    ('food-and-beverage-manager','restaurant','requisitions',ARRAY['view','create','edit','approve','export','print']),
    ('food-and-beverage-manager','restaurant','wastage',    ARRAY['view','create','edit','approve','reject','export','print']),
    ('food-and-beverage-manager','restaurant','complimentary', ARRAY['view','create','approve']),
    ('food-and-beverage-manager','kitchen','overview',      ARRAY['view','export']),
    ('food-and-beverage-manager','kitchen','queue',         ARRAY['view']),
    ('food-and-beverage-manager','kitchen','reports',       ARRAY['view','export','print']),
    ('food-and-beverage-manager','stores','overview',       ARRAY['view']),
    ('food-and-beverage-manager','events','overview',       ARRAY['view']),
    ('food-and-beverage-manager','analytics','overview',    ARRAY['view','export']),
    ('food-and-beverage-manager','reports','overview',      ARRAY['view','export','print']),
    ('food-and-beverage-manager','ai','insights',           ARRAY['view']),

    -- Restaurant Manager — restaurant floor authority
    ('restaurant-manager','restaurant','overview',    ARRAY['view','create','edit','approve','export','print']),
    ('restaurant-manager','restaurant','floor',       ARRAY['view','create','edit','approve','export','print']),
    ('restaurant-manager','restaurant','orders',      ARRAY['view','create','edit','approve','export','print']),
    ('restaurant-manager','restaurant','kds',         ARRAY['view','create','edit']),
    ('restaurant-manager','restaurant','menu',        ARRAY['view','create','edit']),
    ('restaurant-manager','restaurant','shifts',      ARRAY['view','create','edit','approve']),
    ('restaurant-manager','restaurant','reports',     ARRAY['view','export','print']),
    ('restaurant-manager','restaurant','approvals',   ARRAY['view','approve','reject']),
    ('restaurant-manager','restaurant','requisitions',ARRAY['view','create','edit','approve']),
    ('restaurant-manager','restaurant','wastage',     ARRAY['view','create','edit','approve']),
    ('restaurant-manager','restaurant','complimentary', ARRAY['view','create','approve']),
    ('restaurant-manager','kitchen','overview',       ARRAY['view']),
    ('restaurant-manager','kitchen','queue',          ARRAY['view']),
    ('restaurant-manager','stores','overview',        ARRAY['view']),
    ('restaurant-manager','marketing','crm-customers',ARRAY['view']),
    ('restaurant-manager','ai','insights',            ARRAY['view']),

    -- Coffee Station Supervisor — station authority plus requisitions
    ('coffee-station-supervisor','restaurant','overview',    ARRAY['view','create','edit','export']),
    ('coffee-station-supervisor','restaurant','floor',       ARRAY['view','create','edit','export']),
    ('coffee-station-supervisor','restaurant','orders',      ARRAY['view','create','edit','export']),
    ('coffee-station-supervisor','restaurant','kds',         ARRAY['view','create','edit']),
    ('coffee-station-supervisor','restaurant','menu',        ARRAY['view']),
    ('coffee-station-supervisor','restaurant','shifts',      ARRAY['view','create','edit','export']),
    ('coffee-station-supervisor','restaurant','reports',     ARRAY['view','export']),
    ('coffee-station-supervisor','restaurant','requisitions',ARRAY['view','create','edit','export']),
    ('coffee-station-supervisor','restaurant','wastage',     ARRAY['view','create','edit','export']),
    ('coffee-station-supervisor','stores','overview',        ARRAY['view']),
    ('coffee-station-supervisor','ai','insights',            ARRAY['view']),

    -- Waiter / Waitress — own service work only
    ('waiter','restaurant','overview', ARRAY['view','create','edit']),
    ('waiter','restaurant','floor',    ARRAY['view','create','edit']),
    ('waiter','restaurant','orders',   ARRAY['view','create','edit']),
    ('waiter','restaurant','kds',      ARRAY['view']),
    ('waiter','restaurant','shifts',   ARRAY['view','create','edit']),
    ('waiter','restaurant','wastage',  ARRAY['view','create']),

    -- Barista — coffee station work only
    ('barista','restaurant','overview',ARRAY['view','create','edit']),
    ('barista','restaurant','floor',   ARRAY['view','create','edit']),
    ('barista','restaurant','orders',  ARRAY['view','create','edit']),
    ('barista','restaurant','kds',     ARRAY['view']),
    ('barista','restaurant','shifts',  ARRAY['view','create','edit']),
    ('barista','restaurant','wastage', ARRAY['view','create'])
)
INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT s.role_key, s.module, s.feature, a
FROM spec s, unnest(s.actions) AS a
WHERE EXISTS (
  SELECT 1 FROM public.permissions p
  WHERE p.module = s.module AND p.feature = s.feature AND p.action = a
);

-- 4. Department requisition raised by a non-Stores department ---------------
CREATE OR REPLACE FUNCTION public.neo_department_requisition_create(
  _branch uuid,
  _lines jsonb,
  _department uuid DEFAULT NULL,
  _required_date date DEFAULT NULL,
  _priority text DEFAULT 'normal',
  _reason text DEFAULT NULL,
  _destination uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_org uuid := current_org_id();
  v_req uuid;
  v_line jsonb;
  v_count int := 0;
  v_number text;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT (has_permission('restaurant','requisitions.create')
          OR has_permission('restaurant','create')
          OR has_permission('stores','create')
          OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to raise a requisition';
  END IF;
  IF _branch IS NULL OR NOT (_branch = ANY (current_branch_ids())) THEN
    RAISE EXCEPTION 'Requisitions may only be raised for your own property';
  END IF;
  IF _lines IS NULL OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'Add at least one item';
  END IF;

  v_number := 'REQ-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''), 1, 5));

  INSERT INTO public.internal_requisitions
    (organization_id, branch_id, request_number, department_id, destination_location_id,
     fulfilment_model, requested_by, request_date, required_date, priority, reason, status)
  VALUES (v_org, _branch, v_number, _department, _destination,
          'stores-issue', auth.uid(), current_date, _required_date,
          coalesce(_priority, 'normal'), _reason, 'pending-supervisor')
  RETURNING id INTO v_req;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    IF coalesce((v_line->>'quantity_requested')::numeric, 0) <= 0 THEN CONTINUE; END IF;
    INSERT INTO public.internal_requisition_lines
      (organization_id, requisition_id, stock_item_id, description, unit, quantity_requested, notes)
    VALUES (v_org, v_req,
            nullif(v_line->>'stock_item_id','')::uuid,
            nullif(v_line->>'description',''),
            nullif(v_line->>'unit',''),
            (v_line->>'quantity_requested')::numeric,
            nullif(v_line->>'notes',''));
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN RAISE EXCEPTION 'Add at least one item with a quantity'; END IF;

  RETURN jsonb_build_object('ok', true, 'requisition_id', v_req,
                            'request_number', v_number, 'lines', v_count);
END $$;

-- Requesting departments must be able to confirm what Stores issued.
CREATE OR REPLACE FUNCTION public.req_confirm_receipt(_requisition uuid, _lines jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := current_org_id(); v_req record; v_line jsonb; v_row record;
  v_qty numeric; v_disc numeric; v_any_disc boolean := false; v_all boolean;
BEGIN
  SELECT * INTO v_req FROM internal_requisitions WHERE id=_requisition AND organization_id=v_org FOR UPDATE;
  IF v_req IS NULL THEN RAISE EXCEPTION 'Unknown requisition'; END IF;
  IF NOT (has_permission('stores','edit') OR has_permission('housekeeping','edit') OR has_permission('maintenance','edit')
          OR has_permission('laundry','edit') OR has_permission('restaurant','requisitions.edit')
          OR has_permission('kitchen','edit') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to confirm receipt';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    SELECT * INTO v_row FROM internal_requisition_lines WHERE id=(v_line->>'id')::uuid AND requisition_id=_requisition FOR UPDATE;
    CONTINUE WHEN v_row IS NULL;
    v_qty := COALESCE((v_line->>'quantity_received')::numeric, 0);
    v_disc := v_row.quantity_issued - (v_row.quantity_received + v_qty);
    IF v_disc <> 0 THEN v_any_disc := true; END IF;

    INSERT INTO requisition_receipt_confirmations (organization_id, requisition_id, line_id, quantity_received,
      condition, discrepancy, discrepancy_notes, received_by, resolved)
    VALUES (v_org, _requisition, v_row.id, v_qty, v_line->>'condition', v_disc, v_line->>'notes', auth.uid(), v_disc = 0);

    UPDATE internal_requisition_lines SET quantity_received = quantity_received + v_qty WHERE id=v_row.id;
  END LOOP;

  SELECT NOT EXISTS (SELECT 1 FROM internal_requisition_lines
                      WHERE requisition_id=_requisition AND quantity_received < quantity_issued)
    INTO v_all;

  UPDATE internal_requisitions
     SET status = CASE WHEN v_all AND NOT v_any_disc THEN 'received' ELSE 'partially-received' END,
         received_by = auth.uid(), received_at = now()
   WHERE id=_requisition;

  RETURN jsonb_build_object('ok', true, 'discrepancy', v_any_disc);
END $function$;

-- 5. Wastage: record and review --------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_waste_record(
  _branch uuid,
  _item text,
  _quantity numeric,
  _unit text DEFAULT NULL,
  _category text DEFAULT 'preparation',
  _reason text DEFAULT NULL,
  _estimated_cost numeric DEFAULT NULL,
  _station uuid DEFAULT NULL,
  _menu_item uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_org uuid := current_org_id();
  v_id uuid;
  v_number text;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT (has_permission('restaurant','wastage.create')
          OR has_permission('kitchen','waste.record')
          OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to record wastage';
  END IF;
  IF _branch IS NULL OR NOT (_branch = ANY (current_branch_ids())) THEN
    RAISE EXCEPTION 'Wastage may only be recorded for your own property';
  END IF;
  IF coalesce(_quantity, 0) <= 0 THEN RAISE EXCEPTION 'Enter a quantity greater than zero'; END IF;
  IF coalesce(trim(_item), '') = '' THEN RAISE EXCEPTION 'Name the item wasted'; END IF;
  IF coalesce(trim(_reason), '') = '' THEN RAISE EXCEPTION 'A written reason is required'; END IF;

  v_number := 'WST-' || to_char(now(), 'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''), 1, 5));

  INSERT INTO public.waste_records
    (organization_id, branch_id, station_id, waste_number, occurred_at, ingredient_name,
     menu_item_id, quantity, unit, estimated_cost, category, reason, status, recorded_by)
  VALUES (v_org, _branch, _station, v_number, now(), trim(_item),
          _menu_item, _quantity, _unit, _estimated_cost,
          coalesce(_category, 'preparation'), _reason, 'pending', auth.uid())
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'waste_id', v_id, 'waste_number', v_number);
END $$;

CREATE OR REPLACE FUNCTION public.neo_waste_review(
  _waste uuid,
  _decision text,
  _notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_org uuid := current_org_id();
  v_row record;
  v_status text;
BEGIN
  IF _decision NOT IN ('approve','reject') THEN RAISE EXCEPTION 'Unknown decision'; END IF;
  IF NOT (has_permission('restaurant','wastage.approve')
          OR has_permission('kitchen','waste.approve')
          OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to review wastage';
  END IF;

  SELECT * INTO v_row FROM public.waste_records
   WHERE id = _waste AND organization_id = v_org FOR UPDATE;
  IF v_row IS NULL THEN RAISE EXCEPTION 'Unknown wastage record'; END IF;
  IF v_row.branch_id IS NOT NULL AND NOT (v_row.branch_id = ANY (current_branch_ids())) THEN
    RAISE EXCEPTION 'Outside your property scope';
  END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'Already reviewed'; END IF;
  IF v_row.recorded_by = auth.uid() AND NOT is_org_admin() THEN
    RAISE EXCEPTION 'You cannot review wastage you recorded yourself';
  END IF;

  v_status := CASE WHEN _decision = 'approve' THEN 'approved' ELSE 'rejected' END;

  UPDATE public.waste_records
     SET status = v_status, reviewed_by = auth.uid(), reviewed_at = now(),
         reason = CASE WHEN coalesce(trim(_notes),'') = '' THEN reason
                       ELSE reason || ' | review: ' || _notes END,
         updated_at = now()
   WHERE id = _waste;

  INSERT INTO public.waste_approval_actions (organization_id, waste_record_id, action, notes, acted_by)
  SELECT v_org, _waste, v_status, _notes, auth.uid()
  WHERE EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='waste_approval_actions' AND column_name='waste_record_id');

  RETURN jsonb_build_object('ok', true, 'status', v_status);
END $$;

REVOKE ALL ON FUNCTION public.neo_department_requisition_create(uuid, jsonb, uuid, date, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neo_waste_record(uuid, text, numeric, text, text, text, numeric, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.neo_waste_review(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.req_confirm_receipt(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_department_requisition_create(uuid, jsonb, uuid, date, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_waste_record(uuid, text, numeric, text, text, text, numeric, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_waste_review(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.req_confirm_receipt(uuid, jsonb) TO authenticated;

-- 6. Recompile role access for every tenant --------------------------------
DO $$
DECLARE o uuid;
BEGIN
  FOR o IN SELECT id FROM public.organizations LOOP
    PERFORM public.neo_apply_feature_templates(o);
  END LOOP;
END $$;