CREATE OR REPLACE FUNCTION public.neo_procurement_request_submit(_request uuid, _attempt uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _r record; _prior jsonb;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE='42501'; END IF;
  IF _attempt IS NULL THEN RAISE EXCEPTION 'attempt_key_required' USING ERRCODE='22023'; END IF;

  SELECT result INTO _prior FROM public.procurement_attempts
   WHERE organization_id=_org AND action='request.submit' AND attempt_key=_attempt;
  IF _prior IS NOT NULL THEN RETURN _prior || jsonb_build_object('replayed', true); END IF;

  SELECT * INTO _r FROM public.purchase_requests WHERE id=_request AND organization_id=_org;
  IF _r IS NULL THEN RAISE EXCEPTION 'request_not_found' USING ERRCODE='22023'; END IF;
  IF NOT public.neo_branch_in_scope(_r.branch_id) THEN RAISE EXCEPTION 'branch_out_of_scope' USING ERRCODE='42501'; END IF;
  IF NOT (public.has_permission('procurement','requests.create')
          OR public.has_permission('stores','requisition.create')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501';
  END IF;
  -- 'submitted' is what a Stores shortage handover produces: it has reached
  -- Procurement but has not yet been put in front of an approver.
  IF _r.status NOT IN ('draft','rejected','submitted') THEN
    RAISE EXCEPTION 'request_not_submittable' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.purchase_request_lines WHERE request_id=_request) THEN
    RAISE EXCEPTION 'request_has_no_lines' USING ERRCODE='22023';
  END IF;

  UPDATE public.purchase_requests
     SET status='pending_approval', updated_at=now(),
         request_number = COALESCE(request_number, public.next_document_number('purchase_request','PR', branch_id))
   WHERE id=_request;

  SELECT jsonb_build_object('ok',true,'request_id',_request,'status','pending_approval',
                            'request_number', request_number)
    INTO _prior FROM public.purchase_requests WHERE id=_request;

  INSERT INTO public.procurement_attempts (organization_id, action, attempt_key, record_id, result)
  VALUES (_org,'request.submit',_attempt,_request,_prior);
  RETURN _prior;
END $function$;

CREATE OR REPLACE FUNCTION public.neo_procurement_request_price_line(_line uuid, _price numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _l record; _r record; _total numeric := 0;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organisation' USING ERRCODE='42501'; END IF;
  IF _price IS NULL OR _price < 0 THEN RAISE EXCEPTION 'invalid_price' USING ERRCODE='22023'; END IF;

  SELECT * INTO _l FROM public.purchase_request_lines WHERE id=_line AND organization_id=_org;
  IF _l IS NULL THEN RAISE EXCEPTION 'line_not_found' USING ERRCODE='22023'; END IF;
  SELECT * INTO _r FROM public.purchase_requests WHERE id=_l.request_id AND organization_id=_org FOR UPDATE;
  IF _r IS NULL THEN RAISE EXCEPTION 'request_not_found' USING ERRCODE='22023'; END IF;
  IF NOT public.neo_branch_in_scope(_r.branch_id) THEN RAISE EXCEPTION 'branch_out_of_scope' USING ERRCODE='42501'; END IF;
  IF NOT (public.has_permission('procurement','requests.create')
          OR public.has_permission('procurement','requests.approve')
          OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501';
  END IF;
  IF _r.status NOT IN ('draft','rejected','submitted','pending_approval') THEN
    RAISE EXCEPTION 'request_not_editable' USING ERRCODE='22023';
  END IF;

  UPDATE public.purchase_request_lines SET estimated_unit_price=_price WHERE id=_line;

  SELECT COALESCE(sum(quantity * COALESCE(estimated_unit_price,0)),0) INTO _total
    FROM public.purchase_request_lines WHERE request_id=_r.id;
  UPDATE public.purchase_requests SET estimated_total=_total, updated_at=now() WHERE id=_r.id;

  INSERT INTO public.audit_logs (organization_id, branch_id, module, action, record_id, user_id, new_value)
  VALUES (_org, _r.branch_id, 'procurement', 'request.line.priced', _r.id::text, auth.uid(),
          jsonb_build_object('line', _line, 'unit_price', _price, 'estimated_total', _total));

  RETURN jsonb_build_object('ok',true,'line_id',_line,'unit_price',_price,'estimated_total',_total);
END $function$;

REVOKE ALL ON FUNCTION public.neo_procurement_request_price_line(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_procurement_request_price_line(uuid, numeric) TO authenticated;