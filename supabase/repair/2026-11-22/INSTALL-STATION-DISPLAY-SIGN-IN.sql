-- Install only the station-account and paired-display PIN database changes.
BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.neo_device_admin_allowed()') IS NULL
     OR to_regprocedure('public.neo_branch_in_scope(uuid)') IS NULL
     OR to_regprocedure('public.neo_kitchen_visible_station_ids()') IS NULL
     OR to_regprocedure('public.neo_production_staff_pin(text,boolean)') IS NULL
     OR to_regprocedure('public.neo_production_require_session(text)') IS NULL
     OR to_regprocedure('public.neo_staff_login_device_resolve(text,text)') IS NULL
     OR to_regclass('public.neo_production_display_sessions') IS NULL
     OR to_regclass('public.neo_production_staff_codes') IS NULL
     OR to_regclass('public.neo_staff_login_devices') IS NULL
  THEN
    RAISE EXCEPTION 'Required staff-device or production-display database components are missing.';
  END IF;
END;
$preflight$;

-- 20261121123800_station_account_entry
CREATE TABLE IF NOT EXISTS public.neo_station_account_entry (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  station_id uuid NOT NULL REFERENCES public.operational_stations(id) ON DELETE CASCADE,
  PRIMARY KEY (organization_id, user_id)
);
ALTER TABLE public.neo_station_account_entry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.neo_station_account_entry FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.neo_station_login_admin(
  _branch uuid, _station uuid, _user uuid DEFAULT NULL, _remove boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE org uuid := public.current_org_id();
BEGIN
  IF NOT coalesce(public.neo_device_admin_allowed(), false) OR org IS NULL OR _branch IS NULL
      OR NOT coalesce(public.neo_branch_in_scope(_branch), false) THEN
    RAISE EXCEPTION 'Owner or System Administrator access to this property is required.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.operational_stations s WHERE s.id = _station
      AND s.organization_id = org AND s.branch_id = _branch AND s.active
  ) THEN
    RAISE EXCEPTION 'Choose an active station at this property.' USING ERRCODE = '42501';
  END IF;

  IF _user IS NULL THEN
    RETURN coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'email', p.email,
        'pin_set', coalesce(c.enabled, false), 'opens_station', coalesce(e.station_id = _station, false)) ORDER BY p.full_name, p.id)
      FROM public.profiles p
      LEFT JOIN public.neo_station_account_entry e ON e.user_id = p.id AND e.organization_id = org
      LEFT JOIN public.neo_production_staff_codes c ON c.user_id = p.id AND c.organization_id = org
      WHERE p.organization_id = org AND coalesce(p.account_type, 'staff') = 'staff'
        AND coalesce(p.account_status, 'active') = 'active' AND EXISTS (
          SELECT 1 FROM public.user_stations a WHERE a.organization_id = org AND a.user_id = p.id AND a.station_id = _station
        )
    ), '[]'::jsonb);
  END IF;

  IF _remove THEN
    DELETE FROM public.neo_station_account_entry WHERE organization_id = org AND user_id = _user
      AND branch_id = _branch AND station_id = _station;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM public.user_stations a JOIN public.profiles p ON p.id = a.user_id
      WHERE a.organization_id = org AND a.user_id = _user AND a.station_id = _station
        AND p.organization_id = org AND coalesce(p.account_type, 'staff') = 'staff'
        AND coalesce(p.account_status, 'active') = 'active'
    ) THEN
      RAISE EXCEPTION 'Assign this active staff account to the station before configuring sign-in.' USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.neo_station_account_entry AS e (organization_id, user_id, branch_id, station_id)
    VALUES (org, _user, _branch, _station)
    ON CONFLICT (organization_id, user_id) DO UPDATE
      SET branch_id = excluded.branch_id, station_id = excluded.station_id
      WHERE coalesce(public.neo_branch_in_scope(e.branch_id), false);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The account has a display at a property outside your access.' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.neo_station_login_destination(_branch uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('id', s.id, 'branch_id', s.branch_id, 'name', s.name, 'code', s.code,
    'station_type', s.station_type, 'department_key', d.catalogue_key)
  FROM public.neo_station_account_entry e
  JOIN public.profiles p ON p.id = e.user_id AND p.organization_id = e.organization_id
  JOIN public.operational_stations s ON s.id = e.station_id AND s.organization_id = e.organization_id AND s.branch_id = e.branch_id
  LEFT JOIN public.departments d ON d.id = s.department_id AND d.organization_id = e.organization_id
  WHERE e.organization_id = public.current_org_id() AND e.user_id = auth.uid()
    AND coalesce(p.account_type, 'staff') = 'staff' AND coalesce(p.account_status, 'active') = 'active'
    AND s.active AND (_branch IS NULL OR e.branch_id = _branch)
    AND coalesce(public.neo_branch_in_scope(e.branch_id), false)
    AND s.id = ANY(public.neo_kitchen_visible_station_ids())
    AND EXISTS (SELECT 1 FROM public.user_stations a WHERE a.organization_id = e.organization_id
      AND a.user_id = e.user_id AND a.station_id = e.station_id);
$$;

REVOKE ALL ON FUNCTION public.neo_station_login_admin(uuid,uuid,uuid,boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.neo_station_login_destination(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_station_login_admin(uuid,uuid,uuid,boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_station_login_destination(uuid) TO authenticated;

-- 20261122164500_station_display_pin_entry
CREATE TABLE IF NOT EXISTS public.neo_station_entry_pins (
  organization_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  station_id uuid NOT NULL REFERENCES public.operational_stations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  pin_hash text NOT NULL,
  PRIMARY KEY (organization_id, station_id, user_id)
);
ALTER TABLE public.neo_station_entry_pins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.neo_station_entry_pins FROM PUBLIC, anon, authenticated;
ALTER TABLE public.neo_production_display_sessions ADD COLUMN IF NOT EXISTS entry_actor uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

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
  PERFORM pg_advisory_xact_lock(hashtextextended('display-entry:'||org::text,0));
  IF _pin IS NOT NULL AND (EXISTS(SELECT 1 FROM public.neo_production_staff_codes c
      WHERE c.organization_id=org AND c.enabled AND extensions.crypt(_pin,c.pin_hash)=c.pin_hash)
    OR EXISTS(SELECT 1 FROM public.neo_station_entry_pins c WHERE c.organization_id=org
      AND c.user_id<>_user AND extensions.crypt(_pin,c.pin_hash)=c.pin_hash)) THEN
    RAISE EXCEPTION 'Choose a different display PIN';
  END IF;
  IF _pin IS NULL THEN
    DELETE FROM public.neo_station_entry_pins WHERE organization_id=org AND branch_id=_branch AND station_id=_station AND user_id=_user;
  ELSE
    INSERT INTO public.neo_station_entry_pins VALUES(org,_branch,_station,_user,extensions.crypt(_pin,extensions.gen_salt('bf',10)))
    ON CONFLICT (organization_id,station_id,user_id) DO UPDATE SET pin_hash=excluded.pin_hash;
  END IF;
  UPDATE public.neo_production_display_sessions SET entry_actor=NULL
  WHERE organization_id=org AND branch_id=_branch AND _station=ANY(station_ids) AND entry_actor=_user;
  RETURN jsonb_build_object('ok',true);
END;
$function$;

-- The pairing token identifies the screen. Private display reads and actions
-- also require the matching entry PIN when that station has been configured.
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
  RETURN s;
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_production_display_entry_ready(s public.neo_production_display_sessions)
RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public','pg_temp'
AS $function$
  SELECT NOT EXISTS(SELECT 1 FROM public.neo_station_entry_pins p
      WHERE p.organization_id=s.organization_id AND p.branch_id=s.branch_id AND p.station_id=ANY(s.station_ids))
    OR (s.entry_actor IS NOT NULL AND EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=s.entry_actor
        AND p.organization_id=s.organization_id AND coalesce(p.account_status,'active')='active' AND coalesce(p.account_type,'staff')='staff')
      AND EXISTS(SELECT 1 FROM public.neo_station_entry_pins k WHERE k.organization_id=s.organization_id
        AND k.branch_id=s.branch_id AND k.station_id=ANY(s.station_ids) AND k.user_id=s.entry_actor)
      AND NOT EXISTS(SELECT 1 FROM unnest(s.station_ids) station(id) WHERE NOT EXISTS (
        SELECT 1 FROM public.user_stations a WHERE a.organization_id=s.organization_id AND a.station_id=station.id AND a.user_id=s.entry_actor)));
$function$;

CREATE OR REPLACE FUNCTION public.neo_production_require_session(_token text)
RETURNS public.neo_production_display_sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE s public.neo_production_display_sessions := public.neo_production_paired_session(_token);
BEGIN
  IF public.neo_production_display_entry_ready(s) IS NOT TRUE THEN
    RAISE EXCEPTION 'Display PIN required' USING ERRCODE='42501';
  END IF;
  RETURN s;
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_production_display_entry(_token text, _pin text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE s public.neo_production_display_sessions := public.neo_production_paired_session(_token);
  candidates uuid[];
BEGIN
  SELECT * INTO s FROM public.neo_production_display_sessions WHERE id=s.id FOR UPDATE;
  IF s.closed_at IS NOT NULL OR s.expires_at<=now() THEN RAISE EXCEPTION 'Display session is unavailable' USING ERRCODE='42501'; END IF;
  IF public.neo_production_display_entry_ready(s) THEN RETURN jsonb_build_object('ready',true); END IF;
  IF _pin IS NULL THEN RETURN jsonb_build_object('ready',false); END IF;
  IF s.blocked_until>now() THEN RETURN jsonb_build_object('ready',false,'message','Too many attempts. Try again later.'); END IF;
  IF _pin ~ '^[0-9]{6}$' AND NOT EXISTS(SELECT 1 FROM public.neo_production_staff_codes c
    WHERE c.organization_id=s.organization_id AND c.enabled AND extensions.crypt(_pin,c.pin_hash)=c.pin_hash) THEN
    SELECT array_agg(DISTINCT k.user_id) INTO candidates
    FROM public.neo_station_entry_pins k JOIN public.profiles p ON p.id=k.user_id AND p.organization_id=k.organization_id
    WHERE k.organization_id=s.organization_id AND k.branch_id=s.branch_id AND k.station_id=ANY(s.station_ids)
      AND coalesce(p.account_status,'active')='active' AND coalesce(p.account_type,'staff')='staff'
      AND extensions.crypt(_pin,k.pin_hash)=k.pin_hash AND NOT EXISTS (
        SELECT 1 FROM unnest(s.station_ids) station(id) WHERE NOT EXISTS (
          SELECT 1 FROM public.user_stations a WHERE a.organization_id=s.organization_id AND a.station_id=station.id AND a.user_id=k.user_id));
  END IF;
  IF cardinality(candidates)=1 THEN
    UPDATE public.neo_production_display_sessions SET entry_actor=candidates[1], failed_attempts=0, blocked_until=NULL, attempt_window=now() WHERE id=s.id;
    RETURN jsonb_build_object('ready',true);
  END IF;
  IF s.attempt_window<=now()-interval '15 minutes' THEN s.failed_attempts:=0; s.attempt_window:=now(); END IF;
  UPDATE public.neo_production_display_sessions SET failed_attempts=s.failed_attempts+1, attempt_window=s.attempt_window,
    blocked_until=CASE WHEN s.failed_attempts+1>=5 THEN now()+interval '15 minutes' ELSE NULL END WHERE id=s.id;
  RETURN jsonb_build_object('ready',false,'message','Display PIN not accepted for these stations.');
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_production_paired_session(text), public.neo_production_display_entry_ready(public.neo_production_display_sessions), public.neo_production_require_session(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.neo_station_display_pin_admin(uuid,uuid,uuid,text), public.neo_production_display_entry(text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_station_display_pin_admin(uuid,uuid,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_production_display_entry(text,text) TO anon, authenticated;

-- 20261122170000_separate_production_pin_credentials
-- Use the same organization lock when enrolling either kind of PIN.
CREATE OR REPLACE FUNCTION public.neo_production_staff_pin(_pin text DEFAULT NULL, _disable boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_org uuid:=public.current_org_id(); c public.neo_production_staff_codes; v_code text;
BEGIN
  IF auth.uid() IS NULL
     OR NOT public.is_active_staff()
     OR v_org IS NULL
  THEN
    RAISE EXCEPTION 'An active staff account is required.'
      USING ERRCODE='42501';
  END IF;
  SELECT * INTO c FROM public.neo_production_staff_codes WHERE organization_id=v_org AND user_id=auth.uid() FOR UPDATE;
  IF _disable THEN
    UPDATE public.neo_production_staff_codes SET enabled=false, updated_at=now()
      WHERE organization_id=v_org AND user_id=auth.uid();
    RETURN jsonb_build_object('ok',true,'staff_code',c.staff_code,'pin_set',false);
  END IF;
  IF _pin IS NOT NULL THEN
    IF _pin !~ '^[0-9]{6}$' THEN RAISE EXCEPTION 'Use a six-digit personal PIN.' USING ERRCODE='22023'; END IF;
    -- Serialize PIN changes within the same organization.
    PERFORM pg_advisory_xact_lock(20261030, hashtext(v_org::text));

    -- Keep personal authorization and paired display entry credentials distinct.
    IF EXISTS (
      SELECT 1
      FROM public.neo_production_staff_codes existing
      WHERE existing.organization_id = v_org
        AND existing.user_id <> auth.uid()
        AND existing.enabled = true
        AND extensions.crypt(_pin, existing.pin_hash) = existing.pin_hash
    ) OR EXISTS (
      SELECT 1 FROM public.neo_station_entry_pins existing
      WHERE existing.organization_id = v_org
        AND extensions.crypt(_pin, existing.pin_hash) = existing.pin_hash
    ) THEN
      RAISE EXCEPTION 'This PIN is unavailable. Choose another six-digit PIN.'
        USING ERRCODE = '23505';
    END IF;
    SELECT upper(btrim(staff_id)) INTO v_code FROM public.profiles WHERE id=auth.uid();
    IF coalesce(v_code,'') !~ '^[A-Z0-9-]{3,24}$' THEN
      v_code:=upper(substr(replace(auth.uid()::text,'-',''),1,10));
    END IF;
    INSERT INTO public.neo_production_staff_codes(organization_id,user_id,staff_code,pin_hash)
      VALUES(v_org,auth.uid(),coalesce(c.staff_code,v_code),extensions.crypt(_pin,extensions.gen_salt('bf',10)))
    ON CONFLICT (organization_id,user_id) DO UPDATE SET
      pin_hash=EXCLUDED.pin_hash, enabled=true, failed_attempts=0, blocked_until=NULL, updated_at=now();
  END IF;
  SELECT * INTO c FROM public.neo_production_staff_codes WHERE organization_id=v_org AND user_id=auth.uid();
  RETURN jsonb_build_object('ok',true,'staff_code',c.staff_code,'pin_set',coalesce(c.enabled,false));
END $$;

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
      AND c.user_id<>_user AND extensions.crypt(_pin,c.pin_hash)=c.pin_hash)) THEN
    RAISE EXCEPTION 'Choose a different display PIN';
  END IF;
  IF _pin IS NULL THEN
    DELETE FROM public.neo_station_entry_pins WHERE organization_id=org AND branch_id=_branch AND station_id=_station AND user_id=_user;
  ELSE
    INSERT INTO public.neo_station_entry_pins VALUES(org,_branch,_station,_user,extensions.crypt(_pin,extensions.gen_salt('bf',10)))
    ON CONFLICT (organization_id,station_id,user_id) DO UPDATE SET pin_hash=excluded.pin_hash;
  END IF;
  UPDATE public.neo_production_display_sessions SET entry_actor=NULL
  WHERE organization_id=org AND branch_id=_branch AND _station=ANY(station_ids) AND entry_actor=_user;
  RETURN jsonb_build_object('ok',true);
END;
$function$;

-- 20261122173000_route_display_pin_sign_in
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

COMMIT;
