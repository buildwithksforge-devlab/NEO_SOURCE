-- Five tested code-only repairs. Atomic: any definition drift rolls back the bundle.
BEGIN;

-- 95_APPLY_GL_REPLAY_EVIDENCE.sql
-- Code only: fixes future Savannah GL replay evidence. No historical journal is retried by installation.
-- Retain fin_post_journal and all existing execute privileges; legitimate posting blocks remain in force.

SET LOCAL search_path=public;
DO $guard$ BEGIN
 IF to_regprocedure('public.neo_gl_post(uuid,uuid,text,text,uuid,text,date,text,text,jsonb,uuid,uuid)') IS NULL OR
 md5(pg_get_functiondef(to_regprocedure('public.neo_gl_post(uuid,uuid,text,text,uuid,text,date,text,text,jsonb,uuid,uuid)'))) IS DISTINCT FROM '7dfd4e4a4589661155fb5d7bcd02adfa'
 THEN RAISE EXCEPTION 'GL replay definition differs; inspect deployed code first'; END IF;
 IF to_regprocedure('public.fin_post_journal(uuid)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.fin_post_journal(uuid)'))) IS DISTINCT FROM '4162e3e7a44d05a75389087945abe2b2'
 THEN RAISE EXCEPTION 'Retained journal posting engine differs; inspect deployed code first'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.neo_gl_post(_org uuid, _branch uuid, _module text, _source_type text, _source_id uuid, _posting_type text, _date date, _currency text, _desc text, _lines jsonb, _customer uuid DEFAULT NULL::uuid, _reverses uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE key text := _source_type || ':' || _source_id::text || ':' || _posting_type;
        j uuid; ln jsonb; i int := 0; td numeric := 0; tc numeric := 0; acct uuid;
        d numeric; c numeric; prior text; existing public.journal_entries;
BEGIN
  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF public.current_org_id() IS DISTINCT FROM _org OR NOT coalesce(public.neo_branch_in_scope(_branch),false) THEN
      RAISE EXCEPTION 'Posting is outside the current organization or property scope' USING ERRCODE='42501';
    END IF;
    IF _source_id IS NULL OR nullif(btrim(_source_type),'') IS NULL OR nullif(btrim(_posting_type),'') IS NULL THEN
      RAISE EXCEPTION 'Posting source and type are required' USING ERRCODE='22023';
    END IF;
    IF _lines IS NULL OR jsonb_typeof(_lines)<>'array' THEN RAISE EXCEPTION 'Posting lines must be an array'; END IF;
    IF jsonb_array_length(_lines)=0 THEN RAISE EXCEPTION 'nothing_to_post'; END IF;
    FOR ln IN SELECT * FROM jsonb_array_elements(_lines) LOOP
      d:=coalesce((ln->>'debit')::numeric,0);c:=coalesce((ln->>'credit')::numeric,0);
      IF d<0 OR c<0 OR d::text IN ('NaN','Infinity','-Infinity') OR c::text IN ('NaN','Infinity','-Infinity') OR (d>0 AND c>0) THEN
        RAISE EXCEPTION 'Posting amounts must be finite nonnegative and one-sided' USING ERRCODE='22023';
      END IF;
    END LOOP;
    PERFORM pg_advisory_xact_lock(hashtextextended('gl:'||_org::text||':'||key,0));
  END IF;
  SELECT id INTO j FROM public.journal_entries
   WHERE organization_id = _org
     AND (idempotency_key = key OR CASE WHEN _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN left(idempotency_key,length(key||':correction:'))=key||':correction:' ELSE idempotency_key LIKE key||':correction:%' END)
     AND reversed_by_journal_id IS NULL
   ORDER BY created_at DESC LIMIT 1;
  IF j IS NOT NULL THEN
    IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
      SELECT * INTO existing FROM public.journal_entries WHERE id=j FOR UPDATE;
      IF existing.branch_id IS DISTINCT FROM _branch OR existing.currency IS DISTINCT FROM coalesce(_currency,'KES')
         OR existing.accounting_date IS DISTINCT FROM _date
         OR existing.source_document_id IS DISTINCT FROM _source_id OR existing.source_document_type IS DISTINCT FROM _source_type||':'||_posting_type THEN
        RAISE EXCEPTION 'Existing journal source, property or currency differs';
      END IF;
      IF existing.status IS NULL OR existing.status NOT IN ('posted','draft','approved') THEN RAISE EXCEPTION 'Existing journal cannot be reused from status %',existing.status; END IF;
      SELECT coalesce(sum(debit),0),coalesce(sum(credit),0) INTO td,tc FROM public.journal_entry_lines WHERE journal_id=j;
      IF td<=0 OR td<>tc OR td::text IN ('NaN','Infinity','-Infinity') OR tc::text IN ('NaN','Infinity','-Infinity')
         OR EXISTS(SELECT 1 FROM public.journal_entry_lines l LEFT JOIN public.chart_of_accounts a ON a.id=l.account_id
             WHERE l.journal_id=j AND (l.organization_id IS DISTINCT FROM _org OR a.organization_id IS DISTINCT FROM _org
               OR l.debit IS NULL OR l.credit IS NULL OR l.debit<0 OR l.credit<0 OR (l.debit>0 AND l.credit>0))) THEN
        RAISE EXCEPTION 'Existing journal has invalid or unbalanced lines';
      END IF;
      IF existing.status='posted' THEN
        IF existing.total_debit IS DISTINCT FROM td OR existing.total_credit IS DISTINCT FROM tc THEN RAISE EXCEPTION 'Posted journal totals disagree with its lines'; END IF;
      ELSE
        IF EXISTS(WITH wanted AS (
          SELECT requested.value->>'code' AS code,sum(round(coalesce((requested.value->>'debit')::numeric,0),2)) AS d,sum(round(coalesce((requested.value->>'credit')::numeric,0),2)) AS c
          FROM jsonb_array_elements(_lines) AS requested(value) GROUP BY 1
        ), actual AS (
          SELECT a.code,sum(l.debit) AS d,sum(l.credit) AS c FROM public.journal_entry_lines l JOIN public.chart_of_accounts a ON a.id=l.account_id
          WHERE l.journal_id=j GROUP BY a.code
        ) SELECT 1 FROM wanted w FULL JOIN actual a ON a.code=w.code
          WHERE coalesce(w.d,0)<>coalesce(a.d,0) OR coalesce(w.c,0)<>coalesce(a.c,0)) THEN
          RAISE EXCEPTION 'Existing draft lines differ from the requested posting';
        END IF;
        prior:=coalesce(current_setting('neo.system_posting',true),'off');
        BEGIN
          PERFORM set_config('neo.system_posting','on',true);
          PERFORM public.fin_post_journal(j);
          PERFORM set_config('neo.system_posting',prior,true);
        EXCEPTION WHEN OTHERS THEN
          PERFORM set_config('neo.system_posting',prior,true);RAISE;
        END;
        IF NOT EXISTS(SELECT 1 FROM public.journal_entries WHERE id=j AND status='posted') THEN RAISE EXCEPTION 'Existing journal did not reach posted status'; END IF;
      END IF;
    END IF;
    RETURN jsonb_build_object('ok', true, 'journal_id', j, 'duplicate_prevented', true);
  END IF;
  IF EXISTS (SELECT 1 FROM public.journal_entries
             WHERE organization_id = _org AND idempotency_key = key
               AND reversed_by_journal_id IS NOT NULL) THEN
    key := key || ':correction:' || (1 + (SELECT count(*) FROM public.journal_entries
      WHERE organization_id = _org AND CASE WHEN _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN left(idempotency_key,length(key||':correction:'))=key||':correction:' ELSE idempotency_key LIKE key||':correction:%' END))::text;
  END IF;

  INSERT INTO public.journal_entries
    (organization_id, branch_id, journal_number, journal_type, accounting_date,
     period_id, source_module, source_document_type, source_document_id,
     idempotency_key, description, currency, status, created_by, reverses_journal_id)
  VALUES (_org, _branch, public.next_document_number('journal','JV',_branch),
          CASE WHEN _reverses IS NULL THEN 'automatic' ELSE 'reversal' END, _date,
          public.neo_gl_period(_org, _date), _module,
          _source_type || ':' || _posting_type, _source_id, key, _desc,
          coalesce(_currency,'KES'), 'draft', auth.uid(), _reverses)
  RETURNING id INTO j;

  FOR ln IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    d := round(coalesce((ln->>'debit')::numeric, 0), 2);
    c := round(coalesce((ln->>'credit')::numeric, 0), 2);
    CONTINUE WHEN d = 0 AND c = 0;
    acct := public.neo_gl_acct(_org, ln->>'code');
    IF acct IS NULL THEN
      RAISE EXCEPTION 'chart_of_accounts is missing postable account %', ln->>'code';
    END IF;
    i := i + 1;
    INSERT INTO public.journal_entry_lines
      (organization_id, journal_id, line_number, account_id, description, debit, credit,
       branch_id, customer_id)
    VALUES (_org, j, i, acct, coalesce(ln->>'description', _desc), d, c, _branch, _customer);
    td := td + d; tc := tc + c;
  END LOOP;

  IF i = 0 THEN RAISE EXCEPTION 'nothing_to_post'; END IF;
  IF round(td,2) <> round(tc,2) THEN
    RAISE EXCEPTION 'Journal does not balance: debits % vs credits %', td, tc;
  END IF;

  UPDATE public.journal_entries
     SET total_debit = round(td,2), total_credit = round(tc,2)
   WHERE id = j;

  -- Automatic module postings are system postings: the operational authority was
  -- already verified upstream, so the caller does not need manual journal rights.
  prior := coalesce(current_setting('neo.system_posting', true), 'off');
  PERFORM set_config('neo.system_posting', 'on', true);
  PERFORM public.fin_post_journal(j);
  PERFORM set_config('neo.system_posting', prior, true);
  RETURN jsonb_build_object('ok', true, 'journal_id', j, 'duplicate_prevented', false);
END;
$function$;


-- 97_APPLY_STOCK_COUNT_COMPLETENESS.sql
-- Code-only Savannah count submission repair; does not close, retry or adjust existing counts.

SET LOCAL search_path=public;
DO $guard$ BEGIN
 IF to_regprocedure('public.neo_stores_count_submit_variance(uuid,text)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.neo_stores_count_submit_variance(uuid,text)'))) IS DISTINCT FROM 'dad9a0e8f3d32a85a1a22cbde949d662'
 THEN RAISE EXCEPTION 'Stock-count submission definition differs; inspect installed code before repair'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.neo_stores_count_submit_variance(_take uuid, _notes text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_org uuid := current_org_id();
  s record; l record;
  v_adj uuid; v_lines int := 0; v_value numeric := 0; v_number text;
  v_invalid int := 0; v_counted int := 0; v_total int := 0;
BEGIN
  IF NOT (has_permission('stores','edit') OR has_permission('inventory','stocktake.manage') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to submit stock count variances';
  END IF;
  SELECT * INTO s FROM stock_takes WHERE id = _take AND organization_id = v_org FOR UPDATE;
  IF s IS NULL THEN RAISE EXCEPTION 'Stock take not found'; END IF;
  IF v_org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND NOT coalesce(public.neo_branch_in_scope(s.branch_id),false) THEN RAISE EXCEPTION 'Count is outside your property scope' USING ERRCODE='42501'; END IF;
  IF s.status IN ('closed','awaiting-approval') THEN
    RETURN jsonb_build_object('status', s.status, 'adjustment', NULL);
  END IF;

  IF v_org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF s.status IS NULL OR s.status NOT IN ('in-progress','open','counting') THEN RAISE EXCEPTION 'Count cannot be submitted from status %',s.status; END IF;
    -- Stabilize submitted line values for the whole submission transaction.
    PERFORM 1 FROM public.stock_take_lines WHERE stock_take_id=_take FOR UPDATE;
    IF EXISTS(SELECT 1 FROM public.stock_take_lines count_line WHERE count_line.stock_take_id=_take AND
       (count_line.organization_id IS DISTINCT FROM v_org OR count_line.counted_quantity IS NULL)) THEN
      RAISE EXCEPTION 'count_incomplete: every line must be counted in this workspace before submission' USING ERRCODE='23514';
    END IF;
    IF EXISTS(SELECT 1 FROM public.stock_take_lines count_line WHERE count_line.stock_take_id=_take AND
       (count_line.counted_quantity::text IN ('NaN','Infinity','-Infinity') OR count_line.system_quantity IS NULL OR count_line.system_quantity::text IN ('NaN','Infinity','-Infinity')
        OR count_line.unit_cost<0 OR count_line.unit_cost::text IN ('NaN','Infinity','-Infinity'))) THEN
      RAISE EXCEPTION 'count_line_invalid: count amounts must be finite and the snapshot must be present' USING ERRCODE='22023';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.stock_take_lines WHERE stock_take_id=_take) THEN
      RAISE EXCEPTION 'count_empty: no stock lines exist for this count' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT count(*), count(*) FILTER (WHERE counted_quantity IS NOT NULL),
         count(*) FILTER (WHERE counted_quantity < 0)
    INTO v_total, v_counted, v_invalid
    FROM stock_take_lines WHERE stock_take_id = _take;

  IF v_invalid > 0 THEN
    RAISE EXCEPTION 'count_line_invalid: % line(s) hold a negative physical count.', v_invalid
      USING HINT = 'Correct those lines before closing the count.';
  END IF;

  IF v_total > 0 AND v_counted = 0 THEN
    RAISE EXCEPTION 'count_not_started: no quantity has been counted on this count yet.'
      USING HINT = 'Record at least one counted quantity, or abandon the count.';
  END IF;

  UPDATE stock_take_lines
     SET variance = counted_quantity - COALESCE(system_quantity, 0)
   WHERE stock_take_id = _take AND counted_quantity IS NOT NULL;

  SELECT count(*) INTO v_lines FROM stock_take_lines
   WHERE stock_take_id = _take AND counted_quantity IS NOT NULL AND variance <> 0;

  IF v_lines = 0 THEN
    UPDATE stock_takes
       SET status = 'closed', completed_at = now(), variance_value = 0,
           counted_by = COALESCE(counted_by, auth.uid())
     WHERE id = _take;
    RETURN jsonb_build_object('status','closed','adjustment',NULL,'lines',0,'counted',v_counted,'total',v_total);
  END IF;

  BEGIN
    SELECT next_document_number('stock-adjustment') INTO v_number;
  EXCEPTION WHEN OTHERS THEN
    v_number := 'ADJ-' || to_char(now(), 'YYYYMMDDHH24MISS');
  END;

  INSERT INTO stock_adjustments (organization_id, branch_id, adjustment_number, location_id, reason, status, notes, requested_by)
  VALUES (v_org, s.branch_id, COALESCE(v_number, 'ADJ-' || to_char(now(),'YYYYMMDDHH24MISS')), s.location_id,
          'count-variance', 'pending',
          COALESCE(_notes, 'Variance from stock count ' || COALESCE(s.reference, _take::text)), auth.uid())
  RETURNING id INTO v_adj;

  FOR l IN SELECT * FROM stock_take_lines
            WHERE stock_take_id = _take AND counted_quantity IS NOT NULL AND variance <> 0 LOOP
    INSERT INTO stock_adjustment_lines (organization_id, adjustment_id, stock_item_id, quantity, unit, unit_cost, reason)
    VALUES (v_org, v_adj, l.stock_item_id, l.variance, l.unit, l.unit_cost,
            'Count variance: counted ' || l.counted_quantity || ' against system ' || COALESCE(l.system_quantity,0));
    v_value := v_value + abs(l.variance * COALESCE(NULLIF(l.unit_cost,0),0));
  END LOOP;

  UPDATE stock_adjustments SET total_value = v_value WHERE id = v_adj;
  UPDATE stock_takes SET status = 'awaiting-approval', completed_at = now(), variance_value = v_value,
                         counted_by = COALESCE(counted_by, auth.uid())
   WHERE id = _take;

  RETURN jsonb_build_object('status','awaiting-approval','adjustment',v_adj,'lines',v_lines,'value',v_value,
                            'counted',v_counted,'total',v_total);
END $$;


-- 99_APPLY_STORE_MOVEMENT_BOUNDARIES.sql
-- Code-only Savannah stock issue/return guard. Does not replay or alter historical movements.

SET LOCAL search_path=public;
DO $guard$ BEGIN
 IF to_regprocedure('public.neo_stores_issue(uuid,jsonb,uuid,uuid,text,text)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.neo_stores_issue(uuid,jsonb,uuid,uuid,text,text)'))) IS DISTINCT FROM '1cc09feff50c3b81fc68f45da1dd8ecf'
 THEN RAISE EXCEPTION 'Store issue/return definition differs; inspect installed code first'; END IF;
END $guard$;
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
$$;


-- 101_APPLY_POS_TILL_INTENT_SCOPE.sql
-- Code-only Savannah payment intent/till scope fix. No historical till, payment, order or journal is changed.

SET LOCAL search_path=public;
DO $guard$ BEGIN
 IF to_regprocedure('public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid)'))) IS DISTINCT FROM 'e3a09ce80f0bf557e4bfd9520c93b21c' THEN RAISE EXCEPTION 'POS payment engine differs; inspect installed code first'; END IF;
 IF to_regprocedure('public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid,jsonb)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid,jsonb)'))) IS DISTINCT FROM 'fe6d4802c4b7b16e939c53de4091ebf7' THEN RAISE EXCEPTION 'POS card metadata overload differs; inspect installed code first'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.pos_record_payment_attempt(_order_id uuid, _amount numeric, _method text, _tendered numeric DEFAULT NULL::numeric, _reference text DEFAULT NULL::text, _shift_id uuid DEFAULT NULL::uuid, _idempotency_key text DEFAULT NULL::text, _manual_confirm boolean DEFAULT false, _note text DEFAULT NULL::text, _account uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _o public.pos_orders;
  _existing public.pos_payments;
  _confirmed numeric := 0;
  _active numeric := 0;
  _balance numeric;
  _headroom numeric;
  _status text;
  _provider boolean;
  _needs_reference boolean;
  _change numeric := 0;
  _payment uuid;
  _shift public.pos_shifts;
  _receipt text;
  _settle jsonb;
  _acct uuid;
  _finance jsonb := jsonb_build_object('ok', true, 'reason', 'not_due');
  _key text := coalesce(nullif(_idempotency_key,''), 'pos-pay:' || _order_id::text || ':' || gen_random_uuid()::text);
BEGIN
  IF NOT public.neo_pos_can_take_payment() THEN
    RAISE EXCEPTION 'Not permitted to take payments';
  END IF;

  SELECT * INTO _existing FROM public.pos_payments
   WHERE organization_id = _org AND idempotency_key = _key;
  IF _existing.id IS NOT NULL THEN
    IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
      IF _existing.order_id IS DISTINCT FROM _order_id THEN RAISE EXCEPTION 'Payment intent belongs to a different order' USING ERRCODE='23514'; END IF;
      SELECT * INTO _o FROM public.pos_orders WHERE id=_existing.order_id AND organization_id=_org FOR UPDATE;
      IF _o.id IS NULL OR NOT coalesce(public.neo_branch_in_scope(_o.branch_id),false) THEN RAISE EXCEPTION 'Payment intent belongs to a property outside your access' USING ERRCODE='42501'; END IF;
      IF _existing.branch_id IS DISTINCT FROM _o.branch_id THEN RAISE EXCEPTION 'Payment intent has inconsistent property links' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN jsonb_build_object('payment_id', _existing.id, 'status', _existing.status, 'duplicate', true,
                              'receipt_number', _existing.receipt_number)
        || public.pos_reconcile_settlement_internal(_existing.order_id);
  END IF;

  SELECT * INTO _o FROM public.pos_orders WHERE id = _order_id AND organization_id = _org FOR UPDATE;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF NOT public.neo_branch_in_scope(_o.branch_id) THEN
    RAISE EXCEPTION 'That bill belongs to a property outside your access';
  END IF;
  IF _o.status IN ('closed','cancelled','voided','charged-to-room') THEN
    RAISE EXCEPTION 'Bill is % and cannot take further payment', _o.status;
  END IF;

  _acct := public.neo_assert_financial_account(_org, _o.branch_id, _account);

  IF _method = 'cash' THEN
    _shift_id := coalesce(_shift_id, public.pos_resolve_open_shift(_o.branch_id));
    IF _shift_id IS NULL THEN
      RAISE EXCEPTION 'No cash drawer is open for this property. Open your till before taking cash.';
    END IF;
    SELECT * INTO _shift FROM public.pos_shifts WHERE id = _shift_id AND organization_id = _org FOR UPDATE;
    IF _shift.id IS NULL THEN RAISE EXCEPTION 'Cash drawer not found for this property'; END IF;
    IF _shift.status <> 'open' THEN
      RAISE EXCEPTION 'That cash drawer is % and cannot take cash. Open a till first.', _shift.status;
    END IF;
  END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND _shift_id IS NOT NULL THEN
    SELECT * INTO _shift FROM public.pos_shifts WHERE id=_shift_id AND organization_id=_org FOR UPDATE;
    IF auth.uid() IS NULL OR _shift.id IS NULL OR _shift.status IS DISTINCT FROM 'open' OR _shift.branch_id IS DISTINCT FROM _o.branch_id OR _shift.cashier_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Use your own open till for this property; route cash to its assigned cashier otherwise' USING ERRCODE='42501';
    END IF;
  END IF;
  SELECT coalesce(sum(amount) FILTER (WHERE status = 'confirmed'), 0),
         coalesce(sum(amount) FILTER (WHERE status IN ('initiated','pending')), 0)
    INTO _confirmed, _active
    FROM public.pos_payments WHERE order_id = _order_id;

  _balance := round(coalesce(_o.grand_total,0) - _confirmed, 2);
  _headroom := round(_balance - _active, 2);

  IF coalesce(_amount,0) <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;
  IF _amount > _headroom + 0.005 THEN
    RAISE EXCEPTION 'Payment of % exceeds the settleable balance of % (outstanding %, awaiting provider %)',
      _amount, greatest(_headroom,0), greatest(_balance,0), _active;
  END IF;

  _provider := _method IN ('mpesa','card-terminal','qr');
  _needs_reference := _method <> 'cash' AND _method <> 'complimentary';

  IF _needs_reference AND coalesce(btrim(coalesce(_reference,'')),'') = '' THEN
    RAISE EXCEPTION 'A reference is required for a % payment', _method;
  END IF;

  IF _manual_confirm THEN
    IF NOT public.has_permission('pos','payments','manual-confirm') THEN
      RAISE EXCEPTION 'Not permitted to confirm payments manually';
    END IF;
    IF NOT _provider THEN
      RAISE EXCEPTION 'Manual confirmation applies to provider-backed payments only';
    END IF;
    IF coalesce(btrim(coalesce(_note,'')),'') = '' THEN
      RAISE EXCEPTION 'A verification note is required for a manually confirmed payment';
    END IF;
    _status := 'confirmed';
  ELSE
    _status := CASE WHEN _provider THEN 'pending' ELSE 'confirmed' END;
  END IF;

  IF _method = 'cash' AND _tendered IS NOT NULL THEN
    _change := greatest(0, _tendered - _amount);
  END IF;

  IF _status = 'confirmed' THEN
    _receipt := public.next_document_number('receipt');
  END IF;

  INSERT INTO public.pos_payments (
    organization_id, branch_id, order_id, amount, tendered, change_due, currency, method,
    external_reference, receipt_number, status, provider_status, paid_at, cashier_id, shift_id, customer_id,
    created_by, verified_by, verification_note, idempotency_key, destination_account_id
  ) VALUES (
    _org, _o.branch_id, _order_id, round(_amount,2), _tendered, _change, _o.currency, _method,
    nullif(btrim(coalesce(_reference,'')),''), _receipt, _status,
    CASE WHEN _manual_confirm THEN 'manual-confirmed'
         WHEN _provider THEN 'awaiting-provider'
         WHEN _method = 'cash' THEN NULL
         ELSE 'recorded-unverified' END,
    CASE WHEN _status = 'confirmed' THEN now() ELSE NULL END,
    auth.uid(), _shift_id, _o.customer_id, auth.uid(),
    CASE WHEN _manual_confirm THEN auth.uid() ELSE NULL END,
    nullif(btrim(coalesce(_note,'')),''), _key, _acct
  ) RETURNING id INTO _payment;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_org, _o.branch_id, auth.uid(), 'pos.payment.record', 'pos', _order_id,
          jsonb_build_object('paymentId', _payment, 'amount', round(_amount,2), 'method', _method,
                             'status', _status, 'manualConfirm', _manual_confirm,
                             'providerBacked', _provider, 'receiptNumber', _receipt,
                             'shiftId', _shift_id, 'destinationAccountId', _acct,
                             'reference', nullif(btrim(coalesce(_reference,'')),'')));

  _settle := public.pos_reconcile_settlement_internal(_order_id);

  IF coalesce((_settle->>'payment_status'), '') = 'paid' THEN
    _finance := public.neo_finance_post_source('pos', _order_id, true);
  END IF;

  RETURN jsonb_build_object('payment_id', _payment, 'status', _status, 'duplicate', false,
                            'provider_backed', _provider, 'receipt_number', _receipt,
                            'shift_id', _shift_id, 'destination_account_id', _acct, 'finance', _finance)
      || _settle;
END $function$;


-- 105_APPLY_ROUTED_CASH_SCOPE_BALANCE.sql
-- Code only: no existing request is settled, cancelled, rerouted or attributed by this installation.

SET LOCAL search_path=public;
DO $guard$ BEGIN
IF to_regprocedure('public.neo_cash_till_context(uuid)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.neo_cash_till_context(uuid)'))) IS DISTINCT FROM '0056bf3ebc240af86eec6901d53680c2' THEN RAISE EXCEPTION 'Reviewed routed-cash definition differs: neo_cash_till_context(uuid)'; END IF;
IF to_regprocedure('public.neo_cash_request_payment(uuid,numeric,text,text,text)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.neo_cash_request_payment(uuid,numeric,text,text,text)'))) IS DISTINCT FROM '33a7c2397ac3e245cb9d883f0990ebda' THEN RAISE EXCEPTION 'Reviewed routed-cash definition differs: neo_cash_request_payment(uuid,numeric,text,text,text)'; END IF;
IF to_regprocedure('public.neo_cash_request_pos_payment(uuid,numeric,text,text,text)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.neo_cash_request_pos_payment(uuid,numeric,text,text,text)'))) IS DISTINCT FROM 'ca4a6bcb4641691751f5de1c70761206' THEN RAISE EXCEPTION 'Reviewed routed-cash definition differs: neo_cash_request_pos_payment(uuid,numeric,text,text,text)'; END IF;
IF to_regprocedure('public.neo_cash_settle_request(uuid)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.neo_cash_settle_request(uuid)'))) IS DISTINCT FROM '8536b8f2fb47d499c37bb423cc5373b2' THEN RAISE EXCEPTION 'Reviewed routed-cash definition differs: neo_cash_settle_request(uuid)'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.neo_cash_till_context(_branch uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _mine public.pos_shifts;
  _can_open boolean;
  _can_confirm boolean;
  _tills jsonb;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('active_tills', '[]'::jsonb); END IF;

  _can_open := public.has_permission('finance','till.create') OR public.has_permission('pos','shifts.open');
  _can_confirm := public.has_permission('finance','till.confirm_cash')
               OR public.has_permission('finance','till.edit')
               OR public.has_permission('pos','shifts.open');

  SELECT * INTO _mine FROM public.pos_shifts s
   WHERE s.organization_id=_org AND s.cashier_id=auth.uid() AND s.status='open'
     AND (CASE WHEN _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN coalesce(public.neo_branch_in_scope(s.branch_id),false) AND (_branch IS NULL OR s.branch_id=_branch) ELSE (_branch IS NULL OR s.branch_id IS NULL OR s.branch_id=_branch) END)
   ORDER BY (s.branch_id = _branch) DESC NULLS LAST, s.opened_at DESC LIMIT 1;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'shift_id', s.id, 'shift_number', s.shift_number,
           'cashier_id', s.cashier_id, 'cashier_name', COALESCE(p.full_name,'Cashier'),
           'branch_id', s.branch_id, 'opened_at', s.opened_at) ORDER BY s.opened_at DESC), '[]'::jsonb)
    INTO _tills
    FROM public.pos_shifts s
    LEFT JOIN public.profiles p ON p.id = s.cashier_id
   WHERE s.organization_id=_org AND s.status='open'
     AND (CASE WHEN _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN coalesce(public.neo_branch_in_scope(s.branch_id),false) AND (_branch IS NULL OR s.branch_id=_branch) ELSE (_branch IS NULL OR s.branch_id IS NULL OR s.branch_id=_branch) END);

  RETURN jsonb_build_object(
    'can_open_drawer', _can_open,
    'can_confirm_cash', _can_confirm,
    'my_shift_id', _mine.id,
    'my_shift_number', _mine.shift_number,
    'self_service', (_mine.id IS NOT NULL AND _can_confirm),
    'active_tills', _tills
  );
END; $function$;
CREATE OR REPLACE FUNCTION public.neo_cash_request_payment(_folio uuid, _amount numeric, _reference text DEFAULT NULL::text, _notes text DEFAULT ''::text, _idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _f public.folios;
  _ctx jsonb;
  _shift uuid; _cashier uuid; _req uuid; _existing public.cash_payment_requests;
BEGIN
  IF NOT (public.has_permission('pms','payments.record') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to record payments';
  END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;

  SELECT * INTO _f FROM public.folios WHERE id=_folio AND organization_id=_org;
  IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF NOT coalesce(public.neo_branch_in_scope(_f.branch_id),false) THEN RAISE EXCEPTION 'Cash source is outside your property scope' USING ERRCODE='42501'; END IF;
    IF _amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Cash amount must be finite and positive' USING ERRCODE='22023'; END IF;
  END IF;
  IF _idempotency_key IS NOT NULL THEN
    SELECT * INTO _existing FROM public.cash_payment_requests
     WHERE organization_id=_org AND idempotency_key=_idempotency_key;
    IF _existing.id IS NOT NULL THEN
      IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND (_existing.source_record_id IS DISTINCT FROM _f.id OR _existing.source_module IS DISTINCT FROM 'pms' OR _existing.branch_id IS DISTINCT FROM _f.branch_id) THEN RAISE EXCEPTION 'Cash request intent belongs to a different source or property' USING ERRCODE='23514'; END IF;
      IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND _existing.status='confirmed' THEN RETURN public.neo_cash_settle_request(_existing.id); END IF;
      RETURN jsonb_build_object('status',_existing.status,'request_id',_existing.id,
        'payment_id',_existing.payment_id,'receipt_number',_existing.receipt_number);
    END IF;
  END IF;

  _ctx := public.neo_cash_till_context(_f.branch_id);

  IF (_ctx->>'self_service')::boolean THEN
    _shift := (_ctx->>'my_shift_id')::uuid;
    _cashier := auth.uid();
  ELSE
    SELECT s.id, s.cashier_id INTO _shift, _cashier
      FROM public.pos_shifts s
     WHERE s.organization_id=_org AND s.status='open'
       AND (CASE WHEN _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN s.branch_id IS NOT DISTINCT FROM _f.branch_id AND coalesce(public.neo_branch_in_scope(s.branch_id),false) ELSE (s.branch_id IS NULL OR _f.branch_id IS NULL OR s.branch_id=_f.branch_id) END)
     ORDER BY (s.branch_id = _f.branch_id) DESC NULLS LAST, s.opened_at DESC
     LIMIT 1;
  END IF;

  IF _shift IS NULL THEN
    RETURN jsonb_build_object('status','no_till',
      'message','No active cash drawer is available for this outlet.',
      'can_open_drawer', _ctx->'can_open_drawer');
  END IF;

  INSERT INTO public.cash_payment_requests (organization_id, branch_id, source_module, source_record_id,
    folio_id, amount, currency, method, reference, notes, status, requested_by,
    assigned_shift_id, assigned_cashier_id, idempotency_key)
  VALUES (_org, _f.branch_id, 'pms', _f.id, _f.id, _amount, COALESCE(_f.currency,'KES'), 'cash',
    _reference, COALESCE(_notes,''), 'pending', auth.uid(), _shift, _cashier, _idempotency_key)
  RETURNING id INTO _req;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'finance.cash.request.create', 'finance', _req::text,
    jsonb_build_object('folio_id',_f.id,'amount',_amount,'assigned_shift',_shift,'assigned_cashier',_cashier));

  IF (_ctx->>'self_service')::boolean THEN
    RETURN public.neo_cash_settle_request(_req);
  END IF;

  RETURN jsonb_build_object('status','pending','request_id',_req,'assigned_shift_id',_shift,
    'assigned_cashier_id',_cashier,'amount',_amount);
END; $function$;
CREATE OR REPLACE FUNCTION public.neo_cash_request_pos_payment(_order uuid, _amount numeric, _reference text DEFAULT NULL::text, _notes text DEFAULT ''::text, _idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _o public.pos_orders;
  _ctx jsonb; _shift uuid; _cashier uuid; _req uuid; _existing public.cash_payment_requests;
BEGIN
  IF NOT (public.has_permission('pos','payments.record') OR public.has_permission('pos','orders.edit')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to record payments' USING ERRCODE = '42501';
  END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;

  SELECT * INTO _o FROM public.pos_orders WHERE id=_order AND organization_id=_org;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF NOT coalesce(public.neo_branch_in_scope(_o.branch_id),false) THEN RAISE EXCEPTION 'Cash source is outside your property scope' USING ERRCODE='42501'; END IF;
    IF _amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Cash amount must be finite and positive' USING ERRCODE='22023'; END IF;
  END IF;
  IF _idempotency_key IS NOT NULL THEN
    SELECT * INTO _existing FROM public.cash_payment_requests
     WHERE organization_id=_org AND idempotency_key=_idempotency_key;
    IF _existing.id IS NOT NULL THEN
      IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND (_existing.source_record_id IS DISTINCT FROM _o.id OR _existing.source_module IS DISTINCT FROM 'pos' OR _existing.branch_id IS DISTINCT FROM _o.branch_id) THEN RAISE EXCEPTION 'Cash request intent belongs to a different source or property' USING ERRCODE='23514'; END IF;
      IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND _existing.status='confirmed' THEN RETURN public.neo_cash_settle_request(_existing.id); END IF;
      RETURN jsonb_build_object('status',_existing.status,'request_id',_existing.id,
        'payment_id',_existing.payment_id,'receipt_number',_existing.receipt_number);
    END IF;
  END IF;

  _ctx := public.neo_cash_till_context(_o.branch_id);

  IF (_ctx->>'self_service')::boolean THEN
    _shift := (_ctx->>'my_shift_id')::uuid; _cashier := auth.uid();
  ELSE
    SELECT s.id, s.cashier_id INTO _shift, _cashier
      FROM public.pos_shifts s
     WHERE s.organization_id=_org AND s.status='open'
       AND (CASE WHEN _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN s.branch_id IS NOT DISTINCT FROM _o.branch_id AND coalesce(public.neo_branch_in_scope(s.branch_id),false) ELSE (s.branch_id IS NULL OR _o.branch_id IS NULL OR s.branch_id=_o.branch_id) END)
     ORDER BY (s.branch_id = _o.branch_id) DESC NULLS LAST, s.opened_at DESC LIMIT 1;
  END IF;

  IF _shift IS NULL THEN
    RETURN jsonb_build_object('status','no_till',
      'message','No active cash drawer is available for this outlet.',
      'can_open_drawer', _ctx->'can_open_drawer');
  END IF;

  INSERT INTO public.cash_payment_requests (organization_id, branch_id, source_module, source_record_id,
    folio_id, amount, currency, method, reference, notes, status, requested_by,
    assigned_shift_id, assigned_cashier_id, idempotency_key)
  VALUES (_org, _o.branch_id, 'pos', _o.id, NULL, _amount, COALESCE(_o.currency,'KES'), 'cash',
    COALESCE(_reference, _o.order_number), COALESCE(_notes,''), 'pending', auth.uid(),
    _shift, _cashier, _idempotency_key)
  RETURNING id INTO _req;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'finance.cash.request.create', 'pos', _req::text,
    jsonb_build_object('order_id',_o.id,'amount',_amount,'assigned_shift',_shift,'assigned_cashier',_cashier));

  IF (_ctx->>'self_service')::boolean THEN
    RETURN public.neo_cash_settle_request(_req);
  END IF;

  RETURN jsonb_build_object('status','pending','request_id',_req,'assigned_shift_id',_shift,
    'assigned_cashier_id',_cashier,'amount',_amount);
END; $function$;
CREATE OR REPLACE FUNCTION public.neo_cash_settle_request(_request uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _r public.cash_payment_requests;
  _f public.folios;
  _o public.pos_orders;
  _s public.pos_shifts;
  _pay uuid; _receipt text; _paid numeric; _fully boolean; _pending numeric; _headroom numeric;
BEGIN
  SELECT * INTO _r FROM public.cash_payment_requests WHERE id=_request AND organization_id=_org FOR UPDATE;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Cash request not found'; END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF NOT coalesce(public.neo_branch_in_scope(_r.branch_id),false) THEN RAISE EXCEPTION 'Cash request is outside your property scope' USING ERRCODE='42501'; END IF;
    IF _r.amount IS NULL OR _r.amount<=0 OR _r.amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Cash amount must be finite and positive'; END IF;
    IF _r.status='confirmed' THEN
      IF auth.uid() IS NULL OR NOT (coalesce(_r.requested_by=auth.uid(),false) OR coalesce(_r.assigned_cashier_id=auth.uid(),false) OR public.has_permission('finance','view') OR public.has_permission('pos','payments.record') OR public.is_org_admin()) THEN RAISE EXCEPTION 'Not permitted to view this cash confirmation' USING ERRCODE='42501'; END IF;
      IF _r.payment_id IS NULL OR nullif(btrim(_r.receipt_number),'') IS NULL OR
         (_r.source_module='pos' AND NOT EXISTS(SELECT 1 FROM public.pos_payments p WHERE p.id=_r.payment_id AND p.organization_id=_org AND p.branch_id IS NOT DISTINCT FROM _r.branch_id AND p.order_id=_r.source_record_id AND p.receipt_number=_r.receipt_number AND p.amount=_r.amount AND p.currency=_r.currency)) OR
         (coalesce(_r.source_module,'')<>'pos' AND NOT EXISTS(SELECT 1 FROM public.payments p WHERE p.id=_r.payment_id AND p.organization_id=_org AND p.branch_id IS NOT DISTINCT FROM _r.branch_id AND p.folio_id=_r.folio_id AND p.receipt_number=_r.receipt_number AND p.amount=_r.amount AND p.currency=_r.currency)) THEN
        RAISE EXCEPTION 'Confirmed cash request lacks matching saved payment and receipt evidence';
      END IF;
    END IF;
  END IF;
  IF _r.status = 'confirmed' THEN
    RETURN jsonb_build_object('status','confirmed','request_id',_r.id,
      'payment_id',_r.payment_id,'receipt_number',_r.receipt_number,'amount',_r.amount);
  END IF;
  IF _r.status <> 'pending' THEN RAISE EXCEPTION 'Cash request is % and cannot be settled', _r.status; END IF;

  SELECT * INTO _s FROM public.pos_shifts WHERE id=_r.assigned_shift_id AND organization_id=_org FOR UPDATE;
  IF _s.id IS NULL OR _s.status <> 'open' THEN
    RAISE EXCEPTION 'The assigned cash drawer is no longer open';
  END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF auth.uid() IS NULL OR _s.status IS DISTINCT FROM 'open' OR _s.branch_id IS DISTINCT FROM _r.branch_id OR _s.cashier_id IS DISTINCT FROM auth.uid() OR (_r.assigned_cashier_id IS NOT NULL AND _r.assigned_cashier_id IS DISTINCT FROM _s.cashier_id) THEN RAISE EXCEPTION 'Only the assigned cashier with an open till in this property may confirm cash' USING ERRCODE='42501'; END IF;
    IF NOT (public.has_permission('finance','till.confirm_cash') OR public.has_permission('finance','till.edit') OR public.has_permission('pos','shifts.open')) THEN RAISE EXCEPTION 'Not permitted to confirm cash' USING ERRCODE='42501'; END IF;
  END IF;
  _receipt := public.next_document_number('receipt');

  IF _r.source_module = 'pos' THEN
    SELECT * INTO _o FROM public.pos_orders WHERE id=_r.source_record_id AND organization_id=_org FOR UPDATE;
    IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
    IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
      IF _o.branch_id IS DISTINCT FROM _r.branch_id OR _o.currency IS DISTINCT FROM _r.currency THEN RAISE EXCEPTION 'Cash source property or currency changed'; END IF;
      IF _o.status IN ('closed','cancelled','voided','charged-to-room') THEN RAISE EXCEPTION 'This order cannot accept further cash'; END IF;
      SELECT coalesce(sum(amount) FILTER(WHERE status='confirmed'),0),coalesce(sum(amount) FILTER(WHERE status IN ('initiated','pending')),0) INTO _paid,_pending FROM public.pos_payments WHERE organization_id=_org AND order_id=_o.id;
      IF _o.grand_total IS NULL OR _o.grand_total::text IN ('NaN','Infinity','-Infinity') OR _paid::text IN ('NaN','Infinity','-Infinity') OR _pending::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Order payment amounts are incomplete or non-finite'; END IF;
      _headroom:=round(_o.grand_total-_paid-_pending,2);
      IF _r.amount>_headroom+0.005 THEN RAISE EXCEPTION 'Cash request exceeds the current payment headroom'; END IF;
    END IF;

    INSERT INTO public.pos_payments (organization_id, branch_id, order_id, receipt_number, customer_id,
      amount, tendered, currency, method, external_reference, status, paid_at, cashier_id, shift_id,
      created_by, idempotency_key)
    VALUES (_org, _o.branch_id, _o.id, _receipt, _o.customer_id, _r.amount, _r.amount,
      COALESCE(_o.currency,_r.currency), _r.method, _r.reference, 'confirmed', now(), _s.cashier_id, _s.id,
      auth.uid(), 'cash-request:' || _r.id::text)
    RETURNING id INTO _pay;

    _paid := CASE WHEN _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN _paid+_r.amount ELSE COALESCE(_o.paid_total,0)+_r.amount END;
    _fully := _paid >= COALESCE(_o.grand_total,0);

    -- Move out of the service state BEFORE marking the bill paid: the lifecycle
    -- guard refuses a fully paid order that is still sent/preparing.
    IF _fully AND _o.status NOT IN ('awaiting-payment','paid','closed','charged-to-room','credit','cancelled','voided') THEN
      UPDATE public.pos_orders SET status='awaiting-payment', updated_at=now() WHERE id=_o.id;
    END IF;

    UPDATE public.pos_orders
       SET paid_total = _paid,
           payment_status = CASE WHEN _fully THEN 'paid' ELSE 'partial' END,
           updated_at = now()
     WHERE id = _o.id;

    IF _fully THEN
      UPDATE public.pos_orders SET status='paid', updated_at=now()
       WHERE id=_o.id AND status='awaiting-payment';
    END IF;
  ELSE
    SELECT * INTO _f FROM public.folios WHERE id=_r.folio_id AND organization_id=_org FOR UPDATE;
    IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
    IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND (_f.branch_id IS DISTINCT FROM _r.branch_id OR _f.currency IS DISTINCT FROM _r.currency) THEN RAISE EXCEPTION 'Cash folio property or currency changed'; END IF;
    IF _f.status NOT IN ('open','under-review') THEN
      RAISE EXCEPTION 'Folio is % and cannot accept payments', _f.status;
    END IF;

    INSERT INTO public.payments (organization_id, branch_id, receipt_number, folio_id, reservation_id,
      customer_id, amount, currency, method, external_reference, status, received_by, notes, shift_id,
      station_id, source_module, source_record_id, idempotency_key)
    VALUES (_org, _f.branch_id, _receipt, _f.id, _f.reservation_id, _f.customer_id, _r.amount,
      COALESCE(_f.currency,_r.currency), _r.method, _r.reference, 'confirmed', _s.cashier_id,
      COALESCE(_r.notes,''), _s.id, _s.station_id, _r.source_module, _r.source_record_id,
      'cash-request:' || _r.id::text)
    RETURNING id INTO _pay;

    INSERT INTO public.payment_allocations (organization_id, payment_id, folio_id, amount, created_by)
    VALUES (_org, _pay, _f.id, _r.amount, _s.cashier_id);

    UPDATE public.folios SET total_payments = COALESCE(total_payments,0) + _r.amount,
      balance = COALESCE(balance,0) - _r.amount, updated_at = now() WHERE id=_f.id;
  END IF;

  UPDATE public.cash_payment_requests
     SET status='confirmed', payment_id=_pay, receipt_number=_receipt,
         assigned_cashier_id=COALESCE(assigned_cashier_id,_s.cashier_id), confirmed_at=now(), updated_at=now()
   WHERE id=_r.id;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'finance.cash.receipt.confirm', 'finance', _pay::text,
    jsonb_build_object('request_id',_r.id,'folio_id',_r.folio_id,'source_module',_r.source_module,
      'source_record_id',_r.source_record_id,'amount',_r.amount,'method',_r.method,
      'shift_id',_s.id,'collected_by',_s.cashier_id,'initiated_by',_r.requested_by,
      'receipt_number',_receipt), _r.notes);

  RETURN jsonb_build_object('status','confirmed','request_id',_r.id,'payment_id',_pay,
    'receipt_number',_receipt,'amount',_r.amount,'shift_id',_s.id,'collected_by',_s.cashier_id);
END; $function$;


COMMIT;
BEGIN READ ONLY;
WITH expected(signature,hash) AS (VALUES ('public.neo_gl_post(uuid,uuid,text,text,uuid,text,date,text,text,jsonb,uuid,uuid)','08e96545d8fc2cfe60b3839131c4ee08'),
('public.neo_stores_count_submit_variance(uuid,text)','c16e752accfd06c60527171ecfe685d6'),
('public.neo_stores_issue(uuid,jsonb,uuid,uuid,text,text)','2cde096a47ff1adcd880fbc36d2b9352'),
('public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid)','54ca4b89c5dffe501d5bd3ccd3ac3dc1'),
('public.neo_cash_till_context(uuid)','36b63a8dd5854b9e11417708478100e5'),
('public.neo_cash_request_payment(uuid,numeric,text,text,text)','518f3792da29a326e556beffc2656b56'),
('public.neo_cash_request_pos_payment(uuid,numeric,text,text,text)','fd97015abbb7c524905ec33fb5160ae8'),
('public.neo_cash_settle_request(uuid)','535ce6e7e209b7b9ffb3b998d344ff87')), checks AS (SELECT signature,md5(pg_get_functiondef(to_regprocedure(signature)))=hash AS matches FROM expected)
SELECT jsonb_build_object('diagnostic_version','code-bundle-95-105-live-v1','read_only',current_setting('transaction_read_only'),'definitions_match',(SELECT bool_and(matches) FROM checks),'code',(SELECT jsonb_agg(to_jsonb(checks)) FROM checks),'scope','Eight code functions only. No existing order, till, payment, stock count, movement, journal or period is changed by installation.') AS diagnostic;
COMMIT;
