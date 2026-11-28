-- A supplier can see and price only RFQs addressed to their active relationship.
-- Revisions create new quotations; the old price and its lines remain auditable.
CREATE OR REPLACE FUNCTION public.neo_partner_supplier_rfqs(_branch uuid, _relationship uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE _rel public.neo_access_relationships%ROWTYPE; _org uuid;
BEGIN
  SELECT organization_id INTO _org FROM public.branches WHERE id = _branch AND active IS TRUE;
  SELECT * INTO _rel FROM public.neo_access_relationships
   WHERE id = _relationship AND auth_user_id = auth.uid() AND door = 'partner'
     AND status = 'active' AND organization_id = _org AND supplier_id IS NOT NULL
     AND (branch_id IS NULL OR branch_id = _branch);
  IF _rel.id IS NULL THEN RAISE EXCEPTION 'supplier_access_denied' USING ERRCODE = '42501'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.issued_at DESC) FROM (
    SELECT f.id, f.rfq_number, f.title, f.notes, f.issued_at, f.closes_at,
      (SELECT s.currency FROM public.suppliers s WHERE s.id = _rel.supplier_id
        AND s.organization_id = _org) AS currency,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', l.id, 'description', COALESCE(i.name, l.description),
        'quantity', l.quantity, 'unit', l.unit) ORDER BY l.created_at, l.id), '[]'::jsonb)
       FROM public.purchase_request_lines l LEFT JOIN public.stock_items i ON i.id = l.stock_item_id
       WHERE l.request_id = f.request_id AND l.organization_id = _org) AS lines,
      (SELECT jsonb_build_object('number', q.quotation_number, 'total', q.total_amount,
        'status', q.status, 'submitted_at', q.created_at)
       FROM public.supplier_quotations q WHERE q.rfq_id = f.id
         AND q.supplier_id = _rel.supplier_id AND q.organization_id = _org
         AND q.status <> 'superseded' ORDER BY q.created_at DESC LIMIT 1) AS response
    FROM public.rfqs f
    JOIN public.rfq_suppliers invited ON invited.rfq_id = f.id
      AND invited.supplier_id = _rel.supplier_id AND invited.organization_id = _org
    WHERE f.organization_id = _org AND f.branch_id = _branch AND f.status = 'issued'
      AND invited.dispatch_state IN ('marked-sent', 'sent')
    ORDER BY f.issued_at DESC LIMIT 50
  ) r), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.neo_partner_supplier_quote_submit(
  _branch uuid, _relationship uuid, _rfq uuid, _lines jsonb, _notes text DEFAULT NULL,
  _attempt uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _rel public.neo_access_relationships%ROWTYPE; _org uuid; _f public.rfqs%ROWTYPE;
  _line jsonb; _id uuid; _price numeric; _tax numeric; _lead integer;
  _total numeric := 0; _expected integer; _quote uuid; _number text; _prior jsonb; _currency text;
BEGIN
  SELECT organization_id INTO _org FROM public.branches WHERE id = _branch AND active IS TRUE;
  SELECT * INTO _rel FROM public.neo_access_relationships
   WHERE id = _relationship AND auth_user_id = auth.uid() AND door = 'partner'
     AND status = 'active' AND organization_id = _org AND supplier_id IS NOT NULL
     AND (branch_id IS NULL OR branch_id = _branch);
  IF _rel.id IS NULL THEN RAISE EXCEPTION 'supplier_access_denied' USING ERRCODE = '42501'; END IF;
  SELECT currency INTO _currency FROM public.suppliers
    WHERE id = _rel.supplier_id AND organization_id = _org AND active IS TRUE;
  IF _currency IS NULL THEN RAISE EXCEPTION 'supplier_not_active' USING ERRCODE='22023'; END IF;
  IF _attempt IS NULL THEN RAISE EXCEPTION 'attempt_key_required' USING ERRCODE='22023'; END IF;
  SELECT result INTO _prior FROM public.procurement_attempts WHERE organization_id = _org
    AND action = 'partner.quote.submit' AND attempt_key = _attempt;
  IF _prior IS NOT NULL THEN
    IF _prior->>'rfq_id' <> _rfq::text THEN
      RAISE EXCEPTION 'attempt_key_reused' USING ERRCODE='22023'; END IF;
    RETURN _prior || jsonb_build_object('replayed', true);
  END IF;
  SELECT * INTO _f FROM public.rfqs WHERE id = _rfq AND organization_id = _org
    AND branch_id = _branch AND status = 'issued' FOR UPDATE;
  IF _f.id IS NULL OR NOT EXISTS (SELECT 1 FROM public.rfq_suppliers
      WHERE rfq_id = _rfq AND supplier_id = _rel.supplier_id AND organization_id = _org
        AND dispatch_state IN ('marked-sent', 'sent'))
    THEN RAISE EXCEPTION 'rfq_not_available' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM public.purchase_requests WHERE id = _f.request_id
    AND organization_id = _org FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.purchase_requests WHERE id = _f.request_id
    AND organization_id = _org AND status = 'approved') THEN
    RAISE EXCEPTION 'request_not_approved' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.purchase_orders WHERE request_id = _f.request_id
    AND organization_id = _org AND status NOT IN ('cancelled','voided')) THEN
    RAISE EXCEPTION 'request_already_ordered' USING ERRCODE='22023'; END IF;
  IF _f.closes_at IS NOT NULL AND now() > _f.closes_at THEN
    RAISE EXCEPTION 'rfq_closed' USING ERRCODE = '22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.supplier_quotations WHERE rfq_id = _rfq
    AND supplier_id = _rel.supplier_id AND selected IS TRUE) THEN
    RAISE EXCEPTION 'quotation_already_selected' USING ERRCODE = '22023'; END IF;
  IF jsonb_typeof(_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'quote_lines_required' USING ERRCODE = '22023'; END IF;
  SELECT count(*) INTO _expected FROM public.purchase_request_lines
    WHERE request_id = _f.request_id AND organization_id = _org;
  IF _expected = 0 OR jsonb_array_length(_lines) <> _expected THEN
    RAISE EXCEPTION 'quote_every_requested_line' USING ERRCODE = '22023'; END IF;
  FOR _line IN SELECT value FROM jsonb_array_elements(_lines) LOOP
    IF jsonb_typeof(_line) <> 'object' OR (_line->>'request_line_id') IS NULL
      OR (_line->>'unit_price') IS NULL THEN
      RAISE EXCEPTION 'invalid_quote_line' USING ERRCODE = '22023'; END IF;
    _id := (_line->>'request_line_id')::uuid;
    _price := (_line->>'unit_price')::numeric;
    _tax := COALESCE((_line->>'tax_rate')::numeric, 0);
    _lead := NULLIF(_line->>'lead_time_days', '')::integer;
    IF _price < 0 OR _price > 100000000 OR _tax < 0 OR _tax > 100
      OR (_lead IS NOT NULL AND (_lead < 0 OR _lead > 3650)) THEN
      RAISE EXCEPTION 'invalid_quote_price_or_terms' USING ERRCODE = '22023'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.purchase_request_lines l WHERE l.id = _id
      AND l.request_id = _f.request_id AND l.organization_id = _org) THEN
      RAISE EXCEPTION 'quote_line_not_in_request' USING ERRCODE = '22023'; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT x->>'request_line_id') FROM jsonb_array_elements(_lines) x) <> _expected THEN
    RAISE EXCEPTION 'duplicate_quote_line' USING ERRCODE = '22023'; END IF;
  UPDATE public.supplier_quotations SET status = 'superseded'
    WHERE rfq_id = _rfq AND supplier_id = _rel.supplier_id
      AND organization_id = _org AND status = 'received';
  _number := 'SQ-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  INSERT INTO public.supplier_quotations
    (organization_id, branch_id, supplier_id, request_id, rfq_id, quotation_number,
      status, notes, valid_until, total_amount, currency)
    VALUES (_org, _branch, _rel.supplier_id, _f.request_id, _rfq, _number,
      'received', NULLIF(trim(_notes), ''), NULL, 0, _currency)
    RETURNING id INTO _quote;
  INSERT INTO public.supplier_quotation_lines
    (organization_id, quotation_id, request_line_id, stock_item_id, description,
      quantity, unit, unit_price, tax_rate, lead_time_days, notes)
  SELECT _org, _quote, l.id, l.stock_item_id, l.description, l.quantity, l.unit,
    (x.value->>'unit_price')::numeric, COALESCE((x.value->>'tax_rate')::numeric, 0),
    NULLIF(x.value->>'lead_time_days', '')::integer, NULLIF(trim(x.value->>'notes'), '')
  FROM jsonb_array_elements(_lines) x
  JOIN public.purchase_request_lines l ON l.id = (x.value->>'request_line_id')::uuid
    AND l.request_id = _f.request_id AND l.organization_id = _org;
  SELECT COALESCE(sum(round(quantity * unit_price, 2) +
    round(quantity * unit_price * tax_rate / 100, 2)), 0)
    INTO _total FROM public.supplier_quotation_lines WHERE quotation_id = _quote;
  UPDATE public.supplier_quotations SET total_amount = _total WHERE id = _quote;
  UPDATE public.rfq_suppliers SET responded_at = now() WHERE rfq_id = _rfq
    AND supplier_id = _rel.supplier_id AND organization_id = _org;
  _prior := jsonb_build_object('quotation_id', _quote, 'quotation_number', _number,
    'total_amount', _total, 'rfq_id', _rfq);
  INSERT INTO public.procurement_attempts (organization_id, action, attempt_key, record_id, result)
    VALUES (_org, 'partner.quote.submit', _attempt, _quote, _prior);
  RETURN _prior;
END $$;

REVOKE ALL ON FUNCTION public.neo_partner_supplier_rfqs(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_partner_supplier_quote_submit(uuid, uuid, uuid, jsonb, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_partner_supplier_rfqs(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_partner_supplier_quote_submit(uuid, uuid, uuid, jsonb, text, uuid) TO authenticated;

-- Recommend exactly one eligible quote for a request in a single transaction.
CREATE OR REPLACE FUNCTION public.neo_procurement_recommend_supplier_quote(
  _request uuid, _quotation uuid, _reason text, _single_source boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid := public.current_org_id(); _q public.supplier_quotations%ROWTYPE;
  _request_row public.purchase_requests%ROWTYPE; _count integer;
BEGIN
  IF _org IS NULL OR NOT (public.has_permission('procurement', 'quotations.manage')
    OR public.has_permission('procurement', 'orders.create') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501'; END IF;
  IF length(trim(COALESCE(_reason, ''))) < 5 THEN
    RAISE EXCEPTION 'selection_reason_required' USING ERRCODE = '22023'; END IF;
  SELECT * INTO _request_row FROM public.purchase_requests
    WHERE id = _request AND organization_id = _org FOR UPDATE;
  IF _request_row.id IS NULL OR _request_row.status NOT IN ('approved', 'submitted')
    OR NOT public.neo_branch_in_scope(_request_row.branch_id) THEN
    RAISE EXCEPTION 'request_not_available' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM public.purchase_orders WHERE request_id = _request
    AND organization_id = _org AND status NOT IN ('cancelled','voided')) THEN
    RAISE EXCEPTION 'request_already_ordered' USING ERRCODE='22023'; END IF;
  SELECT * INTO _q FROM public.supplier_quotations WHERE id = _quotation
    AND request_id = _request AND organization_id = _org FOR UPDATE;
  IF _q.id IS NULL OR _q.status NOT IN ('received', 'selected') OR _q.total_amount < 0
    OR (_q.valid_until IS NOT NULL AND _q.valid_until < public.neo_local_today(_request_row.branch_id))
    OR _q.currency IS DISTINCT FROM public.neo_fact_currency(_org, _request_row.branch_id) THEN
    RAISE EXCEPTION 'quotation_not_eligible' USING ERRCODE = '22023'; END IF;
  IF _q.rfq_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.rfq_suppliers i
      WHERE i.rfq_id = _q.rfq_id AND i.supplier_id = _q.supplier_id AND i.organization_id = _org) THEN
    RAISE EXCEPTION 'supplier_not_invited' USING ERRCODE = '42501'; END IF;
  SELECT count(DISTINCT supplier_id) INTO _count FROM public.supplier_quotations
    WHERE request_id = _request AND organization_id = _org AND status IN ('received', 'selected')
      AND (valid_until IS NULL OR valid_until >= public.neo_local_today(_request_row.branch_id))
      AND currency = public.neo_fact_currency(_org, _request_row.branch_id);
  IF _count < 3 AND NOT _single_source THEN
    RAISE EXCEPTION 'three_quotes_or_single_source_reason_required' USING ERRCODE = '22023'; END IF;
  UPDATE public.supplier_quotations SET selected = false, status = 'received',
    selected_by = NULL, selected_at = NULL, selection_reason = NULL
    WHERE request_id = _request AND organization_id = _org AND selected IS TRUE AND id <> _quotation;
  UPDATE public.supplier_quotations SET selected = true, status = 'selected',
    selected_by = auth.uid(), selected_at = now(),
    selection_reason = CASE WHEN _single_source THEN 'Single source: ' || trim(_reason) ELSE trim(_reason) END
    WHERE id = _quotation;
  RETURN jsonb_build_object('quotation_id', _quotation, 'selected', true);
END $$;
REVOKE ALL ON FUNCTION public.neo_procurement_recommend_supplier_quote(uuid, uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_procurement_recommend_supplier_quote(uuid, uuid, text, boolean) TO authenticated;

-- Buyer capture of an offline quotation uses the same itemized value model.
CREATE OR REPLACE FUNCTION public.neo_procurement_record_supplier_quote(
  _request uuid, _supplier uuid, _lines jsonb, _notes text DEFAULT NULL, _valid_until date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid := public.current_org_id(); _r public.purchase_requests%ROWTYPE;
  _quote uuid; _number text; _total numeric; _line jsonb; _id uuid; _price numeric; _tax numeric;
  _expected integer; _currency text;
BEGIN
  IF _org IS NULL OR NOT (public.has_permission('procurement','quotations.manage')
    OR public.has_permission('procurement','orders.create') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501'; END IF;
  SELECT * INTO _r FROM public.purchase_requests WHERE id = _request AND organization_id = _org FOR UPDATE;
  IF _r.id IS NULL OR _r.status NOT IN ('approved','submitted')
    OR NOT public.neo_branch_in_scope(_r.branch_id) THEN
    RAISE EXCEPTION 'request_not_available' USING ERRCODE='42501'; END IF;
  IF EXISTS (SELECT 1 FROM public.purchase_orders WHERE request_id = _request
    AND organization_id = _org AND status NOT IN ('cancelled','voided')) THEN
    RAISE EXCEPTION 'request_already_ordered' USING ERRCODE='22023'; END IF;
  SELECT currency INTO _currency FROM public.suppliers WHERE id = _supplier
    AND organization_id = _org AND active IS TRUE;
  IF _currency IS NULL THEN
    RAISE EXCEPTION 'supplier_not_available' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'quote_lines_required' USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO _expected FROM public.purchase_request_lines WHERE request_id = _request;
  IF _expected = 0 OR jsonb_array_length(_lines) <> _expected OR
     (SELECT count(DISTINCT x->>'request_line_id') FROM jsonb_array_elements(_lines) x) <> _expected THEN
    RAISE EXCEPTION 'quote_every_requested_line_once' USING ERRCODE='22023'; END IF;
  FOR _line IN SELECT value FROM jsonb_array_elements(_lines) LOOP
    IF (_line->>'request_line_id') IS NULL OR (_line->>'unit_price') IS NULL THEN
      RAISE EXCEPTION 'invalid_quote_line' USING ERRCODE='22023'; END IF;
    _id := (_line->>'request_line_id')::uuid;
    _price := (_line->>'unit_price')::numeric;
    _tax := COALESCE((_line->>'tax_rate')::numeric, 0);
    IF _price < 0 OR _price > 100000000 OR _tax < 0 OR _tax > 100 OR
      NOT EXISTS (SELECT 1 FROM public.purchase_request_lines
        WHERE id = _id AND request_id = _request AND organization_id = _org) THEN
      RAISE EXCEPTION 'invalid_quote_price_or_line' USING ERRCODE='22023'; END IF;
  END LOOP;
  _number := 'QT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  INSERT INTO public.supplier_quotations
    (organization_id, branch_id, request_id, supplier_id, quotation_number,
     status, notes, valid_until, total_amount, currency)
  VALUES (_org, _r.branch_id, _request, _supplier, _number,
    'received', NULLIF(trim(_notes),''), _valid_until, 0, _currency) RETURNING id INTO _quote;
  INSERT INTO public.supplier_quotation_lines
    (organization_id, quotation_id, request_line_id, stock_item_id, description,
      quantity, unit, unit_price, tax_rate)
  SELECT _org, _quote, l.id, l.stock_item_id, l.description, l.quantity, l.unit,
    (x.value->>'unit_price')::numeric, COALESCE((x.value->>'tax_rate')::numeric, 0)
  FROM jsonb_array_elements(_lines) x JOIN public.purchase_request_lines l
    ON l.id = (x.value->>'request_line_id')::uuid AND l.request_id = _request;
  SELECT COALESCE(sum(round(quantity * unit_price, 2) +
    round(quantity * unit_price * tax_rate / 100, 2)), 0) INTO _total
    FROM public.supplier_quotation_lines WHERE quotation_id = _quote;
  UPDATE public.supplier_quotations SET total_amount = _total WHERE id = _quote;
  RETURN jsonb_build_object('quotation_id', _quote, 'quotation_number', _number, 'total_amount', _total);
END $$;
REVOKE ALL ON FUNCTION public.neo_procurement_record_supplier_quote(uuid, uuid, jsonb, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_procurement_record_supplier_quote(uuid, uuid, jsonb, text, date) TO authenticated;

-- The LPO must use the selected supplier's item prices and units, rather than
-- the requester's provisional estimate. A mismatch stops the order.
CREATE OR REPLACE FUNCTION public.neo_procurement_order_from_request(
  _request uuid, _supplier uuid, _expected date, _attempt uuid, _location uuid DEFAULT NULL::uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid := public.current_org_id(); _r public.purchase_requests%ROWTYPE;
  _order uuid; _number text; _prior jsonb; _lines integer; _subtotal numeric;
  _tax numeric; _unlinked text; _quote uuid; _quote_lines integer;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE='42501'; END IF;
  IF _attempt IS NULL THEN RAISE EXCEPTION 'attempt_key_required' USING ERRCODE='22023'; END IF;
  SELECT result INTO _prior FROM public.procurement_attempts
    WHERE organization_id = _org AND action = 'order.create' AND attempt_key = _attempt;
  IF _prior IS NOT NULL THEN RETURN _prior || jsonb_build_object('replayed', true); END IF;
  IF NOT (public.has_permission('procurement','lpos.create') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501'; END IF;
  SELECT * INTO _r FROM public.purchase_requests WHERE id = _request
    AND organization_id = _org FOR UPDATE;
  IF _r.id IS NULL OR NOT public.neo_branch_in_scope(_r.branch_id) THEN
    RAISE EXCEPTION 'request_not_found_or_out_of_scope' USING ERRCODE='42501'; END IF;
  IF _r.status <> 'approved' THEN RAISE EXCEPTION 'request_not_approved' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id = _supplier
    AND s.organization_id = _org AND s.active IS TRUE) THEN
    RAISE EXCEPTION 'supplier_not_approved' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_request::text, 42));
  IF EXISTS (SELECT 1 FROM public.purchase_orders p WHERE p.request_id = _request
    AND p.status NOT IN ('cancelled','voided')) THEN
    RAISE EXCEPTION 'request_already_ordered' USING ERRCODE='23505'; END IF;
  SELECT id INTO _quote FROM public.supplier_quotations WHERE request_id = _request
    AND organization_id = _org AND selected IS TRUE AND status = 'selected'
    ORDER BY selected_at DESC LIMIT 1;
  IF _quote IS NULL THEN
    RAISE EXCEPTION 'select_an_itemized_supplier_quote_before_ordering' USING ERRCODE='22023'; END IF;
  IF _quote IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.supplier_quotations
    WHERE id = _quote AND supplier_id = _supplier
      AND branch_id IS NOT DISTINCT FROM _r.branch_id
      AND (valid_until IS NULL OR valid_until >= public.neo_local_today(_r.branch_id))
      AND currency = public.neo_fact_currency(_org, _r.branch_id)) THEN
    RAISE EXCEPTION 'supplier_differs_from_selected_quote' USING ERRCODE='22023'; END IF;
  SELECT string_agg(COALESCE(l.description,'Unnamed item'), ', ') INTO _unlinked
    FROM public.purchase_request_lines l WHERE l.request_id = _request
      AND l.stock_item_id IS NULL AND _location IS NOT NULL;
  IF _unlinked IS NOT NULL THEN
    RAISE EXCEPTION 'Link % to a catalogue stock item before raising a store delivery order', _unlinked
      USING ERRCODE='22023'; END IF;
  IF _quote IS NOT NULL THEN
    SELECT count(*) INTO _quote_lines FROM public.supplier_quotation_lines WHERE quotation_id = _quote;
    IF _quote_lines <> (SELECT count(*) FROM public.purchase_request_lines WHERE request_id = _request)
      OR EXISTS (SELECT 1 FROM public.supplier_quotation_lines ql
        WHERE ql.quotation_id = _quote AND
          (ql.unit_price IS NULL OR ql.unit_price < 0 OR ql.tax_rate IS NULL
            OR ql.tax_rate < 0 OR ql.tax_rate > 100))
      OR EXISTS (SELECT 1 FROM public.purchase_request_lines l WHERE l.request_id = _request
        AND NOT EXISTS (SELECT 1 FROM public.supplier_quotation_lines ql
          WHERE ql.quotation_id = _quote AND ql.request_line_id = l.id
            AND ql.quantity = l.quantity AND ql.unit IS NOT DISTINCT FROM l.unit
            AND ql.stock_item_id IS NOT DISTINCT FROM l.stock_item_id)) THEN
      RAISE EXCEPTION 'selected_quote_lines_do_not_match_request' USING ERRCODE='22023'; END IF;
  END IF;
  _number := public.next_document_number('purchase_order', 'LPO', _r.branch_id);
  INSERT INTO public.purchase_orders (organization_id, branch_id, department_id, supplier_id,
    request_id, quotation_id, order_number, status, expected_date, deliver_to_location_id,
    currency, created_by, prepared_by)
  VALUES (_org, _r.branch_id, _r.department_id, _supplier, _request, _quote, _number,
    'draft', _expected, _location,
    (SELECT currency FROM public.supplier_quotations WHERE id = _quote),
    auth.uid(), auth.uid()) RETURNING id INTO _order;
  INSERT INTO public.purchase_order_lines (organization_id, order_id, stock_item_id,
    description, quantity, unit, unit_price, tax_rate, tax_amount, line_total)
  SELECT _org, _order, l.stock_item_id, l.description, l.quantity, l.unit,
    ql.unit_price, ql.tax_rate,
    round(l.quantity * ql.unit_price * ql.tax_rate / 100, 2),
    round(l.quantity * ql.unit_price, 2)
      + round(l.quantity * ql.unit_price * ql.tax_rate / 100, 2)
  FROM public.purchase_request_lines l
  JOIN public.supplier_quotation_lines ql ON ql.request_line_id = l.id
    AND ql.quotation_id = _quote
  WHERE l.request_id = _request;
  SELECT count(*), COALESCE(sum(round(quantity * unit_price, 2)), 0), COALESCE(sum(tax_amount), 0)
    INTO _lines, _subtotal, _tax FROM public.purchase_order_lines WHERE order_id = _order;
  IF _lines = 0 OR _subtotal + _tax IS DISTINCT FROM
    (SELECT total_amount FROM public.supplier_quotations WHERE id = _quote) THEN
    RAISE EXCEPTION 'selected_quote_total_mismatch' USING ERRCODE='22023'; END IF;
  UPDATE public.purchase_orders SET subtotal = _subtotal, tax_amount = _tax,
    total_amount = _subtotal + _tax WHERE id = _order;
  UPDATE public.purchase_requests SET status = 'ordered', updated_at = now() WHERE id = _request;
  _prior := jsonb_build_object('ok', true, 'order_id', _order, 'order_number', _number,
    'lines', _lines, 'subtotal', _subtotal, 'tax_amount', _tax, 'quotation_id', _quote,
    'status', 'draft');
  INSERT INTO public.procurement_attempts (organization_id, action, attempt_key, record_id, result)
    VALUES (_org, 'order.create', _attempt, _order, _prior);
  RETURN _prior;
END $$;
