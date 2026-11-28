-- The RFQ and all supplier invitations must be saved together.
CREATE OR REPLACE FUNCTION public.neo_procurement_create_rfq(
  _request uuid, _suppliers uuid[], _closes_at date, _attempt uuid,
  _title text DEFAULT NULL, _notes text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid := public.current_org_id(); _r public.purchase_requests%ROWTYPE;
  _rfq uuid; _number text; _prior jsonb; _supplier_count integer;
BEGIN
  IF _org IS NULL OR NOT (public.has_permission('procurement','quotations.manage')
    OR public.has_permission('procurement','orders.create') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501'; END IF;
  IF _attempt IS NULL THEN RAISE EXCEPTION 'attempt_key_required' USING ERRCODE='22023'; END IF;
  SELECT result INTO _prior FROM public.procurement_attempts WHERE organization_id = _org
    AND action = 'rfq.create' AND attempt_key = _attempt;
  IF _prior IS NOT NULL THEN RETURN _prior || jsonb_build_object('replayed', true); END IF;
  SELECT * INTO _r FROM public.purchase_requests WHERE id = _request
    AND organization_id = _org FOR UPDATE;
  IF _r.id IS NULL OR _r.status <> 'approved' OR _r.branch_id IS NULL
    OR NOT public.neo_branch_in_scope(_r.branch_id) THEN
    RAISE EXCEPTION 'approved_property_request_required' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM public.purchase_orders WHERE request_id = _request
    AND organization_id = _org AND status NOT IN ('cancelled','voided')) THEN
    RAISE EXCEPTION 'request_already_ordered' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.purchase_request_lines WHERE request_id = _request
    AND organization_id = _org) THEN
    RAISE EXCEPTION 'request_has_no_lines' USING ERRCODE='22023'; END IF;
  _supplier_count := (SELECT count(DISTINCT x) FROM unnest(_suppliers) x);
  IF COALESCE(_supplier_count, 0) = 0 OR
    _supplier_count <> (SELECT count(*) FROM public.suppliers
      WHERE organization_id = _org AND id = ANY(_suppliers)) THEN
    RAISE EXCEPTION 'invalid_supplier_invitation' USING ERRCODE='22023'; END IF;
  IF _closes_at IS NOT NULL AND _closes_at < public.neo_local_today(_r.branch_id) THEN
    RAISE EXCEPTION 'closing_date_in_past' USING ERRCODE='22023'; END IF;
  _number := public.next_document_number('rfq');
  INSERT INTO public.rfqs (organization_id, branch_id, request_id, rfq_number,
    title, status, issued_at, closes_at, notes, created_by)
  VALUES (_org, _r.branch_id, _request, _number, NULLIF(trim(_title),''),
    'issued', now(), ((_closes_at + 1)::timestamp AT TIME ZONE public.neo_fact_timezone(_org, _r.branch_id)), NULLIF(trim(_notes),''), auth.uid())
  RETURNING id INTO _rfq;
  INSERT INTO public.rfq_suppliers (organization_id, rfq_id, supplier_id, dispatch_state)
    SELECT _org, _rfq, id, 'prepared' FROM public.suppliers
      WHERE organization_id = _org AND id = ANY(_suppliers);
  _prior := jsonb_build_object('id', _rfq, 'rfq_number', _number,
    'invited', _supplier_count, 'dispatch_state', 'prepared');
  INSERT INTO public.procurement_attempts
    (organization_id, action, attempt_key, record_id, result)
  VALUES (_org, 'rfq.create', _attempt, _rfq, _prior);
  RETURN _prior;
END $$;
REVOKE ALL ON FUNCTION public.neo_procurement_create_rfq(uuid, uuid[], date, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_procurement_create_rfq(uuid, uuid[], date, uuid, text, text) TO authenticated;

-- Mark a real manual dispatch only after the buyer confirms sending it.
CREATE OR REPLACE FUNCTION public.neo_procurement_record_rfq_dispatch(
  _invite uuid, _channel text, _note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid := public.current_org_id(); _branch uuid; _state text;
BEGIN
  IF _org IS NULL OR NOT (public.has_permission('procurement','quotations.manage')
    OR public.has_permission('procurement','orders.create') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501'; END IF;
  IF _channel NOT IN ('email','whatsapp','hand-delivered') THEN
    RAISE EXCEPTION 'dispatch_channel_required' USING ERRCODE='22023'; END IF;
  SELECT f.branch_id, i.dispatch_state INTO _branch, _state
    FROM public.rfq_suppliers i JOIN public.rfqs f ON f.id = i.rfq_id
    WHERE i.id = _invite AND i.organization_id = _org AND f.organization_id = _org
      AND f.status = 'issued' FOR UPDATE OF i;
  IF _branch IS NULL OR NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION 'invitation_not_available' USING ERRCODE='42501'; END IF;
  IF _state IN ('marked-sent','sent') THEN
    RETURN jsonb_build_object('dispatch_state', _state, 'replayed', true); END IF;
  UPDATE public.rfq_suppliers SET dispatch_state = 'marked-sent',
    dispatch_channel = _channel, dispatch_note = NULLIF(trim(_note),''),
    dispatched_at = now(), dispatched_by = auth.uid() WHERE id = _invite;
  RETURN jsonb_build_object('dispatch_state', 'marked-sent');
END $$;
REVOKE ALL ON FUNCTION public.neo_procurement_record_rfq_dispatch(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_procurement_record_rfq_dispatch(uuid, text, text) TO authenticated;
