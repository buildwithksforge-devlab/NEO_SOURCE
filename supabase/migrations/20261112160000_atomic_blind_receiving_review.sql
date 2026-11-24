BEGIN;

CREATE OR REPLACE FUNCTION public.neo_blind_receiving_review_queue()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_result jsonb;
BEGIN
    IF auth.uid() IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION 'Authentication and organization required'
            USING ERRCODE = '42501';
    END IF;

    IF NOT (public.is_org_admin() OR public.has_permission('procurement', 'receiving.manage')) THEN
        RAISE EXCEPTION
            'Independent receiving review requires administrator authorization'
            USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'count_id', c.id,
                'purchase_order_id', c.purchase_order_id,
                'order_number', po.order_number,
                'branch_id', c.branch_id,
                'delivery_note', c.supplier_delivery_note,
                'submitted_by', c.submitted_by,
                'submitted_by_current_user', c.submitted_by = auth.uid(),
                'submitted_at', c.submitted_at,
                'status', c.status,
                'remarks', c.remarks,
                'lines', (
                    SELECT COALESCE(
                        jsonb_agg(
                            jsonb_build_object(
                                'count_line_id', cl.id,
                                'order_line_id', pl.id,
                                'item_name', COALESCE(
                                    (
                                        SELECT si.name
                                        FROM public.stock_items si
                                        WHERE si.id = pl.stock_item_id
                                          AND si.organization_id = v_org
                                    ),
                                    pl.description,
                                    'Unidentified item'
                                ),
                                'unit', pl.unit,
                                'ordered_quantity', pl.quantity,
                                'previously_received', COALESCE(pl.received_quantity, 0),
                                'cancelled_quantity', COALESCE(pl.cancelled_quantity, 0),
                                'outstanding_quantity', GREATEST(
                                    COALESCE(pl.quantity, 0)
                                    - COALESCE(pl.accepted_quantity, 0)
                                    - COALESCE(pl.cancelled_quantity, 0),
                                    0
                                ),
                                'physically_delivered', cl.quantity_delivered,
                                'rejected_quantity', cl.quantity_rejected,
                                'accepted_quantity',
                                    cl.quantity_delivered - cl.quantity_rejected,
                                'difference',
                                    (cl.quantity_delivered - cl.quantity_rejected)
                                    - GREATEST(
                                        COALESCE(pl.quantity, 0)
                                        - COALESCE(pl.accepted_quantity, 0)
                                        - COALESCE(pl.cancelled_quantity, 0),
                                        0
                                    ),
                                'rejection_reason', cl.rejection_reason,
                                'batch_number', cl.batch_number,
                                'expiry_date', cl.expiry_date,
                                'reconciliation_result', CASE
                                    WHEN (cl.quantity_delivered - cl.quantity_rejected) >
                                        GREATEST(
                                            COALESCE(pl.quantity, 0)
                                            - COALESCE(pl.accepted_quantity, 0)
                                            - COALESCE(pl.cancelled_quantity, 0),
                                            0
                                        )
                                    THEN 'excess'
                                    WHEN (cl.quantity_delivered - cl.quantity_rejected) <
                                        GREATEST(
                                            COALESCE(pl.quantity, 0)
                                            - COALESCE(pl.accepted_quantity, 0)
                                            - COALESCE(pl.cancelled_quantity, 0),
                                            0
                                        )
                                    THEN 'partial_delivery'
                                    ELSE 'matched'
                                END
                            )
                            ORDER BY cl.id
                        ),
                        '[]'::jsonb
                    )
                    FROM public.neo_blind_receiving_count_lines cl
                    JOIN public.purchase_order_lines pl
                      ON pl.id = cl.purchase_order_line_id
                     AND pl.order_id = c.purchase_order_id
                    WHERE cl.count_id = c.id
                )
            )
            ORDER BY c.submitted_at
        ),
        '[]'::jsonb
    )
    INTO v_result
    FROM public.neo_blind_receiving_counts c
    JOIN public.purchase_orders po
      ON po.id = c.purchase_order_id
     AND po.organization_id = v_org
     AND po.branch_id = c.branch_id
    WHERE c.organization_id = v_org
      AND c.status IN ('submitted', 'under_review')
      AND public.neo_branch_in_scope(c.branch_id);

    RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_post_approved_blind_receiving(_count_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_count record;
    v_po record;
    v_line record;
    v_lines jsonb := '[]'::jsonb;
    v_result jsonb;
    v_grn_id uuid;
    v_outstanding numeric;
    v_accepted numeric;
    v_line_count integer := 0;
BEGIN
    IF auth.uid() IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION 'Authentication and organization required'
            USING ERRCODE = '42501';
    END IF;

    IF NOT (public.is_org_admin() OR public.has_permission('procurement', 'receiving.manage')) THEN
        RAISE EXCEPTION 'Authorized inventory posting required'
            USING ERRCODE = '42501';
    END IF;

    SELECT *
    INTO v_count
    FROM public.neo_blind_receiving_counts
    WHERE id = _count_id
      AND organization_id = v_org
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Blind receiving count not found'
            USING ERRCODE = '22023';
    END IF;

    IF NOT public.neo_branch_in_scope(v_count.branch_id) THEN
        RAISE EXCEPTION 'Receiving count outside authorized branch'
            USING ERRCODE = '42501';
    END IF;

    IF v_count.submitted_by = auth.uid() THEN
        RAISE EXCEPTION 'You cannot post your own receiving count'
            USING ERRCODE = '42501';
    END IF;

    IF v_count.status = 'posted' OR v_count.posted_grn_id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'ok', true,
            'replayed', true,
            'count_id', v_count.id,
            'grn_id', v_count.posted_grn_id,
            'status', v_count.status
        );
    END IF;

    IF lower(concat_ws(
        ' ',
        v_count.supplier_delivery_note,
        v_count.remarks,
        v_count.review_notes
    )) LIKE ANY (ARRAY[
        '%virtual test only%',
        '%no actual goods%',
        '%no real goods%',
        '%no physical goods%',
        '%simulation only%',
        '%no supplier commitment%'
    ]) THEN
        RAISE EXCEPTION
            'This count is marked as virtual/test-only; inventory posting is prohibited'
            USING ERRCODE = '22023';
    END IF;

    IF v_count.status <> 'approved' THEN
        RAISE EXCEPTION 'Only independently approved counts may be posted'
            USING ERRCODE = '22023';
    END IF;

    IF v_count.reviewed_by IS NULL OR v_count.reviewed_at IS NULL THEN
        RAISE EXCEPTION 'Independent review record is incomplete'
            USING ERRCODE = '22023';
    END IF;

    IF v_count.submitted_by = v_count.reviewed_by THEN
        RAISE EXCEPTION 'Receiving Clerk cannot approve their own count'
            USING ERRCODE = '42501';
    END IF;

    SELECT *
    INTO v_po
    FROM public.purchase_orders
    WHERE id = v_count.purchase_order_id
      AND organization_id = v_org
      AND branch_id = v_count.branch_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Linked purchase order is invalid'
            USING ERRCODE = '22023';
    END IF;

    IF v_po.status NOT IN (
        'approved',
        'pending-delivery',
        'sent',
        'partially-received',
        'partially_received'
    ) THEN
        RAISE EXCEPTION 'Purchase order is no longer eligible for receiving'
            USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.stock_locations sl
        WHERE sl.id = v_count.receiving_location_id
          AND sl.organization_id = v_org
          AND sl.active = true
          AND (sl.branch_id = v_count.branch_id OR sl.branch_id IS NULL)
    ) THEN
        RAISE EXCEPTION 'Approved receiving location is no longer valid'
            USING ERRCODE = '22023';
    END IF;

    FOR v_line IN
        SELECT
            cl.purchase_order_line_id,
            cl.quantity_delivered,
            cl.quantity_rejected,
            cl.rejection_reason,
            cl.batch_number,
            cl.expiry_date,
            pl.quantity AS ordered_quantity,
            pl.received_quantity,
            pl.accepted_quantity,
            pl.cancelled_quantity,
            pl.stock_item_id
        FROM public.neo_blind_receiving_count_lines cl
        JOIN public.purchase_order_lines pl
          ON pl.id = cl.purchase_order_line_id
         AND pl.order_id = v_count.purchase_order_id
        WHERE cl.count_id = _count_id
        ORDER BY cl.id
    LOOP
        v_line_count := v_line_count + 1;
        v_accepted := v_line.quantity_delivered - v_line.quantity_rejected;
        v_outstanding := GREATEST(
            COALESCE(v_line.ordered_quantity, 0)
            - COALESCE(v_line.accepted_quantity, 0)
            - COALESCE(v_line.cancelled_quantity, 0),
            0
        );

        IF v_accepted < 0 THEN
            RAISE EXCEPTION 'Invalid accepted quantity in original physical count'
                USING ERRCODE = '22023';
        END IF;

        IF v_accepted > v_outstanding THEN
            RAISE EXCEPTION 'Approved accepted quantity exceeds current outstanding PO quantity'
                USING ERRCODE = '22023';
        END IF;

        IF v_line.stock_item_id IS NULL THEN
            RAISE EXCEPTION 'Purchase order line is not linked to a stock item'
                USING ERRCODE = '22023';
        END IF;

        IF v_line.quantity_delivered > 0 THEN
            v_lines := v_lines || jsonb_build_array(
                jsonb_build_object(
                    'order_line_id', v_line.purchase_order_line_id,
                    'quantity_received', v_line.quantity_delivered,
                    'quantity_rejected', v_line.quantity_rejected,
                    'rejection_reason', v_line.rejection_reason,
                    'batch_number', v_line.batch_number,
                    'expiry_date', v_line.expiry_date
                )
            );
        END IF;
    END LOOP;

    IF v_line_count = 0 OR jsonb_array_length(v_lines) = 0 THEN
        RAISE EXCEPTION 'No physical delivery quantities available to post'
            USING ERRCODE = '22023';
    END IF;

    v_result := public.neo_stores_receive_goods(
        v_count.purchase_order_id,
        v_count.receiving_location_id,
        v_lines,
        v_count.id,
        CONCAT(
            'Blind receiving count: ',
            v_count.id::text,
            CASE WHEN v_count.remarks IS NOT NULL THEN ' | ' || v_count.remarks ELSE '' END
        ),
        NULL,
        v_count.supplier_delivery_note,
        NULL
    );

    v_grn_id := COALESCE(
        NULLIF(v_result->>'grn_id', ''),
        NULLIF(v_result->>'receipt_id', ''),
        NULLIF(v_result->>'goods_receipt_id', ''),
        NULLIF(v_result->>'goods_receipt', '')
    )::uuid;

    IF v_grn_id IS NULL THEN
        RAISE EXCEPTION 'Receiving lifecycle did not return a GRN identifier'
            USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.goods_receipts gr
        WHERE gr.id = v_grn_id
          AND gr.organization_id = v_org
          AND gr.order_id = v_count.purchase_order_id
    ) THEN
        RAISE EXCEPTION 'Generated GRN does not match the approved count'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.neo_blind_receiving_counts
    SET status = 'posted', posted_grn_id = v_grn_id
    WHERE id = _count_id;

    RETURN jsonb_build_object(
        'ok', true,
        'count_id', _count_id,
        'grn_id', v_grn_id,
        'status', 'posted',
        'replayed', false,
        'lifecycle_result', v_result
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_blind_receiving_decide(
    _count_id uuid,
    _decision text,
    _notes text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_org uuid := public.current_org_id();
    v_count record;
    v_excess integer;
    v_lines integer;
    v_decision text := lower(btrim(_decision));
    v_notes text := NULLIF(btrim(_notes), '');
    v_posting jsonb;
BEGIN
    IF auth.uid() IS NULL OR v_org IS NULL THEN
        RAISE EXCEPTION 'Authentication and organization required'
            USING ERRCODE = '42501';
    END IF;

    IF NOT (public.is_org_admin() OR public.has_permission('procurement', 'receiving.manage')) THEN
        RAISE EXCEPTION 'Independent review authorization required'
            USING ERRCODE = '42501';
    END IF;

    IF v_decision NOT IN ('approved', 'rejected') THEN
        RAISE EXCEPTION 'Decision must be approved or rejected'
            USING ERRCODE = '22023';
    END IF;

    IF v_notes IS NULL THEN
        RAISE EXCEPTION 'A review reason is required'
            USING ERRCODE = '22023';
    END IF;

    SELECT c.*
    INTO v_count
    FROM public.neo_blind_receiving_counts c
    WHERE c.id = _count_id
      AND c.organization_id = v_org
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Blind receiving count not found'
            USING ERRCODE = '22023';
    END IF;

    IF NOT public.neo_branch_in_scope(v_count.branch_id) THEN
        RAISE EXCEPTION 'Count is outside authorized branch'
            USING ERRCODE = '42501';
    END IF;

    IF v_count.submitted_by = auth.uid() THEN
        RAISE EXCEPTION 'You cannot review your own receiving count'
            USING ERRCODE = '42501';
    END IF;

    IF v_count.status NOT IN ('submitted', 'under_review') THEN
        RAISE EXCEPTION 'This count has already been decided'
            USING ERRCODE = '22023';
    END IF;

    SELECT
        count(*),
        count(*) FILTER (
            WHERE (cl.quantity_delivered - cl.quantity_rejected) >
                GREATEST(
                    COALESCE(pl.quantity, 0)
                    - COALESCE(pl.accepted_quantity, 0)
                    - COALESCE(pl.cancelled_quantity, 0),
                    0
                )
        )
    INTO v_lines, v_excess
    FROM public.neo_blind_receiving_count_lines cl
    JOIN public.purchase_order_lines pl
      ON pl.id = cl.purchase_order_line_id
     AND pl.order_id = v_count.purchase_order_id
    WHERE cl.count_id = _count_id;

    IF v_lines = 0 THEN
        RAISE EXCEPTION 'Cannot review a count without lines'
            USING ERRCODE = '22023';
    END IF;

    IF v_decision = 'approved' AND v_excess > 0 THEN
        RAISE EXCEPTION
            'Excess accepted quantities require separate exception authorization; approval blocked'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.neo_blind_receiving_counts
    SET
        status = v_decision,
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        review_notes = v_notes
    WHERE id = _count_id;

    IF v_decision = 'approved' THEN
        v_posting := public.neo_post_approved_blind_receiving(_count_id);

        IF COALESCE((v_posting->>'ok')::boolean, false) IS NOT TRUE
           OR NULLIF(v_posting->>'grn_id', '') IS NULL THEN
            RAISE EXCEPTION
                'Approved count did not produce a verified GRN and stock posting'
                USING ERRCODE = '22023';
        END IF;

        RETURN jsonb_build_object(
            'ok', true,
            'count_id', _count_id,
            'status', 'posted',
            'reviewed_by', auth.uid(),
            'grn_id', v_posting->>'grn_id',
            'stock_posted', true,
            'posting_result', v_posting
        );
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'count_id', _count_id,
        'status', 'rejected',
        'reviewed_by', auth.uid(),
        'stock_posted', false,
        'finance_posted', false
    );
END;
$function$;

REVOKE DELETE ON
    public.purchase_orders,
    public.purchase_order_lines,
    public.goods_receipts,
    public.goods_receipt_lines
FROM authenticated;

-- BEGIN REVIEWED CORE RECEIVING REPAIR
-- Preserve physical receipt/rejection history; accepted goods fulfil the order.
-- Refuse unknown installed code instead of overwriting unrelated backend work.
DO $guard$
DECLARE current_body text;
BEGIN
  SELECT prosrc INTO current_body FROM pg_proc
   WHERE oid=to_regprocedure('public.neo_stores_receive_goods(uuid,uuid,jsonb,uuid,text,text,text,text)');
  IF current_body IS NULL OR md5(replace(current_body,E'\r\n',E'\n')) NOT IN ('0e3af29582b038212986e00de790b47a','802705cada2b16fd183e4e7e5d9f1ad4') THEN
    RAISE EXCEPTION 'Receiving engine differs from reviewed source; inspect before installation';
  END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.neo_stores_receive_goods(
  _order uuid, _location uuid, _lines jsonb, _attempt uuid, _notes text DEFAULT NULL,
  _over_receipt_reason text DEFAULT NULL, _delivery_note text DEFAULT NULL, _supplier_invoice text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE _org uuid := public.current_org_id(); _p record; _line jsonb; _pl record;
        _grn uuid; _number text; _prior jsonb; _count integer := 0;
        _qty numeric; _accepted numeric; _request jsonb; _outstanding numeric; _lreason text; _post jsonb; _partial boolean := false;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE='42501'; END IF;
  IF _attempt IS NULL THEN RAISE EXCEPTION 'attempt_key_required' USING ERRCODE='22023'; END IF;

  _request := jsonb_build_object('order', _order, 'location', _location, 'lines', _lines,
    'notes', _notes, 'over_receipt_reason', _over_receipt_reason,
    'delivery_note', _delivery_note, 'supplier_invoice', _supplier_invoice);

  IF NOT (public.has_permission('procurement','receiving.manage')
          OR public.has_permission('procurement','receiving.create')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501';
  END IF;

  SELECT * INTO _p FROM public.purchase_orders WHERE id=_order AND organization_id=_org;
  IF _p IS NULL THEN RAISE EXCEPTION 'order_not_found' USING ERRCODE='22023'; END IF;
  IF NOT public.neo_branch_in_scope(_p.branch_id) THEN RAISE EXCEPTION 'branch_out_of_scope' USING ERRCODE='42501'; END IF;
  SELECT result INTO _prior FROM public.procurement_attempts
   WHERE organization_id=_org AND action='goods.receive' AND attempt_key=_attempt;
  IF _prior IS NOT NULL THEN
    IF (_prior ? 'request' AND _prior->'request' IS DISTINCT FROM _request)
       OR NOT EXISTS (SELECT 1 FROM public.goods_receipts
         WHERE id=(_prior->>'receipt_id')::uuid AND organization_id=_org
           AND order_id=_order AND location_id=_location) THEN
      RAISE EXCEPTION 'receipt_attempt_input_mismatch' USING ERRCODE='23514';
    END IF;
    RETURN _prior || jsonb_build_object('replayed', true);
  END IF;

  IF _p.status NOT IN ('approved','pending-delivery','sent','partially-received','partially_received') THEN
    RAISE EXCEPTION 'order_not_receivable' USING ERRCODE='22023';
  END IF;
  IF _location IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.stock_locations sl WHERE sl.id=_location AND sl.organization_id=_org AND sl.active
      AND (sl.branch_id IS NULL OR (sl.branch_id=_p.branch_id AND public.neo_branch_in_scope(sl.branch_id)))) THEN
    RAISE EXCEPTION 'store_location_required' USING ERRCODE='22023';
  END IF;
  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'no_receipt_lines' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('grn:'||_order::text, 7));
  SELECT result INTO _prior FROM public.procurement_attempts
   WHERE organization_id=_org AND action='goods.receive' AND attempt_key=_attempt;
  IF _prior IS NOT NULL THEN
    IF (_prior ? 'request' AND _prior->'request' IS DISTINCT FROM _request)
       OR NOT EXISTS (SELECT 1 FROM public.goods_receipts
         WHERE id=(_prior->>'receipt_id')::uuid AND organization_id=_org
           AND order_id=_order AND location_id=_location) THEN
      RAISE EXCEPTION 'receipt_attempt_input_mismatch' USING ERRCODE='23514';
    END IF;
    RETURN _prior || jsonb_build_object('replayed', true);
  END IF;

  -- Re-read current eligibility under the same order lock used for receiving.
  SELECT * INTO _p FROM public.purchase_orders WHERE id=_order AND organization_id=_org FOR UPDATE;
  IF _p.status NOT IN ('approved','pending-delivery','sent','partially-received','partially_received') THEN
    RAISE EXCEPTION 'order_not_receivable' USING ERRCODE='22023';
  END IF;

  -- O03: Prevent one receipt request from repeating the same PO line.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(_lines) AS entry(line)
    GROUP BY entry.line->>'order_line_id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate_order_line_in_receipt'
      USING ERRCODE = '23514';
  END IF;

  -- O03: Ensure rejected and damaged quantities are valid.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(_lines) AS entry(line)
    WHERE COALESCE((entry.line->>'quantity_received')::numeric, 0) < 0
       OR COALESCE((entry.line->>'quantity_rejected')::numeric, 0) < 0
       OR COALESCE((entry.line->>'quantity_damaged')::numeric, 0) < 0
       OR (
         COALESCE((entry.line->>'quantity_rejected')::numeric, 0)
         + COALESCE((entry.line->>'quantity_damaged')::numeric, 0)
       ) > COALESCE((entry.line->>'quantity_received')::numeric, 0)
  ) THEN
    RAISE EXCEPTION 'invalid_receipt_quantities'
      USING ERRCODE = '23514';
  END IF;

  _number := public.next_document_number('goods_receipt','GRN', _p.branch_id);
  INSERT INTO public.goods_receipts (organization_id, branch_id, order_id, supplier_id, location_id,
    grn_number, status, received_at, received_by, notes, delivery_note_number, supplier_invoice_number)
  VALUES (_org, _p.branch_id, _order, _p.supplier_id, _location, _number, 'received', now(), auth.uid(),
          _notes, nullif(btrim(coalesce(_delivery_note,'')),''), nullif(btrim(coalesce(_supplier_invoice,'')),''))
  RETURNING id INTO _grn;

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    SELECT * INTO _pl FROM public.purchase_order_lines
     WHERE id = (_line->>'order_line_id')::uuid AND order_id = _order FOR UPDATE;
    IF _pl IS NULL THEN RAISE EXCEPTION 'order_line_not_on_order' USING ERRCODE='22023'; END IF;

    _qty := COALESCE((_line->>'quantity_received')::numeric, 0);
    IF _qty <= 0 THEN CONTINUE; END IF;

    _lreason := nullif(btrim(coalesce(_line->>'over_receipt_reason', _over_receipt_reason, '')), '');

    _accepted := _qty - COALESCE((_line->>'quantity_rejected')::numeric,0)
                      - COALESCE((_line->>'quantity_damaged')::numeric,0);
    IF nullif(_line->>'location_id','') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.stock_locations sl
       WHERE sl.id=(_line->>'location_id')::uuid AND sl.organization_id=_org AND sl.active
         AND (sl.branch_id IS NULL OR (sl.branch_id=_p.branch_id AND public.neo_branch_in_scope(sl.branch_id)))
    ) THEN RAISE EXCEPTION 'receipt_line_location_out_of_scope' USING ERRCODE='42501'; END IF;
    _outstanding := GREATEST(COALESCE(_pl.quantity,0) - COALESCE(_pl.cancelled_quantity,0) - COALESCE(_pl.accepted_quantity,0),0);
    IF _accepted > _outstanding THEN
      RAISE EXCEPTION 'over_receipt_refused: % outstanding on this line, % offered', _outstanding, _accepted
        USING ERRCODE='23514';
    END IF;

    INSERT INTO public.goods_receipt_lines (organization_id, receipt_id, order_line_id, stock_item_id,
      quantity_ordered, quantity_previously_received, quantity_received, quantity_rejected, quantity_damaged,
      quantity_accepted, unit, unit_price, batch_number, expiry_date, location_id, notes,
      rejection_reason, over_receipt_reason)
    VALUES (_org, _grn, _pl.id, _pl.stock_item_id, _pl.quantity, COALESCE(_pl.received_quantity,0), _qty,
      COALESCE((_line->>'quantity_rejected')::numeric,0), COALESCE((_line->>'quantity_damaged')::numeric,0),
      GREATEST(_qty - COALESCE((_line->>'quantity_rejected')::numeric,0)
                    - COALESCE((_line->>'quantity_damaged')::numeric,0), 0),
      COALESCE(_line->>'unit', _pl.unit), _pl.unit_price,
      nullif(_line->>'batch_number',''), (nullif(_line->>'expiry_date',''))::date,
      COALESCE((nullif(_line->>'location_id',''))::uuid, _location), nullif(_line->>'notes',''),
      nullif(btrim(coalesce(_line->>'rejection_reason','')),''),
      CASE WHEN _qty > _outstanding + 0.0001 THEN _lreason ELSE NULL END);
    _count := _count + 1;
  END LOOP;

  IF _count = 0 THEN RAISE EXCEPTION 'no_receipt_lines' USING ERRCODE='22023'; END IF;

  _post := public.inventory_post_receipt(_grn);

  SELECT EXISTS (
    SELECT 1 FROM public.purchase_order_lines pl
     WHERE pl.order_id=_order
       AND COALESCE(pl.accepted_quantity,0) + COALESCE(pl.cancelled_quantity,0) < pl.quantity
  ) INTO _partial;
  UPDATE public.goods_receipts SET is_partial=_partial WHERE id=_grn;

  _prior := jsonb_build_object('ok',true,'receipt_id',_grn,'grn_number',_number,
              'lines',_count,'posting',_post,'partial',_partial,
              'order_status',(SELECT status FROM public.purchase_orders WHERE id=_order), 'request', _request);
  INSERT INTO public.procurement_attempts (organization_id, action, attempt_key, record_id, result)
  VALUES (_org,'goods.receive',_attempt,_grn,_prior);
  RETURN _prior;
END $$;
-- END REVIEWED CORE RECEIVING REPAIR

COMMIT;
