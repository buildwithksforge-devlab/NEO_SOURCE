CREATE OR REPLACE FUNCTION public.neo_delivery_rider_availability(_rider uuid, _status text, _reason text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _r public.rider_profiles; _self boolean; _prev text;
  _clean text := lower(btrim(coalesce(_status,'')));
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF _clean NOT IN ('available','busy','on-break','offline') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_status');
  END IF;

  SELECT * INTO _r FROM public.rider_profiles WHERE id = _rider AND organization_id = _org FOR UPDATE;
  IF _r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'rider_not_found'); END IF;

  -- Ownership of the rider record is itself the authority for one's own
  -- availability: the signed-in account must be the profile the rider row
  -- points at. Riders are not granted delivery.rider.availability by role, and
  -- requiring it locked every rider out of their own toggle.
  _self := _r.profile_id IS NOT NULL AND _r.profile_id = auth.uid();
  IF NOT _self
     AND NOT public.has_permission('delivery','riders.manage')
     AND NOT public.has_permission('delivery','dispatch.assign')
     AND NOT public.is_org_admin() THEN
    RAISE EXCEPTION 'Not permitted to change that rider''s availability.' USING ERRCODE = '42501';
  END IF;
  -- Branch scope constrains acting on OTHER riders only; a rider's own record
  -- is always in scope for them.
  IF NOT _self AND NOT public.neo_branch_in_scope(_r.branch_id) THEN
    RAISE EXCEPTION 'That rider is outside your access scope.' USING ERRCODE = '42501';
  END IF;

  _prev := _r.availability_status;
  IF coalesce(_prev,'') = _clean THEN
    RETURN jsonb_build_object('ok', true, 'status', _clean, 'unchanged', true, 'self', _self);
  END IF;

  UPDATE public.rider_profiles SET availability_status = _clean, updated_at = now() WHERE id = _rider;

  INSERT INTO public.rider_availability_history (organization_id, rider_id, previous_status, new_status, reason, changed_by)
  VALUES (_org, _rider, _prev, _clean, nullif(btrim(coalesce(_reason,'')),''), auth.uid());

  IF _r.profile_id IS NOT NULL AND NOT _self THEN
    INSERT INTO public.notifications
      (organization_id, branch_id, user_id, category, title, body, link,
       source_module, source_record_id, event_type, idempotency_key)
    VALUES (_org, _r.branch_id, _r.profile_id, 'operations', 'Your rider availability was changed',
      'Now ' || _clean || coalesce(' — ' || nullif(btrim(coalesce(_reason,'')),''), ''),
      '/rider', 'delivery', _rider, 'delivery.rider.availability',
      'delivery.rider.availability:' || _rider::text || ':' || _clean || ':' ||
        to_char(date_trunc('minute', now()), 'YYYYMMDDHH24MI'))
    ON CONFLICT DO NOTHING;
  END IF;

  INSERT INTO public.audit_logs
    (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value, reason)
  VALUES (_org, auth.uid(), '', 'delivery.rider.availability', 'delivery', _rider::text,
    jsonb_build_object('availability_status', _prev), jsonb_build_object('availability_status', _clean),
    nullif(btrim(coalesce(_reason,'')),''));

  RETURN jsonb_build_object('ok', true, 'status', _clean, 'previous', _prev, 'self', _self);
END $function$;

REVOKE EXECUTE ON FUNCTION public.neo_delivery_rider_availability(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_delivery_rider_availability(uuid, text, text) TO authenticated;