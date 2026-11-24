-- Rollback-only verification using actual SCN station assignments.
-- Run after 20261021110000_shared_production_displays.sql.
BEGIN;
CREATE TEMP TABLE production_display_results(check_name text,result text,detail jsonb DEFAULT '{}'::jsonb) ON COMMIT DROP;
DO $tests$
DECLARE
  v_org constant uuid:='aa17d427-f816-49bc-b02e-1a89e44806a2';
  v_branch constant uuid:='2addbd01-c643-406a-bd7d-fac1aa76b23c';
  v_supervisor constant uuid:='d3054095-fdf6-41d0-a7e3-9bddbcd43a1a';
  v_staff constant uuid:='bddfb3f9-2f7e-491f-bde0-d88d596e86e0'; -- Violet, Hot Kitchen
  v_station constant uuid:='2289c806-1ac2-45be-a5a8-3c50bc4cd2de';
  v_other_station constant uuid:='ffdeb780-3d0d-4d3c-a5e9-c6c8e48ae2c7';
  v_order uuid:=gen_random_uuid(); v_item uuid:=gen_random_uuid(); v_ticket uuid:=gen_random_uuid();
  v_other_ticket uuid:=gen_random_uuid(); v_shift uuid:=gen_random_uuid();
  v_key uuid:=gen_random_uuid(); v_session uuid; v_ro_session uuid;
  v_token text; v_ro_token text; v_code text; v_stage text:='Fixture readiness';
  v_result jsonb; v_read jsonb; v_n integer; v_before integer; v_blocked boolean;
  v_error text; v_context text; v_accepted timestamptz;
BEGIN
  BEGIN
    PERFORM public.neo_production_context(v_supervisor);
    IF public.current_org_id() IS DISTINCT FROM v_org OR NOT public.neo_production_can_manage() THEN
      RAISE EXCEPTION 'SCN owner account cannot authorise production displays.';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.user_stations WHERE user_id=v_staff AND station_id=v_station) THEN
      RAISE EXCEPTION 'Violet needs her real Hot Kitchen station assignment before this test.';
    END IF;
    INSERT INTO public.pos_shifts(id,organization_id,branch_id,cashier_id,status,opening_float)
      VALUES(v_shift,v_org,v_branch,v_supervisor,'open',0);
    INSERT INTO public.pos_orders(id,organization_id,branch_id,order_number,order_type,order_source,status,
      shift_id,created_by,waiter_id,guest_name)
      VALUES(v_order,v_org,v_branch,'UAT-DISPLAY-'||substr(v_order::text,1,8),'takeaway','waiter-pos','draft',
        v_shift,v_supervisor,v_supervisor,'ROLLBACK ONLY display fixture');
    INSERT INTO public.pos_order_items(id,organization_id,order_id,station_id,item_name,quantity,unit_price,line_total,status,created_by)
      VALUES(v_item,v_org,v_order,v_station,'UAT display workflow only — no menu or stock',1,0,0,'sent',v_supervisor);
    INSERT INTO public.station_tickets(id,organization_id,branch_id,order_id,station_id,ticket_number,status,created_by)
      VALUES(v_ticket,v_org,v_branch,v_order,v_station,'UAT-KDS-'||substr(v_ticket::text,1,8),'new',v_supervisor);
    INSERT INTO public.station_ticket_items(organization_id,ticket_id,order_item_id,status)
      VALUES(v_org,v_ticket,v_item,'new');
    INSERT INTO public.station_tickets(id,organization_id,branch_id,order_id,station_id,ticket_number,status,created_by)
      VALUES(v_other_ticket,v_org,v_branch,v_order,v_other_station,'UAT-KDS-'||substr(v_other_ticket::text,1,8),'new',v_supervisor);

    v_stage:='Pairing rejects a station from another property';
    v_blocked:=false;
    BEGIN
      PERFORM public.neo_production_display_pair(v_branch,
        ARRAY[v_station,'86c24e56-a49b-5c74-9ea5-0488850ff00e'::uuid],'UAT invalid mixed-property display',false);
    EXCEPTION WHEN insufficient_privilege THEN v_blocked:=true; END;
    IF NOT v_blocked THEN RAISE EXCEPTION 'Mixed-property station pairing was accepted.'; END IF;
    INSERT INTO production_display_results VALUES(v_stage,'PASS','{}');

    v_stage:='Personal staff code and PIN enrolment';
    PERFORM public.neo_production_context(v_staff);
    v_result:=public.neo_production_staff_pin('816294',false);
    v_code:=v_result->>'staff_code';
    IF coalesce(v_code,'')='' OR NOT (v_result->>'pin_set')::boolean
      OR v_result ? 'pin_hash' OR v_result ? 'pin' THEN RAISE EXCEPTION 'PIN enrolment returned an invalid result.'; END IF;
    INSERT INTO production_display_results VALUES(v_stage,'PASS',jsonb_build_object('staff','Violet Kariuki','code_assigned',true,'secret_returned',false));

    v_stage:='Supervisor pairs only permitted stations';
    PERFORM public.neo_production_context(v_supervisor);
    v_result:=public.neo_production_display_pair(v_branch,ARRAY[v_station],'UAT Hot Kitchen rollback display',false);
    v_token:=v_result->>'token'; v_session:=(v_result->>'session_id')::uuid;
    v_result:=public.neo_production_display_pair(v_branch,ARRAY[v_station],'UAT read-only rollback overview',true);
    v_ro_token:=v_result->>'token'; v_ro_session:=(v_result->>'session_id')::uuid;
    IF length(v_token)<>64 OR NOT EXISTS(SELECT 1 FROM public.neo_production_display_sessions
      WHERE id=v_session AND station_ids=ARRAY[v_station] AND token_hash<>v_token) THEN
      RAISE EXCEPTION 'Display token or station scope was not saved correctly.';
    END IF;
    INSERT INTO production_display_results VALUES(v_stage,'PASS',jsonb_build_object('token_hashed',true,'stations',1));

    -- Simulate the request claims after normal browser sign-out. Privilege
    -- grants are verified separately below; this is not a UI/RLS certification.
    PERFORM set_config('request.jwt.claims','{"role":"anon"}',true);
    PERFORM set_config('request.jwt.claim.sub','',true);
    PERFORM set_config('request.jwt.claim.role','anon',true);
    PERFORM public.neo_access_cache_bump();

    v_stage:='Restricted display works after supervisor sign-out';
    v_read:=public.neo_production_display_read(v_token);
    IF jsonb_array_length(v_read->'stations')<>1
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_read->'tickets') q WHERE q->>'ticket_id'=v_ticket::text)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_read->'tickets') q WHERE q->>'station_id'<>v_station::text)
      OR auth.uid() IS NOT NULL OR current_setting('request.jwt.claim.role',true)<>'anon' THEN
      RAISE EXCEPTION 'Display read widened scope or left supervisor identity behind.';
    END IF;
    INSERT INTO production_display_results VALUES(v_stage,'PASS',jsonb_build_object('caller_restored','anon','station_scope_preserved',true));

    v_stage:='Wrong PIN cannot claim a ticket';
    v_result:=public.neo_production_display_act(v_token,v_code,'000000',v_ticket,'accepted','new',gen_random_uuid());
    IF coalesce((v_result->>'ok')::boolean,true) OR (SELECT status FROM public.station_tickets WHERE id=v_ticket)<>'new'
      OR (SELECT failed_attempts FROM public.neo_production_staff_codes WHERE organization_id=v_org AND user_id=v_staff)<>1 THEN
      RAISE EXCEPTION 'Wrong PIN changed work or the failed-attempt counter did not persist.';
    END IF;
    INSERT INTO production_display_results VALUES(v_stage,'PASS',jsonb_build_object('failed_attempts',1,'ticket_unchanged',true));

    v_stage:='Staff action records independent actor and supervisor';
    v_result:=public.neo_production_display_act(v_token,v_code,'816294',v_ticket,'accepted','new',v_key);
    IF NOT coalesce((v_result->>'ok')::boolean,false) THEN RAISE EXCEPTION 'Accept refused: %',v_result; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.neo_production_display_actions WHERE session_id=v_session
      AND request_id=v_key AND actor_id=v_staff AND supervisor_id=v_supervisor)
      OR NOT EXISTS(SELECT 1 FROM public.station_ticket_status_history WHERE ticket_id=v_ticket
        AND to_status='accepted' AND changed_by=v_staff)
      OR NOT EXISTS(SELECT 1 FROM public.station_ticket_items WHERE ticket_id=v_ticket AND chef_id=v_staff AND status='accepted')
      OR auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'Actor attribution or request identity restoration failed.'; END IF;
    SELECT accepted_at INTO v_accepted FROM public.station_tickets WHERE id=v_ticket;
    IF v_accepted IS NULL THEN RAISE EXCEPTION 'Accepted timestamp was not recorded.'; END IF;
    INSERT INTO production_display_results VALUES(v_stage,'PASS',jsonb_build_object('actor','Violet Kariuki','supervisor','Mr Saitoti','accepted_at',v_accepted));

    v_stage:='Retry records one action and one acceptance';
    SELECT count(*) INTO v_before FROM public.station_ticket_status_history WHERE ticket_id=v_ticket;
    v_result:=public.neo_production_display_act(v_token,v_code,'816294',v_ticket,'accepted','new',v_key);
    IF NOT coalesce((v_result->>'idempotent')::boolean,false)
      OR (SELECT count(*) FROM public.neo_production_display_actions WHERE session_id=v_session AND request_id=v_key)<>1
      OR (SELECT count(*) FROM public.station_ticket_status_history WHERE ticket_id=v_ticket)<>v_before
      OR (SELECT accepted_at FROM public.station_tickets WHERE id=v_ticket) IS DISTINCT FROM v_accepted THEN
      RAISE EXCEPTION 'Retry duplicated an action or changed acceptance.';
    END IF;
    INSERT INTO production_display_results VALUES(v_stage,'PASS',jsonb_build_object('actions',1,'history_unchanged',true));

    v_stage:='Stale simultaneous claim is refused';
    v_result:=public.neo_production_display_act(v_token,v_code,'816294',v_ticket,'accepted','new',gen_random_uuid());
    IF coalesce((v_result->>'ok')::boolean,true) OR (SELECT status FROM public.station_tickets WHERE id=v_ticket)<>'accepted' THEN
      RAISE EXCEPTION 'A stale claim was not refused.';
    END IF;
    INSERT INTO production_display_results VALUES(v_stage,'PASS','{}');

    v_stage:='Screen token cannot act at another station';
    v_result:=public.neo_production_display_act(v_token,v_code,'816294',v_other_ticket,'accepted','new',gen_random_uuid());
    IF coalesce((v_result->>'ok')::boolean,true) OR (SELECT status FROM public.station_tickets WHERE id=v_other_ticket)<>'new' THEN
      RAISE EXCEPTION 'An unpaired station was changed.';
    END IF;
    INSERT INTO production_display_results VALUES(v_stage,'PASS','{}');

    v_stage:='Read-only overview cannot perform actions';
    v_result:=public.neo_production_display_act(v_ro_token,v_code,'816294',v_ticket,'preparing','accepted',gen_random_uuid());
    IF coalesce((v_result->>'ok')::boolean,true) OR (SELECT status FROM public.station_tickets WHERE id=v_ticket)<>'accepted' THEN
      RAISE EXCEPTION 'A read-only overview changed work.';
    END IF;
    INSERT INTO production_display_results VALUES(v_stage,'PASS','{}');

    v_stage:='Staff prepares and marks ready through canonical transitions';
    v_result:=public.neo_production_display_act(v_token,v_code,'816294',v_ticket,'preparing','accepted',gen_random_uuid());
    IF NOT coalesce((v_result->>'ok')::boolean,false) THEN RAISE EXCEPTION 'Preparing refused: %',v_result; END IF;
    v_result:=public.neo_production_display_act(v_token,v_code,'816294',v_ticket,'delay','preparing',gen_random_uuid(),'UAT delay reason');
    IF NOT coalesce((v_result->>'ok')::boolean,false) THEN RAISE EXCEPTION 'Delay refused: %',v_result; END IF;
    v_result:=public.neo_production_display_act(v_token,v_code,'816294',v_ticket,'ready','preparing',gen_random_uuid());
    IF NOT coalesce((v_result->>'ok')::boolean,false) THEN RAISE EXCEPTION 'Ready refused: %',v_result; END IF;
    IF (SELECT status FROM public.pos_order_items WHERE id=v_item)<>'ready'
      OR (SELECT status FROM public.station_tickets WHERE id=v_ticket)<>'ready'
      OR EXISTS(SELECT 1 FROM public.station_ticket_status_history WHERE ticket_id=v_ticket AND changed_by IS DISTINCT FROM v_staff)
      THEN RAISE EXCEPTION 'Canonical production status or actor history disagrees.'; END IF;
    INSERT INTO production_display_results VALUES(v_stage,'PASS',jsonb_build_object('ticket_status','ready','order_item_status','ready'));

    v_stage:='PIN lockout persists after five failed attempts';
    FOR v_n IN 1..5 LOOP
      v_result:=public.neo_production_display_act(v_token,v_code,'000000',v_ticket,'ready','ready',gen_random_uuid());
    END LOOP;
    IF NOT EXISTS(SELECT 1 FROM public.neo_production_staff_codes WHERE organization_id=v_org AND user_id=v_staff
      AND failed_attempts>=5 AND blocked_until>now()) THEN RAISE EXCEPTION 'PIN lockout was rolled back or not applied.'; END IF;
    v_result:=public.neo_production_display_act(v_token,v_code,'816294',v_ticket,'ready','ready',gen_random_uuid());
    IF v_result->>'reason'<>'credentials' THEN RAISE EXCEPTION 'Locked credential accepted a correct PIN before reset.'; END IF;
    INSERT INTO production_display_results VALUES(v_stage,'PASS',jsonb_build_object('failed_attempts',5,'locked',true));

    v_stage:='PIN reset clears lockout without returning secrets';
    PERFORM public.neo_production_context(v_staff);
    v_result:=public.neo_production_staff_pin('816294',false);
    IF NOT EXISTS(SELECT 1 FROM public.neo_production_staff_codes WHERE organization_id=v_org AND user_id=v_staff
      AND failed_attempts=0 AND blocked_until IS NULL) OR v_result ? 'pin_hash' THEN RAISE EXCEPTION 'PIN reset failed.'; END IF;
    INSERT INTO production_display_results VALUES(v_stage,'PASS','{}');

    v_stage:='Expired and unpaired tokens cannot read tickets';
    UPDATE public.neo_production_display_sessions SET expires_at=now()-interval '1 second' WHERE id=v_ro_session;
    v_blocked:=false;
    BEGIN PERFORM public.neo_production_display_read(v_ro_token);
    EXCEPTION WHEN insufficient_privilege THEN v_blocked:=true; END;
    IF NOT v_blocked THEN RAISE EXCEPTION 'Expired display still returned tickets.'; END IF;
    v_blocked:=false;
    BEGIN PERFORM public.neo_production_display_read('not-a-paired-token');
    EXCEPTION WHEN insufficient_privilege THEN v_blocked:=true; END;
    IF NOT v_blocked THEN RAISE EXCEPTION 'An unpaired token returned tickets.'; END IF;
    INSERT INTO production_display_results VALUES(v_stage,'PASS',jsonb_build_object('expired_rejected',true,'unpaired_rejected',true));

    v_stage:='Supervisor revocation immediately stops the screen';
    PERFORM public.neo_production_context(v_supervisor);
    PERFORM public.neo_production_display_manage(v_session);
    PERFORM set_config('request.jwt.claims','{"role":"anon"}',true);
    PERFORM set_config('request.jwt.claim.sub','',true);
    PERFORM set_config('request.jwt.claim.role','anon',true);
    PERFORM public.neo_access_cache_bump();
    v_blocked:=false;
    BEGIN PERFORM public.neo_production_display_read(v_token);
    EXCEPTION WHEN insufficient_privilege THEN v_blocked:=true; END;
    IF NOT v_blocked THEN RAISE EXCEPTION 'Revoked display still returned tickets.'; END IF;
    INSERT INTO production_display_results VALUES(v_stage,'PASS','{}');

    v_stage:='Anonymous role cannot read credentials or delegate identities';
    IF has_table_privilege('anon','public.neo_production_staff_codes','SELECT')
      OR has_table_privilege('authenticated','public.neo_production_staff_codes','SELECT')
      OR has_table_privilege('anon','public.neo_production_display_sessions','SELECT')
      OR has_function_privilege('anon','public.neo_production_context(uuid)','EXECUTE')
      OR has_function_privilege('authenticated','public.neo_production_context(uuid)','EXECUTE')
      OR has_function_privilege('anon','public.neo_production_require_session(text)','EXECUTE')
      OR has_function_privilege('anon','public.neo_production_display_pair(uuid,uuid[],text,boolean)','EXECUTE')
      OR NOT has_function_privilege('anon','public.neo_production_display_read(text)','EXECUTE')
      OR NOT has_function_privilege('anon','public.neo_production_display_act(text,text,text,uuid,text,text,uuid,text)','EXECUTE')
      THEN RAISE EXCEPTION 'Shared-display API/table privilege boundary failed.'; END IF;
    INSERT INTO production_display_results VALUES(v_stage,'PASS',jsonb_build_object('credential_tables_private',true,'delegation_helper_private',true));

  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error=MESSAGE_TEXT,v_context=PG_EXCEPTION_CONTEXT;
    INSERT INTO production_display_results VALUES(v_stage,'FAIL',jsonb_build_object('error',v_error,'context',v_context));
  END;
END $tests$;
SELECT check_name,result,detail FROM production_display_results ORDER BY check_name;
ROLLBACK;
