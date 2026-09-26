-- P0: database-side authority checks on till + guest-request write routines

CREATE OR REPLACE FUNCTION public.cash_close_shift(_shift uuid, _counted numeric, _reason text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _s public.pos_shifts; _expected numeric; _variance numeric; _appr uuid;
BEGIN
  IF NOT (public.has_permission('restaurant','shifts','close')
          OR public.has_permission('restaurant','shifts','edit')) THEN
    RAISE EXCEPTION 'Not permitted to close a cashier shift';
  END IF;
  SELECT * INTO _s FROM public.pos_shifts WHERE id=_shift AND organization_id=_org FOR UPDATE;
  IF _s.id IS NULL THEN RAISE EXCEPTION 'Shift not found'; END IF;
  IF _s.status <> 'open' THEN RAISE EXCEPTION 'Shift is already %', _s.status; END IF;
  _expected := public.cash_shift_expected(_shift);
  _variance := round(COALESCE(_counted,0) - COALESCE(_expected,0), 2);
  IF _variance <> 0 AND COALESCE(trim(_reason),'') = '' THEN
    RAISE EXCEPTION 'A variance reason is required when the count does not match the expected cash';
  END IF;

  IF _variance <> 0 THEN
    INSERT INTO public.approval_requests (organization_id, branch_id, reference, approval_type, requester_id,
      reason, amount, status)
    VALUES (_org, _s.branch_id, 'SHIFT-' || COALESCE(_s.shift_number, substr(_shift::text,1,8)),
      'cash-variance', auth.uid(), _reason, abs(_variance), 'pending')
    RETURNING id INTO _appr;
  END IF;

  UPDATE public.pos_shifts SET status = CASE WHEN _variance = 0 THEN 'closed' ELSE 'pending-review' END,
    expected_cash = _expected, counted_cash = _counted, variance = _variance, variance_reason = _reason,
    closed_at = now(), closed_by = auth.uid(), review_approval_request_id = _appr, updated_at = now()
  WHERE id = _shift;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'pos.shift.close', 'pos', _shift::text,
    jsonb_build_object('expected',_expected,'counted',_counted,'variance',_variance), _reason);

  RETURN jsonb_build_object('expected',_expected,'counted',_counted,'variance',_variance,
    'status', CASE WHEN _variance = 0 THEN 'closed' ELSE 'pending-review' END, 'approval_request_id', _appr);
END; $function$;

CREATE OR REPLACE FUNCTION public.cash_record_movement(_shift uuid, _type text, _amount numeric, _reason text, _reference text DEFAULT ''::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _s public.pos_shifts; _id uuid;
BEGIN
  SELECT * INTO _s FROM public.pos_shifts WHERE id=_shift AND organization_id=_org FOR UPDATE;
  IF _s.id IS NULL THEN RAISE EXCEPTION 'Shift not found'; END IF;
  IF NOT (public.has_permission('restaurant','shifts','edit')
          OR (_s.cashier_id = auth.uid() AND public.has_permission('restaurant','shifts','create'))) THEN
    RAISE EXCEPTION 'Not permitted to record a till movement';
  END IF;
  IF _s.status <> 'open' THEN RAISE EXCEPTION 'Shift is % and cannot accept movements', _s.status; END IF;
  IF _type NOT IN ('drop','paid-out','pickup','float-top-up') THEN RAISE EXCEPTION 'Unsupported movement type %', _type; END IF;
  IF COALESCE(trim(_reason),'') = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;
  INSERT INTO public.cash_movements (organization_id, shift_id, movement_type, amount, reason, reference, created_by)
  VALUES (_org, _shift, _type, _amount, _reason, _reference, auth.uid()) RETURNING id INTO _id;
  UPDATE public.pos_shifts SET
    total_drops = total_drops + CASE WHEN _type IN ('drop','pickup') THEN _amount ELSE 0 END,
    total_paid_outs = total_paid_outs + CASE WHEN _type = 'paid-out' THEN _amount ELSE 0 END,
    opening_float = opening_float + CASE WHEN _type = 'float-top-up' THEN _amount ELSE 0 END,
    updated_at = now()
  WHERE id = _shift;
  RETURN _id;
END; $function$;

CREATE OR REPLACE FUNCTION public.pms_request_assign(_request uuid, _assignee uuid, _department uuid, _reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _r public.guest_requests;
BEGIN
  SELECT * INTO _r FROM public.guest_requests
   WHERE id=_request AND organization_id=public.current_org_id();
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Request not found or already closed'; END IF;
  IF NOT (public.has_permission('front-office','requests','edit')
          OR (_assignee = auth.uid() AND _r.assignee_id IS NULL)) THEN
    RAISE EXCEPTION 'Not permitted to reassign this request';
  END IF;
  UPDATE public.guest_requests
     SET assignee_id = COALESCE(_assignee, assignee_id),
         department_id = COALESCE(_department, department_id),
         status = CASE WHEN status = 'open' THEN 'assigned' ELSE status END,
         notes = COALESCE(notes,'') || CASE WHEN COALESCE(btrim(_reason),'')='' THEN ''
                 ELSE E'\n['||to_char(now(),'YYYY-MM-DD HH24:MI')||'] reassigned: '||_reason END,
         updated_at = now()
   WHERE id=_request AND organization_id=public.current_org_id()
     AND status NOT IN ('completed','cancelled');
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found or already closed'; END IF;
  RETURN jsonb_build_object('ok', true);
END; $function$;

CREATE OR REPLACE FUNCTION public.pms_request_complete(_request uuid, _resolution text, _evidence text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _r public.guest_requests;
BEGIN
  IF COALESCE(btrim(_resolution),'') = '' THEN RAISE EXCEPTION 'Describe how the request was resolved'; END IF;
  SELECT * INTO _r FROM public.guest_requests
   WHERE id=_request AND organization_id=public.current_org_id();
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Request not found or already completed'; END IF;
  IF NOT (public.has_permission('front-office','requests','edit') OR _r.assignee_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not permitted to complete this request';
  END IF;
  UPDATE public.guest_requests
     SET status='completed', completed_at=now(), resolution_notes=_resolution,
         evidence_url=NULLIF(_evidence,''), updated_at=now()
   WHERE id=_request AND organization_id=public.current_org_id() AND status <> 'completed';
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found or already completed'; END IF;
  RETURN jsonb_build_object('ok', true);
END; $function$;

CREATE OR REPLACE FUNCTION public.pms_request_feedback(_request uuid, _rating integer, _comment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _r public.guest_requests; _is_guest boolean := false;
BEGIN
  IF _rating IS NOT NULL AND (_rating < 1 OR _rating > 5) THEN RAISE EXCEPTION 'Rating must be 1-5'; END IF;
  SELECT * INTO _r FROM public.guest_requests WHERE id=_request;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.customers c
     WHERE c.id = _r.customer_id AND c.auth_user_id = auth.uid()
  ) INTO _is_guest;
  IF NOT (_is_guest
          OR (_r.organization_id = public.current_org_id()
              AND public.has_permission('front-office','requests','edit'))) THEN
    RAISE EXCEPTION 'Not permitted to record feedback on this request';
  END IF;
  UPDATE public.guest_requests
     SET feedback_rating=_rating, feedback_comment=NULLIF(_comment,''), guest_confirmed=true, updated_at=now()
   WHERE id=_request;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  RETURN jsonb_build_object('ok', true);
END; $function$;

-- P0: feature flag overrides must not be readable across workspaces
DROP POLICY IF EXISTS feature_flag_overrides_read ON public.feature_flag_overrides;
CREATE POLICY feature_flag_overrides_read ON public.feature_flag_overrides
  FOR SELECT TO authenticated
  USING (public.is_platform_admin() OR organization_id = public.current_org_id());