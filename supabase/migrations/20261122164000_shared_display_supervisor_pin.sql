CREATE OR REPLACE FUNCTION public.neo_production_display_supervisor(_token text, _pin text, _action text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s public.neo_production_display_sessions;
  candidates uuid[];
  permitted boolean := false;
  prior_claims text := current_setting('request.jwt.claims', true);
  prior_sub text := current_setting('request.jwt.claim.sub', true);
  prior_role text := current_setting('request.jwt.claim.role', true);
BEGIN
  IF _action IS NULL OR _action NOT IN ('tools', 'logout') THEN
    RAISE EXCEPTION 'Choose a display action' USING ERRCODE='22023';
  END IF;
  s := public.neo_production_require_session(_token);
  SELECT * INTO s FROM public.neo_production_display_sessions WHERE id=s.id FOR UPDATE;
  IF s.closed_at IS NOT NULL OR s.expires_at<=now() OR s.blocked_until>now() THEN
    RETURN jsonb_build_object('ok',false,'message','Supervisor approval is unavailable. Check the screen or try again later.');
  END IF;

  IF _pin ~ '^[0-9]{6}$' THEN
    SELECT array_agg(c.user_id) INTO candidates FROM public.neo_production_staff_codes c
    WHERE c.organization_id=s.organization_id AND c.enabled
      AND (c.blocked_until IS NULL OR c.blocked_until<=now())
      AND extensions.crypt(_pin,c.pin_hash)=c.pin_hash;
  END IF;
  IF cardinality(candidates)=1 THEN
    BEGIN
      PERFORM public.neo_production_context(candidates[1]);
      permitted := public.current_org_id()=s.organization_id
        AND public.neo_production_can_manage() IS TRUE
        AND public.neo_branch_in_scope(s.branch_id) IS TRUE
        AND (s.station_ids <@ public.neo_kitchen_visible_station_ids()) IS TRUE;
    EXCEPTION WHEN insufficient_privilege THEN
      permitted := false;
    END;
    PERFORM set_config('request.jwt.claims',coalesce(prior_claims,''),true);
    PERFORM set_config('request.jwt.claim.sub',coalesce(prior_sub,''),true);
    PERFORM set_config('request.jwt.claim.role',coalesce(prior_role,''),true);
    PERFORM public.neo_access_cache_bump();
  END IF;

  IF permitted IS NOT TRUE THEN
    IF s.attempt_window<=now()-interval '15 minutes' THEN
      s.failed_attempts := 0;
      s.attempt_window := now();
    END IF;
    UPDATE public.neo_production_display_sessions SET failed_attempts=s.failed_attempts+1,
      attempt_window=s.attempt_window,
      blocked_until=CASE WHEN s.failed_attempts+1>=5 THEN now()+interval '15 minutes' ELSE NULL END
    WHERE id=s.id;
    RETURN jsonb_build_object('ok',false,'message','Use the personal PIN of a supervisor assigned to this display.');
  END IF;

  UPDATE public.neo_production_display_sessions SET failed_attempts=0, blocked_until=NULL, attempt_window=now(),
    closed_at=CASE WHEN _action='logout' THEN now() ELSE closed_at END WHERE id=s.id;
  RETURN jsonb_build_object('ok',true,'action',_action);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_production_display_supervisor(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_production_display_supervisor(text,text,text) TO anon, authenticated;
