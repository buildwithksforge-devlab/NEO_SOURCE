CREATE OR REPLACE FUNCTION public.neo_delivery_rider_notify(_org uuid, _rider uuid, _event text, _title text, _body text, _idem text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _r public.rider_profiles;
BEGIN
  SELECT * INTO _r FROM public.rider_profiles WHERE id = _rider AND organization_id = _org;
  IF _r.profile_id IS NULL THEN RETURN; END IF;
  INSERT INTO public.notifications
    (organization_id, branch_id, user_id, category, title, body, link,
     source_module, source_record_id, event_type, idempotency_key)
  VALUES (_org, _r.branch_id, _r.profile_id, 'operations', _title, _body, '/rider',
          'delivery', _rider, _event, _idem)
  ON CONFLICT DO NOTHING;
END $$;
REVOKE EXECUTE ON FUNCTION public.neo_delivery_rider_notify(uuid, uuid, text, text, text, text) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.neo_delivery_rider_retire(_rider uuid, _reason text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _open integer; _r public.rider_profiles;
  _clean text := nullif(btrim(coalesce(_reason,'')),'');
BEGIN
  IF NOT public.has_permission('delivery','riders.manage') THEN
    RAISE EXCEPTION 'Not permitted to manage the delivery rider roster' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _r FROM public.rider_profiles WHERE id = _rider AND organization_id = _org FOR UPDATE;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Rider not found in this workspace'; END IF;
  IF NOT public.neo_branch_in_scope(_r.branch_id) THEN
    RAISE EXCEPTION 'That rider is outside your access scope.' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) INTO _open
    FROM public.delivery_orders d
   WHERE d.rider_id = _rider
     AND coalesce(d.order_status,'') NOT IN ('delivered','cancelled','failed','rejected');
  IF _open > 0 THEN
    RAISE EXCEPTION 'Rider still has % open delivery order(s) — reassign them first', _open;
  END IF;

  UPDATE public.rider_profiles
     SET active = false, availability_status = 'offline', updated_at = now()
   WHERE id = _rider AND organization_id = _org;

  PERFORM public.neo_delivery_rider_notify(_org, _rider, 'delivery.rider.retired',
    'You have been removed from the delivery roster',
    coalesce(_clean, 'Your rider account is no longer on the active roster.'),
    'delivery.rider.retire:' || _rider::text);

  INSERT INTO public.audit_logs
    (organization_id, user_id, user_name, action, module, record_id, previous_value, new_value, reason)
  VALUES (_org, auth.uid(), '', 'delivery.rider.retire', 'delivery', _rider::text,
    jsonb_build_object('active', true, 'rider_id', _rider, 'rider_code', _r.rider_code),
    jsonb_build_object('active', false, 'rider_id', _rider), _clean);

  RETURN jsonb_build_object('rider_id', _rider, 'operation', 'retired', 'reason', _clean);
END;
$function$;

-- Enrolment notification + audit, appended to the existing routine --------
DO $do$
DECLARE _src text; _new text;
BEGIN
  SELECT prosrc INTO _src FROM pg_proc
   WHERE proname = 'neo_delivery_rider_enrol' AND pronamespace = 'public'::regnamespace;
  IF _src IS NULL OR position('neo_delivery_rider_notify' in _src) > 0 THEN RETURN; END IF;

  _new := replace(_src,
    'RETURN jsonb_build_object(''rider_id'', _rider, ''rider_code'', _code, ''operation'', ''reinstated'');',
    'PERFORM public.neo_delivery_rider_notify(_org, _rider, ''delivery.rider.enrolled'',
       ''You are back on the delivery roster'', ''Rider code '' || _code,
       ''delivery.rider.enrol:'' || _rider::text || '':'' || _code);
     INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
     VALUES (_org, auth.uid(), '''', ''delivery.rider.reinstate'', ''delivery'', _rider::text,
       jsonb_build_object(''rider_id'', _rider, ''rider_code'', _code));
     RETURN jsonb_build_object(''rider_id'', _rider, ''rider_code'', _code, ''operation'', ''reinstated'');');

  _new := replace(_new,
    'RETURN jsonb_build_object(''rider_id'', _rider, ''rider_code'', _code, ''operation'', ''enrolled'');',
    'PERFORM public.neo_delivery_rider_notify(_org, _rider, ''delivery.rider.enrolled'',
       ''You have been added to the delivery roster'', ''Rider code '' || _code,
       ''delivery.rider.enrol:'' || _rider::text || '':'' || _code);
     INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
     VALUES (_org, auth.uid(), '''', ''delivery.rider.enrol'', ''delivery'', _rider::text,
       jsonb_build_object(''rider_id'', _rider, ''rider_code'', _code));
     RETURN jsonb_build_object(''rider_id'', _rider, ''rider_code'', _code, ''operation'', ''enrolled'');');

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.neo_delivery_rider_enrol(_profile uuid, _branch uuid DEFAULT NULL::uuid, _vehicle_type text DEFAULT ''motorcycle''::text, _vehicle_registration text DEFAULT NULL::text, _work_phone text DEFAULT NULL::text, _max_active integer DEFAULT 3, _cash_handling boolean DEFAULT true) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'' AS %L', _new);
END $do$;

-- Shift notification gains a stable key -----------------------------------
CREATE OR REPLACE FUNCTION public.neo_delivery_shift_schedule(_rider uuid, _starts_at timestamp with time zone, _ends_at timestamp with time zone, _branch uuid DEFAULT NULL::uuid, _notes text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE _org uuid := public.current_org_id(); _r public.rider_profiles; _branch_use uuid; _id uuid;
BEGIN
  IF _org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT public.has_permission('delivery','riders.manage') THEN
    RAISE EXCEPTION 'The delivery.riders.manage permission is required.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _r FROM public.rider_profiles WHERE id = _rider AND organization_id = _org;
  IF _r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'rider_not_found'); END IF;
  IF _r.active IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'rider_retired',
      'detail', 'This rider is not active on the roster.');
  END IF;

  _branch_use := coalesce(_branch, _r.branch_id);
  IF NOT public.neo_branch_in_scope(_branch_use) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;

  IF _ends_at <= _starts_at THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_window',
      'detail', 'The shift must end after it starts.');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.rider_shifts s
     WHERE s.rider_id = _rider AND s.status IN ('scheduled','active')
       AND s.starts_at < _ends_at AND s.ends_at > _starts_at
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'overlapping_shift',
      'detail', 'This rider already has a shift covering part of that window.');
  END IF;

  INSERT INTO public.rider_shifts (organization_id, branch_id, rider_id, starts_at, ends_at, notes, created_by)
  VALUES (_org, _branch_use, _rider, _starts_at, _ends_at, nullif(btrim(coalesce(_notes,'')),''), auth.uid())
  RETURNING id INTO _id;

  INSERT INTO public.notifications
    (organization_id, branch_id, category, title, body, link, user_id,
     source_module, source_record_id, event_type, idempotency_key)
  VALUES (_org, _branch_use, 'operations', 'Delivery shift scheduled',
    coalesce(_r.display_name,'Rider') || ' — ' || to_char(_starts_at, 'DD Mon HH24:MI') || ' to ' ||
    to_char(_ends_at, 'DD Mon HH24:MI'), '/delivery', _r.profile_id,
    'delivery', _rider, 'delivery.rider.shift',
    'delivery.rider.shift:' || _rider::text || ':' || to_char(_starts_at,'YYYYMMDDHH24MI') || ':' || to_char(_ends_at,'YYYYMMDDHH24MI'))
  ON CONFLICT DO NOTHING;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'delivery.rider.shift-schedule', 'delivery', _id::text,
    jsonb_build_object('rider_id', _rider, 'starts_at', _starts_at, 'ends_at', _ends_at));

  RETURN jsonb_build_object('ok', true, 'shift_id', _id);
END $function$;
