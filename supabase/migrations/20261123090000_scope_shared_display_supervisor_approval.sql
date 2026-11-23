BEGIN;

CREATE OR REPLACE FUNCTION public.neo_display_supervisor_allowed(_organization uuid, _branch uuid, _stations uuid[])
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH actor_roles AS (
    SELECT public.neo_resolve_role_template_key(r.normalized_role_key, r.name) AS role_key
    FROM public.user_roles ur
    JOIN public.roles r ON r.id=ur.role_id AND r.organization_id=ur.organization_id
    WHERE ur.user_id=auth.uid() AND ur.organization_id=_organization
      AND coalesce(r.active,true) AND coalesce(r.role_status,'active')<>'archived'
  ), authority AS (
    SELECT public.neo_device_admin_allowed() IS TRUE AS workspace_admin,
      EXISTS (SELECT 1 FROM actor_roles WHERE role_key='operations-manager') AS operations_manager,
      EXISTS (SELECT 1 FROM actor_roles WHERE role_key IN (
        'hot-kitchen-supervisor','coffee-station-supervisor','chief-steward'
      )) AS station_supervisor,
      EXISTS (SELECT 1 FROM actor_roles WHERE role_key IN (
        'head-chef','head-pastry-chef','food-and-beverage-manager','bar-manager','restaurant-manager'
      )) AS department_manager,
      public.neo_production_can_manage() IS TRUE AS production_manager
  )
  SELECT coalesce(public.current_org_id()=_organization AND public.is_active_staff(),false)
    AND coalesce(cardinality(_stations)>0,false)
    AND (a.workspace_admin OR public.neo_branch_in_scope(_branch) IS TRUE)
    AND NOT EXISTS (
      SELECT 1 FROM unnest(_stations) requested(id)
      LEFT JOIN public.operational_stations s ON s.id=requested.id
        AND s.organization_id=_organization AND s.branch_id=_branch AND s.active
      WHERE s.id IS NULL OR NOT (
        a.workspace_admin OR a.operations_manager
        OR s.supervisor_user_id IS NOT DISTINCT FROM auth.uid()
        OR (a.station_supervisor AND EXISTS (
          SELECT 1 FROM public.user_stations us
          WHERE us.organization_id=_organization AND us.station_id=s.id AND us.user_id=auth.uid()
        ))
        OR (a.department_manager AND s.department_id=ANY(public.current_department_ids())) IS TRUE
        OR (a.production_manager AND s.id=ANY(public.neo_kitchen_visible_station_ids())) IS TRUE
      )
    )
  FROM authority a;
$function$;

REVOKE ALL ON FUNCTION public.neo_display_supervisor_allowed(uuid,uuid,uuid[]) FROM PUBLIC, anon, authenticated;

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
  IF s.closed_at IS NOT NULL OR s.expires_at<=now() THEN
    RETURN jsonb_build_object('ok',false,'message','Supervisor approval is unavailable. Check the screen or try again later.');
  END IF;

  IF s.blocked_until>now() THEN
    RETURN jsonb_build_object('ok',false,'message',format(
      'Too many PIN attempts. Try again in %s minute(s).',
      greatest(1,ceil(extract(epoch FROM s.blocked_until-now())/60)::integer)));
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
      permitted := public.neo_display_supervisor_allowed(s.organization_id,s.branch_id,s.station_ids);
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
    RETURN jsonb_build_object('ok',false,'message','Use the personal PIN of a supervisor or manager authorised for this display.');
  END IF;

  UPDATE public.neo_production_display_sessions SET failed_attempts=0, blocked_until=NULL, attempt_window=now(),
    closed_at=CASE WHEN _action='logout' THEN now() ELSE closed_at END WHERE id=s.id;
  RETURN jsonb_build_object('ok',true,'action',_action);
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_production_display_supervisor(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_production_display_supervisor(text,text,text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
