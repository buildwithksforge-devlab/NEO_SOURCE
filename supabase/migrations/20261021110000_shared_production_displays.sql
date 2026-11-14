-- Shared production displays. Additive: existing POS/stock transitions unchanged.
BEGIN;
DO $preflight$
BEGIN
  IF to_regprocedure('extensions.crypt(text,text)') IS NULL
    OR to_regprocedure('extensions.gen_salt(text,integer)') IS NULL
    OR to_regprocedure('extensions.gen_random_bytes(integer)') IS NULL
    OR to_regprocedure('public.neo_kitchen_ticket_transition(uuid,text,text)') IS NULL
    OR to_regprocedure('public.neo_kitchen_visible_station_ids()') IS NULL THEN
    RAISE EXCEPTION 'Shared displays require the existing kitchen functions and pgcrypto in the extensions schema. No changes installed.';
  END IF;
END $preflight$;

CREATE TABLE IF NOT EXISTS public.neo_production_display_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  station_ids uuid[] NOT NULL CHECK (cardinality(station_ids) BETWEEN 1 AND 16),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  read_only boolean NOT NULL DEFAULT false,
  token_hash text NOT NULL UNIQUE,
  opened_by uuid NOT NULL REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '12 hours'),
  closed_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0,
  attempt_window timestamptz NOT NULL DEFAULT now(),
  blocked_until timestamptz
);
CREATE TABLE IF NOT EXISTS public.neo_production_staff_codes (
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  staff_code text NOT NULL,
  pin_hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0,
  blocked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id),
  UNIQUE (organization_id, staff_code)
);
CREATE TABLE IF NOT EXISTS public.neo_production_display_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.neo_production_display_sessions(id),
  request_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  station_id uuid NOT NULL REFERENCES public.operational_stations(id),
  ticket_id uuid NOT NULL REFERENCES public.station_tickets(id),
  actor_id uuid NOT NULL REFERENCES public.profiles(id),
  supervisor_id uuid NOT NULL REFERENCES public.profiles(id),
  from_status text NOT NULL,
  to_status text NOT NULL,
  reason text,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, request_id)
);
CREATE INDEX IF NOT EXISTS neo_production_display_sessions_scope_idx
  ON public.neo_production_display_sessions (organization_id, branch_id, expires_at);
CREATE INDEX IF NOT EXISTS neo_production_display_actions_ticket_idx
  ON public.neo_production_display_actions (organization_id, ticket_id, created_at);

ALTER TABLE public.neo_production_display_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.neo_production_staff_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.neo_production_display_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.neo_production_display_sessions,
  public.neo_production_staff_codes, public.neo_production_display_actions
  FROM PUBLIC, anon, authenticated;

-- Private, narrowly used delegation. Never grant this helper to API roles.
-- Caller functions save and restore all three JWT settings, also on exceptions.
CREATE OR REPLACE FUNCTION public.neo_production_context(_actor uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub',_actor,'role','authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', _actor::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM public.neo_access_cache_bump();
END $$;
REVOKE ALL ON FUNCTION public.neo_production_context(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.neo_production_can_manage()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.is_active_staff() AND (
    public.is_org_admin()
    OR public.has_exact_permission('kitchen','*','production.manage')
    OR public.has_exact_permission('kitchen','*','chef.assign')
    OR public.has_exact_permission('bar','queue','assign')
  );
$$;
REVOKE ALL ON FUNCTION public.neo_production_can_manage() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.neo_production_require_session(_token text)
RETURNS public.neo_production_display_sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.neo_production_display_sessions;
BEGIN
  IF _token IS NULL OR _token !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Display session is unavailable. Ask a supervisor to pair this screen again.' USING ERRCODE='42501';
  END IF;
  SELECT * INTO s FROM public.neo_production_display_sessions
  WHERE token_hash=encode(extensions.digest(convert_to(_token,'UTF8'),'sha256'),'hex')
    AND closed_at IS NULL AND expires_at>now();
  IF s.id IS NULL THEN
    RAISE EXCEPTION 'Display session is unavailable. Ask a supervisor to pair this screen again.' USING ERRCODE='42501';
  END IF;
  RETURN s;
END $$;
REVOKE ALL ON FUNCTION public.neo_production_require_session(text) FROM PUBLIC, anon, authenticated;

-- Called ONLY after setting the saved supervisor identity. Scope/role revocation
-- takes effect on every read and action, not just when the device is paired.
CREATE OR REPLACE FUNCTION public.neo_production_assert_supervisor(_session uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.neo_production_display_sessions;
BEGIN
  SELECT * INTO s FROM public.neo_production_display_sessions WHERE id=_session;
  IF s.id IS NULL OR s.closed_at IS NOT NULL OR s.expires_at<=now()
     OR s.opened_by IS DISTINCT FROM auth.uid()
     OR s.organization_id IS DISTINCT FROM public.current_org_id()
     OR NOT public.neo_production_can_manage()
     OR NOT (s.station_ids <@ public.neo_kitchen_visible_station_ids())
     OR (s.read_only AND NOT public.has_permission('kitchen','all_stations','view'))
     OR EXISTS (SELECT 1 FROM unnest(s.station_ids) wanted(id)
       LEFT JOIN public.operational_stations st ON st.id=wanted.id
       WHERE st.id IS NULL OR NOT st.active
         OR st.organization_id IS DISTINCT FROM s.organization_id
         OR st.branch_id IS DISTINCT FROM s.branch_id)
  THEN RAISE EXCEPTION 'Display authorisation has expired or changed. Ask a supervisor to pair this screen again.' USING ERRCODE='42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.neo_production_assert_supervisor(uuid) FROM PUBLIC, anon, authenticated;

-- Personal enrolment/reset: requires a normal authenticated staff account.
-- A staff code is an identifier, never a secret. No PIN/hash is ever returned.
CREATE OR REPLACE FUNCTION public.neo_production_staff_pin(_pin text DEFAULT NULL, _disable boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_org uuid:=public.current_org_id(); c public.neo_production_staff_codes; v_code text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_active_staff() OR NOT (
    public.has_permission('kitchen','ticket.accept')
    OR public.has_permission('kitchen','item.prepare')
    OR public.has_permission('bar','queue','edit')
    OR public.neo_production_can_manage()
  ) THEN RAISE EXCEPTION 'An authorised production staff account is required.' USING ERRCODE='42501'; END IF;
  SELECT * INTO c FROM public.neo_production_staff_codes WHERE organization_id=v_org AND user_id=auth.uid() FOR UPDATE;
  IF _disable THEN
    UPDATE public.neo_production_staff_codes SET enabled=false, updated_at=now()
      WHERE organization_id=v_org AND user_id=auth.uid();
    RETURN jsonb_build_object('ok',true,'staff_code',c.staff_code,'pin_set',false);
  END IF;
  IF _pin IS NOT NULL THEN
    IF _pin !~ '^[0-9]{6}$' THEN RAISE EXCEPTION 'Use a six-digit personal PIN.' USING ERRCODE='22023'; END IF;
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
REVOKE ALL ON FUNCTION public.neo_production_staff_pin(text,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_production_staff_pin(text,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_production_display_pair(_branch uuid, _stations uuid[], _label text, _read_only boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_org uuid:=public.current_org_id(); v_token text; v_id uuid; v_stations uuid[];
BEGIN
  IF NOT public.neo_production_can_manage() THEN RAISE EXCEPTION 'A production supervisor must pair this screen.' USING ERRCODE='42501'; END IF;
  SELECT array_agg(DISTINCT id) INTO v_stations FROM unnest(_stations) x(id) WHERE id IS NOT NULL;
  IF coalesce(cardinality(v_stations),0) NOT BETWEEN 1 AND 16
    OR length(btrim(coalesce(_label,''))) NOT BETWEEN 1 AND 80
    OR NOT (v_stations <@ public.neo_kitchen_visible_station_ids())
    OR (_read_only AND NOT public.has_permission('kitchen','all_stations','view'))
    OR NOT EXISTS(SELECT 1 FROM public.branches WHERE id=_branch AND organization_id=v_org)
    OR EXISTS(SELECT 1 FROM unnest(v_stations) x(id)
      LEFT JOIN public.operational_stations s ON s.id=x.id
      WHERE s.id IS NULL OR NOT s.active OR s.organization_id IS DISTINCT FROM v_org
        OR s.branch_id IS DISTINCT FROM _branch OR s.station_type='service')
  THEN RAISE EXCEPTION 'Select active production stations in one authorised property.' USING ERRCODE='42501'; END IF;
  v_token:=encode(extensions.gen_random_bytes(32),'hex');
  INSERT INTO public.neo_production_display_sessions(organization_id,branch_id,station_ids,label,read_only,token_hash,opened_by)
    VALUES(v_org,_branch,v_stations,btrim(_label),coalesce(_read_only,false),
      encode(extensions.digest(convert_to(v_token,'UTF8'),'sha256'),'hex'),auth.uid()) RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok',true,'session_id',v_id,'token',v_token,'expires_at',now()+interval '12 hours');
END $$;
REVOKE ALL ON FUNCTION public.neo_production_display_pair(uuid,uuid[],text,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_production_display_pair(uuid,uuid[],text,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_production_display_manage(_close uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_org uuid:=public.current_org_id(); v_rows jsonb;
BEGIN
  IF NOT public.neo_production_can_manage() THEN RAISE EXCEPTION 'Production supervisor access is required.' USING ERRCODE='42501'; END IF;
  IF _close IS NOT NULL THEN
    UPDATE public.neo_production_display_sessions SET closed_at=coalesce(closed_at,now())
    WHERE id=_close AND organization_id=v_org
      AND (opened_by=auth.uid() OR station_ids <@ public.neo_kitchen_visible_station_ids());
    IF NOT FOUND THEN RAISE EXCEPTION 'Display session is outside your scope.' USING ERRCODE='42501'; END IF;
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'label',s.label,'branch_id',s.branch_id,
    'station_ids',s.station_ids,'read_only',s.read_only,'opened_by',s.opened_by,'expires_at',s.expires_at,
    'closed_at',s.closed_at) ORDER BY s.created_at DESC),'[]'::jsonb) INTO v_rows
  FROM public.neo_production_display_sessions s WHERE s.organization_id=v_org
    AND s.expires_at>now() AND s.closed_at IS NULL
    AND (s.opened_by=auth.uid() OR s.station_ids <@ public.neo_kitchen_visible_station_ids());
  RETURN jsonb_build_object('ok',true,'sessions',v_rows);
END $$;
REVOKE ALL ON FUNCTION public.neo_production_display_manage(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_production_display_manage(uuid) TO authenticated;

-- Token-authenticated read: deliberately callable after supervisor signs out.
CREATE OR REPLACE FUNCTION public.neo_production_display_read(_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.neo_production_display_sessions; v_result jsonb; v_tickets jsonb;
  v_claims text:=current_setting('request.jwt.claims',true);
  v_sub text:=current_setting('request.jwt.claim.sub',true);
  v_role text:=current_setting('request.jwt.claim.role',true);
BEGIN
  s:=public.neo_production_require_session(_token);
  PERFORM public.neo_production_context(s.opened_by);
  PERFORM public.neo_production_assert_supervisor(s.id);
  SELECT coalesce(jsonb_agg(to_jsonb(q) || jsonb_build_object('claimed_by',(
    SELECT p.full_name FROM public.station_ticket_items ti JOIN public.profiles p ON p.id=ti.chef_id
    WHERE ti.ticket_id=q.ticket_id AND ti.organization_id=s.organization_id AND ti.chef_id IS NOT NULL
      AND ti.status NOT IN ('cancelled','completed') ORDER BY ti.accepted_at NULLS LAST,ti.id LIMIT 1
  )) ORDER BY q.received_at),'[]'::jsonb) INTO v_tickets
  FROM public.neo_kitchen_queue(s.branch_id,NULL,'live') q
  WHERE q.station_id=ANY(s.station_ids);
  v_result:=jsonb_build_object('ok',true,'session_id',s.id,'label',s.label,'read_only',s.read_only,
    'property',(SELECT name FROM public.branches WHERE id=s.branch_id),
    'expires_at',s.expires_at,'server_time',now(),'blocked_until',s.blocked_until,
    'stations',(SELECT jsonb_agg(jsonb_build_object('id',st.id,'name',st.name) ORDER BY st.sort_order,st.name)
      FROM public.operational_stations st WHERE st.id=ANY(s.station_ids)), 'tickets',v_tickets);
  PERFORM set_config('request.jwt.claims',coalesce(v_claims,''),true);
  PERFORM set_config('request.jwt.claim.sub',coalesce(v_sub,''),true);
  PERFORM set_config('request.jwt.claim.role',coalesce(v_role,''),true);
  PERFORM public.neo_access_cache_bump();
  RETURN v_result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('request.jwt.claims',coalesce(v_claims,''),true);
  PERFORM set_config('request.jwt.claim.sub',coalesce(v_sub,''),true);
  PERFORM set_config('request.jwt.claim.role',coalesce(v_role,''),true);
  PERFORM public.neo_access_cache_bump();
  RAISE;
END $$;
REVOKE ALL ON FUNCTION public.neo_production_display_read(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_production_display_read(text) TO anon, authenticated;

-- One PIN authorises one action. Expected status + row locks prevent two staff
-- claiming the same work. Request IDs make uncertain-network retries idempotent.
CREATE OR REPLACE FUNCTION public.neo_production_display_act(
  _token text, _code text, _pin text, _ticket uuid, _to text,
  _expected text, _request uuid, _reason text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.neo_production_display_sessions; c public.neo_production_staff_codes;
  t public.station_tickets; a public.neo_production_display_actions;
  v_result jsonb; v_actor_name text; v_error text; v_bar boolean;
  v_claims text:=current_setting('request.jwt.claims',true);
  v_sub text:=current_setting('request.jwt.claim.sub',true);
  v_role text:=current_setting('request.jwt.claim.role',true);
BEGIN
  s:=public.neo_production_require_session(_token);
  SELECT * INTO s FROM public.neo_production_display_sessions WHERE id=s.id FOR UPDATE;
  IF s.closed_at IS NOT NULL OR s.expires_at<=now() OR s.read_only THEN
    RETURN jsonb_build_object('ok',false,'reason','display_unavailable','message','This display cannot perform production actions.');
  END IF;
  IF s.blocked_until>now() THEN
    RETURN jsonb_build_object('ok',false,'reason','locked','message','Too many attempts. Ask a supervisor for help.','retry_at',s.blocked_until);
  END IF;
  IF _request IS NULL OR _expected IS NULL OR _ticket IS NULL
     OR _to IS NULL OR _to NOT IN ('accepted','preparing','ready','delay')
     OR length(coalesce(_reason,''))>500
     OR (_to='delay' AND length(btrim(coalesce(_reason,'')))<3) THEN
    RETURN jsonb_build_object('ok',false,'reason','invalid_action','message','Choose a valid production action and required reason.');
  END IF;
  PERFORM public.neo_production_context(s.opened_by);
  PERFORM public.neo_production_assert_supervisor(s.id);
  -- Restore before credential checking; no supervisor authority reaches staff work.
  PERFORM set_config('request.jwt.claims',coalesce(v_claims,''),true);
  PERFORM set_config('request.jwt.claim.sub',coalesce(v_sub,''),true);
  PERFORM set_config('request.jwt.claim.role',coalesce(v_role,''),true);
  PERFORM public.neo_access_cache_bump();

  SELECT * INTO c FROM public.neo_production_staff_codes
    WHERE organization_id=s.organization_id AND staff_code=upper(btrim(left(coalesce(_code,''),24))) FOR UPDATE;
  IF c.blocked_until>now() THEN
    RETURN jsonb_build_object('ok',false,'reason','credentials','message','Staff code or PIN not accepted. Try later or reset your PIN in your staff account.');
  END IF;
  IF c.user_id IS NULL OR length(btrim(coalesce(_code,'')))>24 OR NOT coalesce(c.enabled,false) OR _pin IS NULL OR _pin !~ '^[0-9]{6}$'
     OR extensions.crypt(left(coalesce(_pin,''),6),coalesce(c.pin_hash,extensions.gen_salt('bf',10))) IS DISTINCT FROM c.pin_hash THEN
    -- Return, do not RAISE: rate-limit counters must survive the failed attempt.
    IF s.attempt_window<now()-interval '15 minutes' THEN s.failed_attempts:=0; s.attempt_window:=now(); END IF;
    UPDATE public.neo_production_display_sessions SET failed_attempts=s.failed_attempts+1, attempt_window=s.attempt_window,
      blocked_until=CASE WHEN s.failed_attempts+1>=20 THEN now()+interval '15 minutes' ELSE NULL END WHERE id=s.id;
    IF c.user_id IS NOT NULL THEN
      UPDATE public.neo_production_staff_codes SET
        failed_attempts=CASE WHEN blocked_until IS NOT NULL AND blocked_until<=now() THEN 1 ELSE failed_attempts+1 END,
        blocked_until=CASE WHEN (CASE WHEN blocked_until IS NOT NULL AND blocked_until<=now() THEN 1 ELSE failed_attempts+1 END)>=5
          THEN now()+interval '15 minutes' ELSE NULL END
      WHERE organization_id=s.organization_id AND user_id=c.user_id;
    END IF;
    RETURN jsonb_build_object('ok',false,'reason','credentials','message','Staff code or PIN not accepted. Try later or reset your PIN in your staff account.');
  END IF;

  PERFORM public.neo_production_context(c.user_id);
  BEGIN
    IF public.current_org_id() IS DISTINCT FROM s.organization_id OR NOT public.is_active_staff() THEN
      RAISE EXCEPTION 'This staff account is not active in this organisation.' USING ERRCODE='42501';
    END IF;
    SELECT * INTO t FROM public.station_tickets WHERE id=_ticket AND organization_id=s.organization_id FOR UPDATE;
    IF t.id IS NULL OR t.branch_id IS DISTINCT FROM s.branch_id OR t.station_id IS NULL
       OR NOT (t.station_id=ANY(s.station_ids))
       OR NOT (t.station_id=ANY(public.neo_kitchen_visible_station_ids())) THEN
      RAISE EXCEPTION 'This ticket is outside your assigned display stations.' USING ERRCODE='42501';
    END IF;
    PERFORM public.neo_kitchen_assert_station_authority(t.id);
    v_bar:=t.station_id IN (SELECT public.neo_bar_station_ids(t.branch_id));
    IF NOT (public.has_permission('kitchen',CASE _to WHEN 'accepted' THEN 'ticket.accept' WHEN 'ready' THEN 'item.ready' ELSE 'item.prepare' END)
      OR (v_bar AND public.has_permission('bar','queue','edit'))) THEN
      RAISE EXCEPTION 'You do not have permission to perform this station action.' USING ERRCODE='42501';
    END IF;
    SELECT * INTO a FROM public.neo_production_display_actions WHERE session_id=s.id AND request_id=_request;
    IF a.id IS NOT NULL THEN
      IF a.actor_id IS DISTINCT FROM c.user_id OR a.ticket_id IS DISTINCT FROM _ticket
        OR a.to_status IS DISTINCT FROM _to OR a.from_status IS DISTINCT FROM _expected
        OR a.reason IS DISTINCT FROM nullif(btrim(_reason),'') THEN
        RAISE EXCEPTION 'This request ID was already used for a different action.' USING ERRCODE='22023';
      END IF;
      v_result:=a.result || jsonb_build_object('idempotent',true);
    ELSE
      IF t.status IS DISTINCT FROM _expected THEN
        RAISE EXCEPTION 'Ticket changed from % to %. Refresh and review it before acting.',_expected,t.status USING ERRCODE='40001';
      END IF;
      PERFORM id FROM public.station_ticket_items WHERE ticket_id=t.id ORDER BY id FOR UPDATE;
      IF (t.assigned_chef_id IS NOT NULL AND t.assigned_chef_id<>c.user_id
          OR EXISTS(SELECT 1 FROM public.station_ticket_items WHERE ticket_id=t.id
            AND status NOT IN ('cancelled','completed') AND chef_id IS NOT NULL AND chef_id<>c.user_id))
          AND NOT public.neo_can_assign_kitchen_work() THEN
        RAISE EXCEPTION 'Another staff member owns this ticket. A supervisor must reassign it.' USING ERRCODE='42501';
      END IF;
      IF _to='delay' THEN
        IF t.status IN ('ready','served','completed','cancelled') THEN RAISE EXCEPTION 'This ticket is no longer awaiting preparation.'; END IF;
        UPDATE public.station_tickets SET delay_reason=btrim(_reason),updated_at=now() WHERE id=t.id;
        INSERT INTO public.station_ticket_status_history(organization_id,ticket_id,from_status,to_status,reason,changed_by)
          VALUES(s.organization_id,t.id,t.status,t.status,'delay: '||btrim(_reason),c.user_id);
        v_result:=jsonb_build_object('ticket_status',t.status);
      ELSE
        v_result:=public.neo_kitchen_ticket_transition(t.id,_to,NULL);
      END IF;
      SELECT full_name INTO v_actor_name FROM public.profiles WHERE id=c.user_id;
      v_result:=coalesce(v_result,'{}'::jsonb)||jsonb_build_object('ok',true,'actor_name',v_actor_name,'actor_id',c.user_id,'idempotent',false);
      INSERT INTO public.neo_production_display_actions(session_id,request_id,organization_id,branch_id,station_id,ticket_id,
        actor_id,supervisor_id,from_status,to_status,reason,result)
        VALUES(s.id,_request,s.organization_id,s.branch_id,t.station_id,t.id,c.user_id,s.opened_by,
          _expected,_to,nullif(btrim(_reason),''),v_result);
    END IF;
    UPDATE public.neo_production_staff_codes SET failed_attempts=0, blocked_until=NULL WHERE organization_id=s.organization_id AND user_id=c.user_id;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error=MESSAGE_TEXT;
    -- Nested transaction rolls back all partial ticket changes before returning.
    v_result:=jsonb_build_object('ok',false,'reason','action_refused','message',v_error);
  END;
  PERFORM set_config('request.jwt.claims',coalesce(v_claims,''),true);
  PERFORM set_config('request.jwt.claim.sub',coalesce(v_sub,''),true);
  PERFORM set_config('request.jwt.claim.role',coalesce(v_role,''),true);
  PERFORM public.neo_access_cache_bump();
  RETURN v_result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('request.jwt.claims',coalesce(v_claims,''),true);
  PERFORM set_config('request.jwt.claim.sub',coalesce(v_sub,''),true);
  PERFORM set_config('request.jwt.claim.role',coalesce(v_role,''),true);
  PERFORM public.neo_access_cache_bump();
  RAISE;
END $$;
REVOKE ALL ON FUNCTION public.neo_production_display_act(text,text,text,uuid,text,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_production_display_act(text,text,text,uuid,text,text,uuid,text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
SELECT 'Shared production display backend' AS check_name, 'INSTALLED' AS result;
