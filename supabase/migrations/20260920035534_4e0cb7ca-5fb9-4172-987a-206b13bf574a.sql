CREATE OR REPLACE FUNCTION public.neo_stock_need_to_procurement(_need uuid, _notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  n public.department_stock_needs;
  v_ref text;
  v_existing uuid;
  v_req uuid;
  v_number text;
  v_outstanding numeric;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT (public.has_permission('procurement','requests.create')
          OR public.has_permission('procurement','create')
          OR public.has_permission('stores','create')
          OR public.neo_can_transfer_stock()) THEN
    RAISE EXCEPTION 'Not permitted to route a shortage to Procurement';
  END IF;

  SELECT * INTO n FROM public.department_stock_needs
   WHERE id = _need AND organization_id = v_org FOR UPDATE;
  IF n.id IS NULL THEN RAISE EXCEPTION 'Stock need not found'; END IF;
  IF n.branch_id IS NULL THEN RAISE EXCEPTION 'This need has no property — it cannot be purchased against'; END IF;
  IF n.stock_item_id IS NULL THEN
    RAISE EXCEPTION 'Link this need to a catalogue stock item before sending it to Procurement, otherwise the delivery cannot be received into stock';
  END IF;

  v_outstanding := greatest(n.quantity - coalesce(n.fulfilled_quantity, 0), 0);
  IF v_outstanding <= 0 THEN RAISE EXCEPTION 'This need has already been issued in full'; END IF;

  v_ref := 'need:' || _need::text;

  SELECT pr.id INTO v_existing FROM public.purchase_requests pr
   WHERE pr.organization_id = v_org
     AND pr.branch_id IS NOT DISTINCT FROM n.branch_id
     AND pr.source_reference = v_ref
     AND pr.status IN ('draft','submitted','pending','pending-approval')
   LIMIT 1;

  IF v_existing IS NOT NULL THEN
    UPDATE public.department_stock_needs
       SET purchase_request_id = v_existing, status = 'with-procurement', updated_at = now()
     WHERE id = _need;
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'request_id', v_existing,
      'request_number', (SELECT request_number FROM public.purchase_requests WHERE id = v_existing));
  END IF;

  SELECT public.next_document_number('purchase-request') INTO v_number;

  BEGIN
    INSERT INTO public.purchase_requests
      (organization_id, branch_id, department_id, request_number, title, justification,
       source, source_reference, status, priority, requested_by)
    VALUES (v_org, n.branch_id, n.department_id, v_number,
            'Department need — ' || n.item,
            coalesce(nullif(btrim(coalesce(_notes,'')), ''), n.notes,
                     'Reported by the department; not available in stores.'),
            'department-stock-need', v_ref, 'draft', coalesce(n.priority,'normal'), auth.uid())
    RETURNING id INTO v_req;

    INSERT INTO public.purchase_request_lines
      (organization_id, request_id, stock_item_id, description, quantity, unit, estimated_unit_price)
    VALUES (v_org, v_req, n.stock_item_id, n.item, v_outstanding, coalesce(n.unit,'unit'), 0);
  EXCEPTION WHEN unique_violation THEN
    SELECT pr.id INTO v_existing FROM public.purchase_requests pr
     WHERE pr.organization_id = v_org
       AND pr.branch_id IS NOT DISTINCT FROM n.branch_id
       AND pr.source_reference = v_ref
       AND pr.status IN ('draft','submitted','pending','pending-approval')
     LIMIT 1;
    UPDATE public.department_stock_needs
       SET purchase_request_id = v_existing, status = 'with-procurement', updated_at = now()
     WHERE id = _need;
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'request_id', v_existing);
  END;

  UPDATE public.department_stock_needs
     SET purchase_request_id = v_req, status = 'with-procurement',
         reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now()
   WHERE id = _need;

  RETURN jsonb_build_object('ok', true, 'request_id', v_req, 'request_number', v_number);
END $function$;

CREATE OR REPLACE FUNCTION public.neo_procurement_order_from_request(_request uuid, _supplier uuid, _expected date, _attempt uuid, _location uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _r record; _order uuid; _number text;
        _prior jsonb; _lines integer := 0; _subtotal numeric := 0; _unlinked text;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE='42501'; END IF;
  IF _attempt IS NULL THEN RAISE EXCEPTION 'attempt_key_required' USING ERRCODE='22023'; END IF;

  SELECT result INTO _prior FROM public.procurement_attempts
   WHERE organization_id=_org AND action='order.create' AND attempt_key=_attempt;
  IF _prior IS NOT NULL THEN RETURN _prior || jsonb_build_object('replayed', true); END IF;

  IF NOT (public.has_permission('procurement','lpos.create') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501';
  END IF;

  SELECT * INTO _r FROM public.purchase_requests WHERE id=_request AND organization_id=_org FOR UPDATE;
  IF _r IS NULL THEN RAISE EXCEPTION 'request_not_found' USING ERRCODE='22023'; END IF;
  IF NOT public.neo_branch_in_scope(_r.branch_id) THEN RAISE EXCEPTION 'branch_out_of_scope' USING ERRCODE='42501'; END IF;
  IF _r.status <> 'approved' THEN RAISE EXCEPTION 'request_not_approved' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id=_supplier AND s.organization_id=_org) THEN
    RAISE EXCEPTION 'supplier_not_approved' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.purchase_orders p
              WHERE p.request_id=_request AND p.status NOT IN ('cancelled','voided')) THEN
    RAISE EXCEPTION 'request_already_ordered' USING ERRCODE='23505';
  END IF;

  -- Goods that must land in a store need a catalogue item, otherwise the
  -- delivery can never be received into the stock ledger.
  IF _location IS NOT NULL THEN
    SELECT string_agg(COALESCE(l.description,'Unnamed item'), ', ') INTO _unlinked
      FROM public.purchase_request_lines l
     WHERE l.request_id=_request AND l.stock_item_id IS NULL;
    IF _unlinked IS NOT NULL THEN
      RAISE EXCEPTION 'Link % to a catalogue stock item before raising a store delivery order', _unlinked
        USING ERRCODE='22023';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_request::text, 42));
  _number := public.next_document_number('purchase_order','LPO', _r.branch_id);

  INSERT INTO public.purchase_orders (organization_id, branch_id, department_id, supplier_id, request_id,
    order_number, status, expected_date, deliver_to_location_id, currency, created_by, prepared_by)
  VALUES (_org, _r.branch_id, _r.department_id, _supplier, _request, _number, 'draft', _expected,
          _location, 'KES', auth.uid(), auth.uid())
  RETURNING id INTO _order;

  INSERT INTO public.purchase_order_lines (organization_id, order_id, stock_item_id, description,
    quantity, unit, unit_price, line_total)
  SELECT _org, _order, l.stock_item_id, l.description, l.quantity, l.unit,
         COALESCE(l.estimated_unit_price,0), l.quantity * COALESCE(l.estimated_unit_price,0)
    FROM public.purchase_request_lines l WHERE l.request_id=_request;

  SELECT count(*), COALESCE(sum(line_total),0) INTO _lines, _subtotal
    FROM public.purchase_order_lines WHERE order_id=_order;
  UPDATE public.purchase_orders SET subtotal=_subtotal, total_amount=_subtotal WHERE id=_order;
  UPDATE public.purchase_requests SET status='ordered', updated_at=now() WHERE id=_request;

  _prior := jsonb_build_object('ok',true,'order_id',_order,'order_number',_number,
                               'lines',_lines,'subtotal',_subtotal,'status','draft');
  INSERT INTO public.procurement_attempts (organization_id, action, attempt_key, record_id, result)
  VALUES (_org,'order.create',_attempt,_order,_prior);
  RETURN _prior;
END $function$;