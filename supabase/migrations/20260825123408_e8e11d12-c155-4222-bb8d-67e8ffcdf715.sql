-- 1a. Raising a requisition
CREATE OR REPLACE FUNCTION public.neo_requisition_supervisor_authority()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_org_admin()
      OR public.has_permission('stores','approve')
      OR public.has_permission('housekeeping','approve')
      OR public.has_permission('maintenance','approve')
      OR public.has_permission('restaurant','approve')
      OR public.has_permission('bar','approve')
      OR public.has_permission('pos','approve')
      OR public.has_permission('kitchen','approve')
      OR public.has_permission('delivery','approve')
      OR public.has_permission('pms','approve')
      OR public.has_permission('front-office','approve')
      OR public.has_permission('events','approve')
      OR public.has_permission('security','approve');
$$;

CREATE OR REPLACE FUNCTION public.neo_department_requisition_create(
  _branch uuid, _lines jsonb, _department uuid DEFAULT NULL::uuid,
  _required_date date DEFAULT NULL::date, _priority text DEFAULT 'normal'::text,
  _reason text DEFAULT NULL::text, _destination uuid DEFAULT NULL::uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid := current_org_id();
  v_req uuid;
  v_line jsonb;
  v_count int := 0;
  v_number text;
  v_status text;
  v_self boolean := public.neo_requisition_supervisor_authority();
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
  v_status := CASE WHEN v_self THEN 'awaiting-stores' ELSE 'pending-supervisor' END;

  INSERT INTO public.internal_requisitions
    (organization_id, branch_id, request_number, department_id, destination_location_id,
     fulfilment_model, requested_by, request_date, required_date, priority, reason, status,
     supervisor_approved_by, supervisor_approved_at)
  VALUES (v_org, _branch, v_number, _department, _destination,
          'stores-issue', auth.uid(), current_date, _required_date,
          coalesce(_priority, 'normal'), _reason, v_status,
          CASE WHEN v_self THEN auth.uid() END,
          CASE WHEN v_self THEN now() END)
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

  PERFORM public.neo_notify(v_org, NULL, _branch, 'operational-alert',
    CASE WHEN v_self THEN 'Requisition awaiting Stores — ' || v_number
         ELSE 'Requisition awaiting departmental approval — ' || v_number END,
    coalesce(_reason, 'A department has requested stock from Stores.'),
    '/inventory/requisitions', coalesce(_priority,'normal'), true,
    'stores', v_req, 'stores.requisition_raised', 'req:' || v_req::text || ':raised');

  RETURN jsonb_build_object('ok', true, 'requisition_id', v_req,
                            'request_number', v_number, 'lines', v_count,
                            'status', v_status);
END $$;

-- 1b. Supervisor approval open to departmental approvers
CREATE OR REPLACE FUNCTION public.req_approve(
  _requisition uuid, _lines jsonb DEFAULT '[]'::jsonb, _stage text DEFAULT 'supervisor'::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := current_org_id(); v_req record; v_line jsonb; v_partial boolean := false;
BEGIN
  IF _stage = 'supervisor' THEN
    IF NOT public.neo_requisition_supervisor_authority() THEN
      RAISE EXCEPTION 'Not permitted to approve requisitions';
    END IF;
  ELSIF NOT (has_permission('stores','approve') OR has_permission('housekeeping','approve')
             OR has_permission('maintenance','approve') OR is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to approve requisitions';
  END IF;

  SELECT * INTO v_req FROM internal_requisitions WHERE id=_requisition AND organization_id=v_org FOR UPDATE;
  IF v_req IS NULL THEN RAISE EXCEPTION 'Unknown requisition'; END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(_lines,'[]'::jsonb)) LOOP
    UPDATE internal_requisition_lines
       SET quantity_approved = (v_line->>'quantity_approved')::numeric
     WHERE id = (v_line->>'id')::uuid AND requisition_id = _requisition;
  END LOOP;

  UPDATE internal_requisition_lines
     SET quantity_approved = COALESCE(quantity_approved, quantity_requested)
   WHERE requisition_id = _requisition;

  SELECT EXISTS (SELECT 1 FROM internal_requisition_lines
                  WHERE requisition_id=_requisition AND quantity_approved < quantity_requested)
    INTO v_partial;

  IF _stage = 'supervisor' THEN
    UPDATE internal_requisitions
       SET status='awaiting-stores', supervisor_approved_by=auth.uid(), supervisor_approved_at=now()
     WHERE id=_requisition;
    PERFORM public.neo_notify(v_org, NULL, v_req.branch_id, 'operational-alert',
      'Requisition released to Stores — ' || coalesce(v_req.request_number,''),
      'A departmental supervisor approved the request. Stores can now review and issue.',
      '/inventory/requisitions', coalesce(v_req.priority,'normal'), true,
      'stores', _requisition, 'stores.requisition_released',
      'req:' || _requisition::text || ':released');
  ELSE
    UPDATE internal_requisitions
       SET status = CASE WHEN v_partial THEN 'partially-approved' ELSE 'ready-for-issue' END,
           store_reviewed_by=auth.uid(), store_reviewed_at=now()
     WHERE id=_requisition;
  END IF;
  RETURN jsonb_build_object('ok', true, 'partial', v_partial, 'stage', _stage);
END $$;

UPDATE public.internal_requisitions
   SET status = 'awaiting-stores', supervisor_approved_at = coalesce(supervisor_approved_at, now())
 WHERE status = 'pending-supervisor';

-- 2. Event confirmation builds billing
CREATE OR REPLACE FUNCTION public.neo_event_confirm_build_billing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE res jsonb;
BEGIN
  IF lower(coalesce(NEW.status,'')) <> 'confirmed' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND lower(coalesce(OLD.status,'')) = lower(coalesce(NEW.status,'')) THEN RETURN NEW; END IF;
  IF coalesce(NEW.billing_status,'') = 'finalised' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.event_billing_items WHERE booking_id = NEW.id) THEN RETURN NEW; END IF;

  BEGIN
    res := public.neo_event_billing_build(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.neo_notify(NEW.organization_id, NEW.coordinator_id, NEW.branch_id, 'operational-alert',
      'Event bill needs building — ' || coalesce(NEW.event_reference,''),
      'The event was confirmed but its billing lines could not be generated automatically: ' || SQLERRM,
      '/events/billing', 'high', true, 'events', NEW.id, 'events.billing_pending',
      'event:' || NEW.id::text || ':billing_pending');
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS neo_event_confirm_build_billing_trg ON public.event_bookings;
CREATE TRIGGER neo_event_confirm_build_billing_trg
AFTER INSERT OR UPDATE OF status ON public.event_bookings
FOR EACH ROW EXECUTE FUNCTION public.neo_event_confirm_build_billing();

-- 3. Refunds reach Finance
CREATE OR REPLACE FUNCTION public.neo_finance_post_refund(
  _source_type text, _source_id uuid, _silent boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  org uuid := public.current_org_id();
  branch uuid; cur text; ref text; occurred date; amount numeric := 0;
  customer uuid; settle text; revenue text; lines jsonb; res jsonb;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_source_type || ':' || _source_id::text, 0));

  IF _source_type = 'pos_refund' THEN
    SELECT r.amount, r.branch_id, o.order_number, o.order_type, o.customer_id,
           coalesce(r.method, p.method), coalesce(r.decided_at, r.created_at)::date
      INTO amount, branch, ref, revenue, customer, settle, occurred
      FROM public.pos_refund_requests r
      JOIN public.pos_orders o ON o.id = r.order_id
      LEFT JOIN public.pos_payments p ON p.id = r.payment_id
     WHERE r.id = _source_id AND r.organization_id = org;
    IF amount IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    revenue := public.neo_gl_revenue_code(revenue);
  ELSIF _source_type = 'folio_refund' THEN
    SELECT r.amount, r.branch_id, coalesce(p.receipt_number, 'Refund'), p.customer_id,
           p.method, coalesce(r.processed_at, r.created_at)::date
      INTO amount, branch, ref, customer, settle, occurred
      FROM public.refunds r
      LEFT JOIN public.payments p ON p.id = r.payment_id
     WHERE r.id = _source_id AND r.organization_id = org;
    IF amount IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    revenue := '1060';
  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_source_type');
  END IF;

  IF coalesce(amount,0) <= 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount'); END IF;

  settle := coalesce(public.neo_gl_settlement_code(settle), '1010');
  cur := public.neo_fact_currency(org, branch);
  occurred := coalesce(occurred, (now() AT TIME ZONE public.neo_fact_timezone(org, branch))::date);

  lines := jsonb_build_array(
    jsonb_build_object('code', revenue, 'debit', amount, 'description', 'Refund ' || coalesce(ref,'')),
    jsonb_build_object('code', settle, 'credit', amount, 'description', 'Cash / settlement returned'));

  res := public.neo_gl_post(org, branch, 'refund', _source_type, _source_id, 'refund',
                            occurred, cur, 'Refund ' || coalesce(ref,''), lines, customer, NULL);

  PERFORM public.neo_record_posting_receipt(org, branch, _source_type, _source_id, ref,
    'posted', amount, cur, NULL, 'Posted to journal ' || (res->>'journal_id'), NULL, occurred);

  PERFORM public.emit_domain_event(org, branch, 'finance.posted', _source_type, _source_id,
    jsonb_build_object('posting_type', 'refund', 'amount', amount, 'currency', cur,
                       'journal_id', res->>'journal_id', 'occurred_on', occurred),
    'finance.posted:' || _source_type || ':' || _source_id::text, customer);

  RETURN res || jsonb_build_object('ok', true, 'amount', amount, 'posting_type', 'refund');
EXCEPTION WHEN OTHERS THEN
  IF _silent THEN RETURN jsonb_build_object('ok', false, 'reason', 'failed', 'detail', SQLERRM); END IF;
  RAISE;
END $$;

CREATE OR REPLACE FUNCTION public.neo_pos_refund_decide(
  _request uuid, _approve boolean, _note text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.pos_refund_requests; post jsonb;
BEGIN
  SELECT * INTO r FROM public.pos_refund_requests WHERE id = _request FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Refund request not found'; END IF;
  IF NOT (public.is_org_admin() OR public.has_permission('pos','refunds.approve')
          OR public.has_permission('pos','approve') OR public.has_permission('finance','approve')) THEN
    RAISE EXCEPTION 'Not permitted to decide refunds' USING ERRCODE = '42501';
  END IF;
  IF r.requested_by = auth.uid() AND NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'You cannot approve your own refund request';
  END IF;
  IF r.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'status', r.status);
  END IF;

  UPDATE public.pos_refund_requests
     SET status = CASE WHEN _approve THEN 'processed' ELSE 'rejected' END,
         decided_by = auth.uid(), decided_at = now(), decision_note = _note
   WHERE id = r.id;

  IF NOT _approve THEN
    RETURN jsonb_build_object('ok', true, 'status', 'rejected');
  END IF;

  UPDATE public.pos_payments SET status = 'refunded' WHERE id = r.payment_id;
  post := public.neo_finance_post_refund('pos_refund', r.id, true);

  PERFORM public.neo_notify(r.organization_id, NULL, r.branch_id, 'operational-alert',
    'Refund approved — Finance posting', 'A POS refund was approved and sent to the ledger.',
    '/finance/postings', 'normal', false, 'finance', r.id, 'finance.refund_posted',
    'refund:' || r.id::text || ':posted');

  RETURN jsonb_build_object('ok', true, 'status', 'processed', 'finance', post);
END $$;

CREATE OR REPLACE FUNCTION public.neo_approval_execute(_request uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.approval_requests; _err text; _did boolean := false; _refund uuid;
BEGIN
  SELECT * INTO r FROM public.approval_requests WHERE id = _request FOR UPDATE;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not found'); END IF;
  IF r.execution_status = 'succeeded' THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true);
  END IF;
  IF r.status NOT IN ('approved_pending_execution','execution_failed','executing') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'request is not awaiting execution');
  END IF;

  UPDATE public.approval_requests SET status = 'executing', execution_status = 'running' WHERE id = r.id;

  BEGIN
    UPDATE public.purchase_requests
       SET status = 'approved', approved_by = r.approver_id, approved_at = now()
     WHERE approval_request_id = r.id AND status <> 'approved';
    IF FOUND THEN _did := true; END IF;

    IF r.source_module = 'pos' AND r.source_record_id IS NOT NULL AND r.approval_type = 'void' THEN
      UPDATE public.pos_orders SET status = 'voided' WHERE id = r.source_record_id AND status <> 'voided';
      IF FOUND THEN _did := true; END IF;
    END IF;

    FOR _refund IN
      SELECT id FROM public.refunds
       WHERE approval_request_id = r.id AND status NOT IN ('processed','rejected')
    LOOP
      UPDATE public.refunds
         SET status = 'processed', approved_by = r.approver_id, processed_at = now(), updated_at = now()
       WHERE id = _refund;
      PERFORM public.neo_finance_post_refund('folio_refund', _refund, true);
      _did := true;
    END LOOP;

    IF r.source_module = 'pos' AND r.approval_type = 'refund' AND r.source_record_id IS NOT NULL THEN
      IF EXISTS (SELECT 1 FROM public.pos_refund_requests WHERE id = r.source_record_id AND status = 'pending') THEN
        PERFORM public.neo_pos_refund_decide(r.source_record_id, true, 'Approved via approval request');
        _did := true;
      END IF;
    END IF;

    UPDATE public.approval_requests
       SET status = 'completed',
           execution_status = CASE WHEN _did THEN 'succeeded' ELSE 'not_required' END,
           execution_error = '', executed_at = now(), completed_at = now()
     WHERE id = r.id;
    RETURN jsonb_build_object('ok', true, 'executed', _did);
  EXCEPTION WHEN OTHERS THEN
    _err := SQLERRM;
    UPDATE public.approval_requests
       SET status = 'execution_failed', execution_status = 'failed', execution_error = _err
     WHERE id = r.id;
    INSERT INTO public.approval_execution_failures (organization_id, request_id, source_module,
      source_record_id, error_message)
    VALUES (r.organization_id, r.id, r.source_module, r.source_record_id, _err);
    RETURN jsonb_build_object('ok', false, 'error', _err);
  END;
END $$;

GRANT EXECUTE ON FUNCTION public.neo_requisition_supervisor_authority() TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_finance_post_refund(text, uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_pos_refund_decide(uuid, boolean, text) TO authenticated;