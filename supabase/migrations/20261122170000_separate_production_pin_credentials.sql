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
