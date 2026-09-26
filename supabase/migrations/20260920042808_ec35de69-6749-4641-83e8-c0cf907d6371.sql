ALTER TABLE public.procurement_matching_policies
  ADD COLUMN IF NOT EXISTS cost_of_sales_account_code text NOT NULL DEFAULT '5000';

CREATE OR REPLACE FUNCTION public.neo_stock_average_cost(_item uuid, _location uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
           WHEN sum(sm.quantity) > 0 AND sum(coalesce(sm.value,0)) > 0
             THEN round(sum(coalesce(sm.value,0)) / sum(sm.quantity), 6)
           ELSE NULL
         END
  FROM public.stock_movements sm
  WHERE sm.stock_item_id = _item
    AND sm.location_id = _location
    AND sm.organization_id = public.current_org_id();
$$;

REVOKE ALL ON FUNCTION public.neo_stock_average_cost(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_stock_average_cost(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_matching_policy(_org uuid, _branch uuid DEFAULT NULL::uuid)
RETURNS public.procurement_matching_policies
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p public.procurement_matching_policies;
  v_org uuid;
BEGIN
  -- Trusted context: signed-in callers are pinned to their active workspace.
  IF auth.uid() IS NOT NULL THEN
    v_org := public.neo_assert_tenant_context(_org);
  ELSE
    v_org := _org;
  END IF;

  SELECT * INTO p FROM public.procurement_matching_policies
   WHERE organization_id = v_org AND branch_id = _branch;
  IF p.id IS NULL THEN
    SELECT * INTO p FROM public.procurement_matching_policies
     WHERE organization_id = v_org AND branch_id IS NULL;
  END IF;
  IF p.id IS NULL THEN
    p.organization_id := v_org;
    p.branch_id := NULL;
    p.match_mode := 'three-way';
    p.price_tolerance_pct := 2;
    p.price_tolerance_amount := 0;
    p.quantity_tolerance_pct := 0;
    p.inventory_account_code := '1070';
    p.grni_account_code := '2015';
    p.payable_account_code := '2010';
    p.tax_input_account_code := '1085';
    p.opening_equity_account_code := '3020';
    p.expense_account_code := '6090';
    p.cost_of_sales_account_code := '5000';
  END IF;
  p.cost_of_sales_account_code := coalesce(p.cost_of_sales_account_code, '5000');
  RETURN p;
END
$$;

CREATE OR REPLACE FUNCTION public.neo_stores_issue(
  _location uuid, _lines jsonb, _attempt uuid,
  _department uuid DEFAULT NULL::uuid, _reason text DEFAULT NULL::text,
  _direction text DEFAULT 'issue'::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _org uuid := public.current_org_id(); _prior jsonb; _line jsonb;
        _sign numeric; _count integer := 0; _idx integer := 0; _qty numeric;
        _loc record; _movements uuid[] := '{}';
        _cost numeric; _value numeric := 0; _unvalued integer := 0;
        _pol public.procurement_matching_policies; _gl jsonb; _journal uuid;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE='42501'; END IF;
  IF _attempt IS NULL THEN RAISE EXCEPTION 'attempt_key_required' USING ERRCODE='22023'; END IF;
  IF lower(coalesce(_direction,'issue')) NOT IN ('issue','return') THEN
    RAISE EXCEPTION 'invalid_direction' USING ERRCODE='22023';
  END IF;

  SELECT result INTO _prior FROM public.procurement_attempts
   WHERE organization_id=_org AND action='stores.'||lower(_direction) AND attempt_key=_attempt;
  IF _prior IS NOT NULL THEN RETURN _prior || jsonb_build_object('replayed', true); END IF;

  IF NOT (public.has_permission('stores','issues.create')
          OR public.has_permission('stores','requisition.issue')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501';
  END IF;

  SELECT * INTO _loc FROM public.stock_locations WHERE id=_location AND organization_id=_org AND active;
  IF _loc IS NULL THEN RAISE EXCEPTION 'store_location_required' USING ERRCODE='22023'; END IF;
  IF NOT public.neo_branch_in_scope(_loc.branch_id) THEN RAISE EXCEPTION 'branch_out_of_scope' USING ERRCODE='42501'; END IF;
  IF nullif(btrim(coalesce(_reason,'')),'') IS NULL THEN RAISE EXCEPTION 'reason_required' USING ERRCODE='22023'; END IF;

  _sign := CASE WHEN lower(_direction)='issue' THEN -1 ELSE 1 END;

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    _idx := _idx + 1;
    _qty := COALESCE((_line->>'quantity')::numeric, 0);
    IF _qty <= 0 THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.stock_items si
                    WHERE si.id=(_line->>'stock_item_id')::uuid AND si.organization_id=_org) THEN
      RAISE EXCEPTION 'unknown_stock_item' USING ERRCODE='22023';
    END IF;

    -- Value the movement from recorded purchase cost only; never invent a cost.
    _cost := nullif((_line->>'unit_cost')::numeric, 0);
    IF _cost IS NULL THEN
      _cost := public.neo_stock_average_cost((_line->>'stock_item_id')::uuid, _location);
    END IF;
    IF _cost IS NULL OR _cost <= 0 THEN
      _unvalued := _unvalued + 1;
    ELSE
      _value := _value + round(_qty * _cost, 2);
    END IF;

    _movements := _movements || public.inventory_apply_movement(
      (_line->>'stock_item_id')::uuid, _location, _sign * _qty, nullif(_line->>'unit',''),
      CASE WHEN _sign < 0 THEN 'issue' ELSE 'return' END, _cost,
      'store_'||lower(_direction), _attempt, _reason,
      'store:'||lower(_direction)||':'||_attempt::text||':'||_idx::text, NULL, NULL);
    _count := _count + 1;
  END LOOP;

  IF _count = 0 THEN RAISE EXCEPTION 'no_lines' USING ERRCODE='22023'; END IF;

  -- Consumption accounting: issues release inventory value into cost of sales,
  -- returns put it back. Unvalued lines are reported, not estimated.
  IF round(_value, 2) > 0 THEN
    _pol := public.neo_matching_policy(_org, _loc.branch_id);
    PERFORM public.neo_finance_ensure_account(_org, _pol.inventory_account_code, 'Inventory', 'asset', 'Current Assets');
    PERFORM public.neo_finance_ensure_account(_org, _pol.cost_of_sales_account_code, 'Cost of Sales', 'cost_of_sales', 'Cost of Sales');
    IF _sign < 0 THEN
      _gl := jsonb_build_array(
        jsonb_build_object('code', _pol.cost_of_sales_account_code, 'debit', round(_value,2), 'description', 'Stock issued to operations'),
        jsonb_build_object('code', _pol.inventory_account_code, 'credit', round(_value,2), 'description', 'Inventory released on issue'));
    ELSE
      _gl := jsonb_build_array(
        jsonb_build_object('code', _pol.inventory_account_code, 'debit', round(_value,2), 'description', 'Inventory restored on return'),
        jsonb_build_object('code', _pol.cost_of_sales_account_code, 'credit', round(_value,2), 'description', 'Stock returned from operations'));
    END IF;
    _journal := (public.neo_gl_post(_org, _loc.branch_id, 'stores', 'stock_'||lower(_direction), _attempt,
                   'consumption', CURRENT_DATE, 'KES',
                   'Stock '||lower(_direction)||' '||_attempt::text, _gl)->>'journal_id')::uuid;
  END IF;

  _prior := jsonb_build_object('ok',true,'direction',lower(_direction),'lines',_count,
              'location_id',_location,'department_id',_department,'movements',to_jsonb(_movements),
              'value', round(_value,2), 'unvalued_lines', _unvalued, 'journal_id', _journal);
  INSERT INTO public.procurement_attempts (organization_id, action, attempt_key, record_id, result)
  VALUES (_org,'stores.'||lower(_direction),_attempt,_location,_prior);
  RETURN _prior;
END
$$;
