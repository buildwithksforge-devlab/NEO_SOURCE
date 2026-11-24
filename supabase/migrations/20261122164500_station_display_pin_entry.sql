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
