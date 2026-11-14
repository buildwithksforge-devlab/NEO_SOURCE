BEGIN;
DO $guard$ BEGIN IF md5(pg_get_functiondef(to_regprocedure('public.neo_supplier_invoice_accept(uuid,text)'))) IS DISTINCT FROM 'c0d761ed24f0d9c51d76bf9673dbb0e7' THEN RAISE EXCEPTION 'Installed definition differs: neo_supplier_invoice_accept'; END IF; END $guard$;
DO $guard$ BEGIN IF md5(pg_get_functiondef(to_regprocedure('public.inventory_post_stock_take(uuid)'))) IS DISTINCT FROM '320ae11b896a340f9969bc7064ac3c5a' THEN RAISE EXCEPTION 'Installed definition differs: inventory_post_stock_take'; END IF; END $guard$;
DO $guard$ BEGIN IF md5(pg_get_functiondef(to_regprocedure('public.neo_stores_issue(uuid,jsonb,uuid,uuid,text,text)'))) IS DISTINCT FROM '2cde096a47ff1adcd880fbc36d2b9352' THEN RAISE EXCEPTION 'Installed definition differs: neo_stores_issue'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.neo_supplier_invoice_accept(_invoice uuid, _reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := current_org_id();
  inv record; pol public.procurement_matching_policies; l record;
  v_net numeric; v_tax numeric; v_lines jsonb := '[]'::jsonb; v_res jsonb; v_debit_code text; _cur text;
BEGIN
  IF NOT (has_permission('finance','approve') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to accept supplier invoices';
  END IF;
  SELECT * INTO inv FROM supplier_invoices WHERE id = _invoice AND organization_id = v_org FOR UPDATE;
  IF inv IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF v_org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF auth.uid() IS NULL OR public.neo_branch_in_scope(inv.branch_id) IS NOT TRUE THEN RAISE EXCEPTION 'Invoice outside authorized property scope' USING ERRCODE='42501'; END IF;
    IF inv.amount IS NULL OR inv.amount<=0 OR inv.amount::text IN ('NaN','Infinity','-Infinity') OR inv.tax_amount IS NULL OR inv.tax_amount<0 OR inv.tax_amount>inv.amount OR inv.tax_amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Invoice amount or tax is incomplete or non-finite'; END IF;
    IF inv.journal_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.journal_entries j WHERE j.id=inv.journal_id AND j.organization_id=v_org AND j.branch_id IS NOT DISTINCT FROM inv.branch_id AND j.status='posted') THEN RAISE EXCEPTION 'Saved invoice journal is not confirmed posted; review before retrying'; END IF;
  END IF;
  IF inv.journal_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_posted', true, 'journal_id', inv.journal_id);
  END IF;
  IF inv.match_status = 'pending' OR v_org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    PERFORM public.proc_three_way_match(_invoice);
    SELECT * INTO inv FROM supplier_invoices WHERE id = _invoice;
  END IF;
  IF inv.match_status = 'held' AND COALESCE(btrim(_reason),'') = '' THEN
    RAISE EXCEPTION 'This invoice is on hold. A written override reason is required.';
  END IF;

  pol := public.neo_matching_policy(v_org, inv.branch_id);
  v_tax := round(COALESCE(inv.tax_amount,0), 2);
  v_net := round(COALESCE(inv.amount,0) - v_tax, 2);
  IF v_net + v_tax <= 0 THEN RAISE EXCEPTION 'Invoice has no value to post'; END IF;

  v_debit_code := CASE WHEN inv.order_id IS NULL THEN pol.expense_account_code ELSE pol.grni_account_code END;
  PERFORM public.neo_finance_ensure_account(v_org, v_debit_code,
    CASE WHEN inv.order_id IS NULL THEN 'Other Operating Expenses' ELSE 'Goods Received Not Invoiced' END,
    CASE WHEN inv.order_id IS NULL THEN 'operating_expense' ELSE 'liability' END,
    CASE WHEN inv.order_id IS NULL THEN 'Operating Expenses' ELSE 'Payables' END);
  PERFORM public.neo_finance_ensure_account(v_org, pol.payable_account_code, 'Accounts Payable', 'liability', 'Payables');

  v_lines := v_lines || jsonb_build_object('code', v_debit_code, 'debit', v_net,
    'description', CASE WHEN inv.order_id IS NULL THEN 'Non-order supplier invoice' ELSE 'Clear goods received not invoiced' END);
  IF v_tax > 0 THEN
    PERFORM public.neo_finance_ensure_account(v_org, pol.tax_input_account_code, 'VAT Input (Recoverable)', 'asset', 'Tax');
    v_lines := v_lines || jsonb_build_object('code', pol.tax_input_account_code, 'debit', v_tax, 'description', 'Recoverable input tax');
  END IF;
  v_lines := v_lines || jsonb_build_object('code', pol.payable_account_code, 'credit', round(v_net + v_tax,2), 'description', 'Supplier payable');

  _cur:=CASE WHEN v_org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN public.neo_fact_currency(v_org,inv.branch_id) ELSE 'KES' END;
  IF nullif(btrim(_cur),'') IS NULL THEN RAISE EXCEPTION 'Invoice property currency could not be verified'; END IF;
  v_res := public.neo_gl_post(v_org, inv.branch_id, 'procurement', 'supplier_invoice', _invoice, 'payable',
    COALESCE(inv.invoice_date, CURRENT_DATE), _cur,
    'Supplier invoice ' || inv.invoice_number, v_lines);

  IF v_org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND (coalesce((v_res->>'ok')::boolean,false) IS NOT TRUE OR nullif(v_res->>'journal_id','') IS NULL OR NOT EXISTS(SELECT 1 FROM public.journal_entries j WHERE j.id=nullif(v_res->>'journal_id','')::uuid AND j.organization_id=v_org AND j.branch_id IS NOT DISTINCT FROM inv.branch_id AND j.status='posted')) THEN RAISE EXCEPTION 'Supplier invoice acceptance requires its successfully posted journal: %',v_res USING ERRCODE='23514'; END IF;

  UPDATE supplier_invoices
     SET journal_id = (v_res->>'journal_id')::uuid,
         status = 'approved',
         match_status = CASE WHEN match_status = 'held' THEN 'approved-with-variance' ELSE match_status END,
         approved_by = auth.uid(), approved_at = now(),
         notes = COALESCE(notes,'') || CASE WHEN COALESCE(btrim(_reason),'') = '' THEN '' ELSE E'\nAccepted: ' || _reason END
   WHERE id = _invoice;

  -- Reflect what has been invoiced back onto the purchase order trail.
  IF inv.order_id IS NOT NULL THEN
    FOR l IN SELECT * FROM supplier_invoice_lines WHERE supplier_invoice_id = _invoice LOOP
      UPDATE purchase_order_lines pl
         SET invoiced_quantity = COALESCE(pl.invoiced_quantity,0) + l.quantity
       WHERE pl.order_id = inv.order_id
         AND (pl.stock_item_id = l.stock_item_id
              OR (l.stock_item_id IS NULL AND lower(pl.description) = lower(COALESCE(l.description,''))));
    END LOOP;
    UPDATE purchase_orders
       SET invoiced_amount = COALESCE(invoiced_amount,0) + round(COALESCE(inv.amount,0),2),
           status = CASE WHEN status IN ('closed','cancelled','voided') THEN status
                         WHEN COALESCE(invoiced_amount,0) + COALESCE(inv.amount,0) >= COALESCE(total_amount,0) THEN 'fully-invoiced'
                         ELSE 'partially-invoiced' END
     WHERE id = inv.order_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'journal_id', v_res->>'journal_id', 'amount', round(v_net + v_tax,2));
END $function$
;
CREATE OR REPLACE FUNCTION public.inventory_post_stock_take(_take uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := current_org_id();
  s record;
  l record;
  v_value numeric := 0;
BEGIN
  IF NOT has_permission('inventory','stocktake.manage') THEN RAISE EXCEPTION 'Not permitted to close stock takes'; END IF;
  SELECT * INTO s FROM stock_takes WHERE id = _take AND organization_id = v_org FOR UPDATE;
  IF s IS NULL THEN RAISE EXCEPTION 'Stock take not found'; END IF;
  IF v_org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND NOT EXISTS(SELECT 1 FROM public.stock_locations sl WHERE sl.id=s.location_id AND sl.organization_id=v_org AND public.neo_branch_in_scope(sl.branch_id) IS TRUE) THEN RAISE EXCEPTION 'Stock take outside authorized property scope' USING ERRCODE='42501'; END IF;
  IF s.status = 'closed' THEN RETURN jsonb_build_object('status','already-closed'); END IF;

  IF v_org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    PERFORM 1 FROM public.stock_take_lines WHERE stock_take_id=_take FOR UPDATE;
    IF NOT EXISTS(SELECT 1 FROM public.stock_take_lines WHERE stock_take_id=_take) THEN RAISE EXCEPTION 'A stock take needs counted lines before closure'; END IF;
    IF EXISTS(SELECT 1 FROM public.stock_take_lines WHERE stock_take_id=_take AND (counted_quantity IS NULL OR counted_quantity<0 OR counted_quantity::text IN ('NaN','Infinity','-Infinity') OR system_quantity IS NULL OR system_quantity::text IN ('NaN','Infinity','-Infinity') OR unit_cost<0 OR unit_cost::text IN ('NaN','Infinity','-Infinity'))) THEN RAISE EXCEPTION 'Complete every stock count with finite nonnegative counted quantities before closing'; END IF;
  END IF;
  FOR l IN SELECT * FROM stock_take_lines WHERE stock_take_id = _take AND counted_quantity IS NOT NULL LOOP
    UPDATE stock_take_lines SET variance = l.counted_quantity - l.system_quantity WHERE id = l.id;
    IF l.counted_quantity <> l.system_quantity THEN
      PERFORM inventory_apply_movement(l.stock_item_id, s.location_id, l.counted_quantity - l.system_quantity, l.unit,
        'stock-take', NULL, 'stock_take', _take, 'Stock count variance',
        'stocktake:' || _take::text || ':' || l.id::text, NULL, NULL);
      v_value := v_value + ((l.counted_quantity - l.system_quantity) * COALESCE(NULLIF(l.unit_cost, 0), 0));
    END IF;
  END LOOP;

  UPDATE stock_takes SET status = 'closed', completed_at = now(), variance_value = v_value, approved_by = auth.uid() WHERE id = _take;
  RETURN jsonb_build_object('status','closed','variance',v_value);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.neo_stores_issue(_location uuid, _lines jsonb, _attempt uuid, _department uuid DEFAULT NULL::uuid, _reason text DEFAULT NULL::text, _direction text DEFAULT 'issue'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF NOT (public.has_permission('stores','issues.create') OR public.has_permission('stores','requisition.issue') OR public.is_org_admin()) THEN RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.stock_locations WHERE id=_location AND organization_id=_org AND coalesce(public.neo_branch_in_scope(branch_id),false)) THEN RAISE EXCEPTION 'store_out_of_scope' USING ERRCODE='42501'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('store:'||_org::text||':'||lower(_direction)||':'||_attempt::text,0));
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

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF _lines IS NULL OR jsonb_typeof(_lines)<>'array' THEN RAISE EXCEPTION 'stock_lines_required'; END IF;
    IF jsonb_array_length(_lines)=0 THEN RAISE EXCEPTION 'stock_lines_required'; END IF;
    FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
      _qty:=(_line->>'quantity')::numeric;
      IF _qty IS NULL OR _qty<=0 OR _qty::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'stock_quantity_must_be_finite_positive' USING ERRCODE='22023'; END IF;
      IF (_line->>'unit_cost')::numeric<0 OR ((_line->>'unit_cost')::numeric)::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'stock_cost_must_be_finite_nonnegative' USING ERRCODE='22023'; END IF;
    END LOOP;
  END IF;
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
    IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND (_cost<0 OR _cost::text IN ('NaN','Infinity','-Infinity')) THEN RAISE EXCEPTION 'stock_cost_must_be_finite_nonnegative' USING ERRCODE='22023'; END IF;
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
    IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND (_movements[array_length(_movements,1)] IS NULL) THEN RAISE EXCEPTION 'stock_movement_not_saved'; END IF;
    _count := _count + 1;
  END LOOP;

  IF _count = 0 THEN RAISE EXCEPTION 'no_lines' USING ERRCODE='22023'; END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF (SELECT count(*) FROM public.stock_movements m WHERE m.organization_id=_org AND m.id=ANY(_movements))<>_count OR EXISTS(SELECT 1 FROM public.stock_movements m WHERE m.organization_id=_org AND m.id=ANY(_movements) AND (m.quantity IS NULL OR m.quantity::text IN ('NaN','Infinity','-Infinity') OR m.unit_cost<0 OR m.unit_cost::text IN ('NaN','Infinity','-Infinity') OR m.value::text IN ('NaN','Infinity','-Infinity'))) THEN RAISE EXCEPTION 'Saved issue or return valuation needs review'; END IF;
    -- Movement values already use the converted base quantity and actual cost.
    SELECT coalesce(sum(abs(m.value)),0),count(*) FILTER(WHERE m.unit_cost IS NULL OR m.unit_cost<=0) INTO _value,_unvalued FROM public.stock_movements m WHERE m.organization_id=_org AND m.id=ANY(_movements);
    _value:=round(_value,2);
  END IF;

  IF round(_value, 2) > 0 THEN
    _pol := public.neo_matching_policy(_org, _loc.branch_id);
    PERFORM public.neo_finance_ensure_account(_org, _pol.inventory_account_code, 'Inventory', 'asset', 'Current Assets');
    PERFORM public.neo_finance_ensure_account(_org, _pol.cost_of_sales_account_code, 'Cost of Sales — Stores Issues', 'cost_of_sales', 'Cost of Sales');
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
$function$
;
NOTIFY pgrst,'reload schema';
COMMIT;

BEGIN READ ONLY;
WITH expected(signature,hash) AS (VALUES
('public.inventory_apply_movement(uuid,uuid,numeric,text,text,numeric,text,uuid,text,text,text,date)','3fabb15793d1c35b9619a82d79d2e5dd'),
('public.inventory_post_adjustment(uuid)','830763c76601ffc47289ab895ca8dae8'),
('public.inventory_post_receipt(uuid)','22e93cebfc2501c493350657695a4c86'),
('public.inventory_post_stock_take(uuid)','c86a9f663f490881ab11e3387c14a58d'),
('public.inventory_post_transfer(uuid)','562d697013ab14b8dc5aae480befc8a7'),
('public.neo_cash_shift_reconciliation(uuid)','e82fa3e0db81e5313b7429aae7249dde'),
('public.neo_grn_retry_accrual(uuid)','c81b26b48def2a7612cf6d4b57b0b292'),
('public.neo_grn_reverse(uuid,text)','12c447b9bc5b449d2e5110f3da6d082c'),
('public.neo_payment_schedule_release(uuid,text,uuid,text,date)','5d969e289408a400ffb473decc114556'),
('public.neo_procurement_order_close(uuid,text)','2f76e857ff00a1ee16e5f28727165a5e'),
('public.neo_stores_issue(uuid,jsonb,uuid,uuid,text,text)','2afdbba3ad8cb4852d3fdd65ff946ff7'),
('public.neo_stores_receive_goods(uuid,uuid,jsonb,uuid,text,text,text,text)','8da681dbdabc43053a2ea7f65206d909'),
('public.neo_supplier_invoice_accept(uuid,text)','4fde341f5b26b996ef967e8dc585a5c4'),
('public.neo_supplier_invoice_capture(jsonb)','758c1b024238b1082ecd2cac3dce2a15'),
('public.neo_supplier_payment_advance(uuid,text,text)','9ca13315484923834e9ffe5ca52b222e'),
('public.proc_document_trail(uuid)','19477bf364e4dbf1e0710cf6b72739c2'),
('public.proc_lpo_action(uuid,text,text)','4d87d1704e16980d995ea923def5b598'),
('public.proc_three_way_match(uuid)','35e8a205f2ebdd4b711b12754b8ef9a6'),
('public.req_issue(uuid,jsonb)','1fa9f5c79950d897495719060de1d938')
),checked AS (SELECT signature,coalesce(md5(pg_get_functiondef(to_regprocedure(signature)))=hash,false) AS matches FROM expected)
SELECT jsonb_build_object('diagnostic_version','supplier-count-valuation-install-v1','definitions_match',(SELECT bool_and(matches) FROM checked),'definition_checks',(SELECT jsonb_agg(to_jsonb(checked)) FROM checked),'scope','Three guarded routine corrections only: supplier invoice posted-journal evidence, complete stock counts and converted issue/return valuation. No payment, invoice approval, count closure, stock movement or historical rewrite is executed by installation. Wider operational acceptance remains open.') AS result;
COMMIT;
