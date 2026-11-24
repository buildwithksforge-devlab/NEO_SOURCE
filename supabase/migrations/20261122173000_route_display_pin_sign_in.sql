-- Restrict display sessions opened from PIN sign-in to their authorised device.
ALTER TABLE public.neo_production_display_sessions
  ADD COLUMN IF NOT EXISTS staff_login_device_id uuid REFERENCES public.neo_staff_login_devices(id);

CREATE OR REPLACE FUNCTION public.neo_station_display_pin_admin(_branch uuid, _station uuid, _user uuid DEFAULT NULL, _pin text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  accounts jsonb := public.neo_station_login_admin(_branch,_station);
BEGIN
  IF _user IS NULL THEN
    RETURN coalesce((SELECT jsonb_agg(a || jsonb_build_object('display_pin_set', EXISTS (
      SELECT 1 FROM public.neo_station_entry_pins p WHERE p.organization_id=org AND p.branch_id=_branch
        AND p.station_id=_station AND p.user_id=(a->>'id')::uuid))) FROM jsonb_array_elements(accounts) a),'[]'::jsonb);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(accounts) a WHERE a->>'id'=_user::text) THEN
    RAISE EXCEPTION 'Choose active staff assigned to this station' USING ERRCODE='42501';
  END IF;
  IF _pin IS NOT NULL AND _pin !~ '^[0-9]{6}$' THEN RAISE EXCEPTION 'Enter a six-digit display PIN'; END IF;
  -- Serialize configuration so duplicate PINs cannot be saved concurrently.
  PERFORM pg_advisory_xact_lock(20261030, hashtext(org::text));
  IF _pin IS NOT NULL AND (EXISTS(SELECT 1 FROM public.neo_production_staff_codes c
      WHERE c.organization_id=org AND c.enabled AND extensions.crypt(_pin,c.pin_hash)=c.pin_hash)
    OR EXISTS(SELECT 1 FROM public.neo_station_entry_pins c WHERE c.organization_id=org
      AND (c.station_id<>_station OR c.user_id<>_user) AND extensions.crypt(_pin,c.pin_hash)=c.pin_hash)) THEN
    RAISE EXCEPTION 'Choose a different display PIN';
  END IF;
  IF _pin IS NULL THEN
    DELETE FROM public.neo_station_entry_pins WHERE organization_id=org AND branch_id=_branch AND station_id=_station AND user_id=_user;
  ELSE
    INSERT INTO public.neo_station_entry_pins VALUES(org,_branch,_station,_user,extensions.crypt(_pin,extensions.gen_salt('bf',10)))
    ON CONFLICT (organization_id,station_id,user_id) DO UPDATE SET pin_hash=excluded.pin_hash;
  END IF;
  UPDATE public.neo_production_display_sessions SET entry_actor=NULL,
    closed_at=CASE WHEN staff_login_device_id IS NOT NULL THEN coalesce(closed_at,now()) ELSE closed_at END
  WHERE organization_id=org AND branch_id=_branch AND _station=ANY(station_ids) AND entry_actor=_user;
  RETURN jsonb_build_object('ok',true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_production_paired_session(_token text)
RETURNS public.neo_production_display_sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE s public.neo_production_display_sessions;
BEGIN
  IF _token ~ '^[a-f0-9]{64}$' THEN
    SELECT * INTO s FROM public.neo_production_display_sessions
    WHERE token_hash=encode(extensions.digest(convert_to(_token,'UTF8'),'sha256'),'hex') AND closed_at IS NULL AND expires_at>now();
  END IF;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Display session is unavailable. Ask a supervisor to pair this screen again.' USING ERRCODE='42501'; END IF;
  IF s.staff_login_device_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.neo_staff_login_devices d
    JOIN public.operational_stations st ON st.id=s.station_ids[1]
      AND st.organization_id=d.organization_id AND st.branch_id=d.branch_id AND st.active
    WHERE d.id=s.staff_login_device_id AND d.organization_id=s.organization_id
      AND d.branch_id=s.branch_id AND d.revoked_at IS NULL AND d.expires_at>now()
  ) THEN
    RAISE EXCEPTION 'Display session is unavailable. Ask a supervisor to authorise this device again.' USING ERRCODE='42501';
  END IF;
  RETURN s;
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_production_display_entry_ready(s public.neo_production_display_sessions)
RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public','pg_temp'
AS $function$
  SELECT (s.staff_login_device_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.neo_station_entry_pins p
      WHERE p.organization_id=s.organization_id AND p.branch_id=s.branch_id AND p.station_id=ANY(s.station_ids)))
    OR (s.entry_actor IS NOT NULL AND EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=s.entry_actor
        AND p.organization_id=s.organization_id AND coalesce(p.account_status,'active')='active' AND coalesce(p.account_type,'staff')='staff')
      AND EXISTS(SELECT 1 FROM public.neo_station_entry_pins k WHERE k.organization_id=s.organization_id
        AND k.branch_id=s.branch_id AND k.station_id=ANY(s.station_ids) AND k.user_id=s.entry_actor)
      AND NOT EXISTS(SELECT 1 FROM unnest(s.station_ids) station(id) WHERE NOT EXISTS (
        SELECT 1 FROM public.user_stations a WHERE a.organization_id=s.organization_id AND a.station_id=station.id AND a.user_id=s.entry_actor)));
$function$;

CREATE OR REPLACE FUNCTION public.neo_staff_pin_sign_in(_token_hash text, _pin text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  device public.neo_staff_login_devices;
  entry_pin public.neo_station_entry_pins;
  display_token text;
  station_name text;
  display_expiry timestamptz;
BEGIN
  SELECT * INTO device FROM public.neo_staff_login_devices
  WHERE token_hash=_token_hash FOR UPDATE;

  IF device.id IS NULL OR device.revoked_at IS NOT NULL OR device.expires_at<=now()
      OR device.blocked_until>now() OR _pin IS NULL OR _pin !~ '^[0-9]{6}$' THEN
    RETURN public.neo_staff_login_device_resolve(_token_hash, _pin);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.neo_station_entry_pins p WHERE p.organization_id=device.organization_id
      AND extensions.crypt(_pin,p.pin_hash)=p.pin_hash
  ) THEN
    RETURN public.neo_staff_login_device_resolve(_token_hash, _pin);
  END IF;

  -- Resolve under the same lock as PIN enrollment so a concurrent PIN change
  -- can either invalidate the newly issued session or prevent issuance.
  PERFORM pg_advisory_xact_lock(20261030, hashtext(device.organization_id::text));
  BEGIN
    SELECT p.* INTO STRICT entry_pin
    FROM public.neo_station_entry_pins p WHERE p.organization_id=device.organization_id
      AND extensions.crypt(_pin,p.pin_hash)=p.pin_hash;
  EXCEPTION WHEN no_data_found OR too_many_rows THEN
    RETURN public.neo_staff_login_device_resolve(_token_hash, NULL);
  END;

  IF entry_pin.branch_id<>device.branch_id OR EXISTS (
    SELECT 1 FROM public.neo_production_staff_codes c WHERE c.organization_id=device.organization_id
      AND c.enabled AND extensions.crypt(_pin,c.pin_hash)=c.pin_hash
  ) THEN
    -- Count ambiguous and out-of-property credentials as ordinary PIN failures.
    RETURN public.neo_staff_login_device_resolve(_token_hash, NULL);
  END IF;

  SELECT s.name INTO station_name FROM public.operational_stations s
  JOIN public.user_stations a ON a.station_id=s.id AND a.organization_id=s.organization_id
  JOIN public.profiles p ON p.id=a.user_id AND p.organization_id=s.organization_id
  WHERE s.id=entry_pin.station_id AND s.organization_id=device.organization_id
    AND s.branch_id=device.branch_id AND s.active AND a.user_id=entry_pin.user_id
    AND coalesce(p.account_type,'staff')='staff' AND coalesce(p.account_status,'active')='active';
  IF NOT FOUND THEN
    RETURN public.neo_staff_login_device_resolve(_token_hash, NULL);
  END IF;

  display_token := encode(extensions.gen_random_bytes(32),'hex');
  display_expiry := least(device.expires_at, now()+interval '12 hours');
  UPDATE public.neo_production_display_sessions SET closed_at=now()
  WHERE staff_login_device_id=device.id AND closed_at IS NULL;

  INSERT INTO public.neo_production_display_sessions(
    organization_id, branch_id, station_ids, label, token_hash, opened_by,
    expires_at, entry_actor, staff_login_device_id
  ) VALUES (
    device.organization_id, device.branch_id, ARRAY[entry_pin.station_id], left(station_name,80),
    encode(extensions.digest(convert_to(display_token,'UTF8'),'sha256'),'hex'),
    device.paired_by, display_expiry, entry_pin.user_id, device.id
  );

  UPDATE public.neo_staff_login_devices SET
    failed_attempts=0, blocked_until=NULL, attempt_window=now(), last_used_at=now()
  WHERE id=device.id;

  RETURN jsonb_build_object('ok',true,'kind','display','branch_id',device.branch_id,
    'display_token',display_token,'expires_at',display_expiry);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_staff_pin_sign_in(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_staff_pin_sign_in(text,text) TO service_role;
NOTIFY pgrst, 'reload schema';
