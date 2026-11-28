CREATE OR REPLACE FUNCTION public.neo_transport_set_status(
  _request uuid, _status text, _rider uuid DEFAULT NULL,
  _amount numeric DEFAULT NULL, _note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _current public.transport_requests;
  _saved public.transport_requests;
  _note_value text := nullif(btrim(coalesce(_note, '')), '');
BEGIN
  IF auth.uid() IS NULL OR _org IS NULL OR NOT COALESCE((public.is_org_admin()
    OR public.has_permission('front-office', 'requests.manage')
    OR public.has_permission('front-office', 'requests', 'edit')), false) THEN
    RAISE EXCEPTION 'Not permitted to manage transport requests' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _current FROM public.transport_requests WHERE id = _request AND organization_id = _org FOR UPDATE;
  IF NOT FOUND OR public.in_my_branch_scope(_current.organization_id, _current.branch_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'Transport request is outside your property scope' USING ERRCODE = '42501';
  END IF;
  IF _status IS NULL OR _status NOT IN ('requested','quoted','confirmed','driver-assigned','arriving','picked-up','completed','cancelled','declined') THEN
    RAISE EXCEPTION 'Unsupported status';
  END IF;

  IF _current.status = _status
    AND (_rider IS NULL OR _rider IS NOT DISTINCT FROM _current.assigned_rider_id)
    AND (_amount IS NULL OR _amount IS NOT DISTINCT FROM _current.quoted_amount)
    AND (_note_value IS NULL OR _note_value IS NOT DISTINCT FROM _current.assignment_note) THEN
    RETURN jsonb_build_object('ok', true, 'id', _current.id, 'status', _current.status,
      'assigned_rider_id', _current.assigned_rider_id, 'quoted_amount', _current.quoted_amount, 'already_saved', true);
  END IF;

  IF _current.status IN ('completed','cancelled','declined') THEN
    RAISE EXCEPTION 'This transfer is already closed';
  END IF;
  IF NOT COALESCE(_status = _current.status OR _status IN ('cancelled','declined') OR CASE _current.status
    WHEN 'requested' THEN _status = 'quoted'
    WHEN 'quoted' THEN _status = 'confirmed'
    WHEN 'confirmed' THEN _status IN ('driver-assigned','completed')
    WHEN 'driver-assigned' THEN _status IN ('arriving','picked-up','completed')
    WHEN 'arriving' THEN _status IN ('driver-assigned','picked-up','completed')
    WHEN 'picked-up' THEN _status IN ('driver-assigned','completed')
    ELSE false
  END, false) THEN
    RAISE EXCEPTION 'The transfer has moved on. Refresh it before updating';
  END IF;
  IF _amount IS NOT NULL AND (_amount < 0 OR _amount::text IN ('NaN','Infinity','-Infinity')) THEN
    RAISE EXCEPTION 'Enter a valid transfer quote';
  END IF;
  IF _status = 'quoted' AND coalesce(_amount, _current.quoted_amount) IS NULL THEN
    RAISE EXCEPTION 'Enter a transfer quote amount';
  END IF;
  IF (_status = 'driver-assigned' AND _rider IS NULL) OR (_rider IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.rider_profiles rp WHERE rp.id = _rider AND rp.organization_id = _org AND rp.active
      AND (_current.branch_id IS NULL OR rp.branch_id IS NULL OR rp.branch_id = _current.branch_id)
      AND rp.availability_status IN ('available','on-shift','busy')
  )) THEN
    RAISE EXCEPTION 'Choose an eligible driver for this property';
  END IF;

  UPDATE public.transport_requests SET status = _status,
    assigned_rider_id = coalesce(_rider, assigned_rider_id), quoted_amount = coalesce(_amount, quoted_amount),
    assignment_note = coalesce(_note_value, assignment_note), handled_by = auth.uid(), updated_at = now()
  WHERE id = _current.id RETURNING * INTO _saved;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value)
  VALUES (_org, auth.uid(), '', 'transport.request.status', 'front-office', _saved.id::text,
    jsonb_build_object('status', _current.status, 'rider', _current.assigned_rider_id, 'amount', _current.quoted_amount),
    jsonb_build_object('status', _saved.status, 'rider', _saved.assigned_rider_id, 'amount', _saved.quoted_amount));

  RETURN jsonb_build_object('ok', true, 'id', _saved.id, 'status', _saved.status,
    'assigned_rider_id', _saved.assigned_rider_id, 'quoted_amount', _saved.quoted_amount);
END $function$;

REVOKE ALL ON FUNCTION public.neo_transport_set_status(uuid,text,uuid,numeric,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_transport_set_status(uuid,text,uuid,numeric,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_transport_rider_candidates(_request uuid)
RETURNS TABLE(rider_id uuid, rider_code text, display_name text, vehicle_type text,
  availability_status text, active_load bigint, eligible boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _transfer public.transport_requests;
BEGIN
  IF auth.uid() IS NULL OR _org IS NULL OR NOT COALESCE((public.is_org_admin()
    OR public.has_permission('front-office', 'requests.manage')
    OR public.has_permission('front-office', 'requests', 'edit')
    OR public.has_permission('delivery', 'dispatch.manage')), false) THEN
    RAISE EXCEPTION 'Not permitted to assign drivers' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO _transfer FROM public.transport_requests WHERE id = _request AND organization_id = _org;
  IF NOT FOUND OR public.in_my_branch_scope(_transfer.organization_id, _transfer.branch_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'Transport request is outside your property scope' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT rp.id, rp.rider_code, rp.display_name, rp.vehicle_type, rp.availability_status,
    (SELECT count(*) FROM public.delivery_orders d WHERE d.organization_id = _org AND d.rider_id = rp.id
      AND d.dispatch_status NOT IN ('delivered','delivery-failed','returned')),
    (rp.availability_status IN ('available','on-shift','busy'))
  FROM public.rider_profiles rp
  WHERE rp.organization_id = _org AND rp.active
    AND (_transfer.branch_id IS NULL OR rp.branch_id IS NULL OR rp.branch_id = _transfer.branch_id)
  ORDER BY rp.display_name;
END $function$;

REVOKE ALL ON FUNCTION public.neo_transport_rider_candidates(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_transport_rider_candidates(uuid) TO authenticated;
