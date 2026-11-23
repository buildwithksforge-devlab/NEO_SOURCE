BEGIN;

CREATE OR REPLACE FUNCTION public.neo_procurement_order_from_request(_request uuid, _supplier uuid, _expected date, _attempt uuid, _location uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _r record; _order uuid; _number text;
        _prior jsonb; _lines integer := 0; _subtotal numeric := 0; _unlinked text;
        _quote public.supplier_quotations; _quote_count integer; _quote_lines integer;
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

  -- Lock the selected quotation while its pricing is copied into the draft.
  SELECT count(*) INTO _quote_count FROM public.supplier_quotations q
   WHERE q.organization_id=_org AND q.request_id=_request AND q.selected;
  IF _quote_count > 1 THEN
    RAISE EXCEPTION 'Resolve the multiple recommended quotations before creating this LPO' USING ERRCODE='23514';
  END IF;
  IF _quote_count = 1 THEN
    SELECT * INTO STRICT _quote FROM public.supplier_quotations q
     WHERE q.organization_id=_org AND q.request_id=_request AND q.selected FOR UPDATE;
    IF _quote.supplier_id IS DISTINCT FROM _supplier OR _quote.branch_id IS DISTINCT FROM _r.branch_id
       OR (_quote.valid_until IS NOT NULL AND _quote.valid_until < (now() AT TIME ZONE 'Africa/Nairobi')::date) THEN
      RAISE EXCEPTION 'Choose the recommended supplier and a current quotation for this property' USING ERRCODE='23514';
    END IF;
    LOCK TABLE public.supplier_quotation_lines IN SHARE MODE;
    SELECT count(*) INTO _quote_lines FROM public.supplier_quotation_lines WHERE quotation_id=_quote.id;
    IF _quote_lines = 0 THEN
      -- Older staff-entered quotations contain only a total.
      IF _quote.total_amount IS DISTINCT FROM (
        SELECT round(sum(quantity*coalesce(estimated_unit_price,0)),2)
        FROM public.purchase_request_lines WHERE request_id=_request AND organization_id=_org
      ) THEN
        RAISE EXCEPTION 'The recommended quotation total differs from the approved request. Record the quoted line prices before creating this LPO' USING ERRCODE='23514';
      END IF;
    ELSIF EXISTS (
      SELECT 1 FROM public.purchase_request_lines l
      WHERE l.request_id=_request AND l.organization_id=_org AND (
        SELECT count(*) FROM public.supplier_quotation_lines q
        WHERE q.organization_id=_org AND q.quotation_id=_quote.id AND q.request_line_id=l.id
          AND q.stock_item_id IS NOT DISTINCT FROM l.stock_item_id
          AND q.quantity=l.quantity AND q.unit IS NOT DISTINCT FROM l.unit
          AND q.tax_rate=0 AND q.unit_price>=0 AND q.unit_price::text NOT IN ('NaN','Infinity','-Infinity')
      )<>1
    ) OR _quote_lines
          <> (SELECT count(*) FROM public.purchase_request_lines WHERE request_id=_request AND organization_id=_org)
      OR _quote.total_amount IS DISTINCT FROM (
        SELECT round(sum(quantity*unit_price),2) FROM public.supplier_quotation_lines
        WHERE quotation_id=_quote.id AND organization_id=_org
      ) THEN
      RAISE EXCEPTION 'The recommended quotation needs matching line quantities, units, prices and total before it can become an LPO' USING ERRCODE='23514';
    END IF;
  END IF;

  -- Goods that must land in a store need a catalogue item, otherwise the
  -- delivery can never be received into the stock ledger.
  IF _location IS NOT NULL THEN
    SELECT string_agg(COALESCE(l.description,'Unnamed item'), ', ') INTO _unlinked
      FROM public.purchase_request_lines l
     WHERE l.request_id=_request AND l.organization_id=_org AND l.stock_item_id IS NULL;
    IF _unlinked IS NOT NULL THEN
      RAISE EXCEPTION 'Link % to a catalogue stock item before raising a store delivery order', _unlinked
        USING ERRCODE='22023';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_request::text, 42));
  _number := public.next_document_number('purchase_order','LPO', _r.branch_id);

  INSERT INTO public.purchase_orders (organization_id, branch_id, department_id, supplier_id, request_id,
    order_number, status, expected_date, deliver_to_location_id, currency, created_by, prepared_by, quotation_id)
  VALUES (_org, _r.branch_id, _r.department_id, _supplier, _request, _number, 'draft', _expected,
          _location, coalesce(_quote.currency,'KES'), auth.uid(), auth.uid(), _quote.id)
  RETURNING id INTO _order;

  INSERT INTO public.purchase_order_lines (organization_id, order_id, stock_item_id, description,
    quantity, unit, unit_price, line_total)
  SELECT _org, _order, l.stock_item_id, l.description, l.quantity, l.unit,
         coalesce(q.unit_price,l.estimated_unit_price,0), l.quantity * coalesce(q.unit_price,l.estimated_unit_price,0)
    FROM public.purchase_request_lines l
    LEFT JOIN public.supplier_quotation_lines q ON q.quotation_id=_quote.id AND q.request_line_id=l.id AND q.organization_id=_org
    WHERE l.request_id=_request AND l.organization_id=_org;

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

COMMIT;
