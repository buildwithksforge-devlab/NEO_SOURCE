-- Local discovery runs on a trusted property computer, not in the cloud.
-- No role grants, printer installation or operational job changes occur here.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $neo_print_guard$
BEGIN
 IF replace((SELECT prosrc FROM pg_proc WHERE oid='public.neo_print_agent_printers(text)'::regprocedure),E'\r\n',E'\n') IS DISTINCT FROM replace($neo_expected$
DECLARE
  v_agent public.neo_print_agents;
  v_result jsonb;
BEGIN
  SELECT *
  INTO v_agent
  FROM public.neo_print_agents
  WHERE token_hash = lower(coalesce(_token_hash, ''))
    AND active;

  IF v_agent.id IS NULL THEN
    RAISE EXCEPTION 'invalid_print_agent_token'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.neo_print_agents
  SET
    last_seen_at = now(),
    updated_at = now()
  WHERE id = v_agent.id;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'name', p.name,
        'branch_id', p.branch_id,
        'department_id', p.department_id,
        'station_id', p.station_id,
        'printer_role', p.printer_role,
        'connection_type', p.connection_type,
        'address', p.address,
        'health_status', p.health_status,
        'active', p.active
      )
      ORDER BY p.name, p.id
    ),
    '[]'::jsonb
  )
  INTO v_result
  FROM public.printer_profiles p
  WHERE p.organization_id = v_agent.organization_id
    AND p.active
    AND (
      v_agent.branch_id IS NULL
      OR p.branch_id = v_agent.branch_id
    );

  RETURN v_result;
END;
$neo_expected$,E'\r\n',E'\n') THEN
  RAISE EXCEPTION 'Printer backend differs from reviewed physical-agent source; inspect deployment before applying';
 END IF;
 IF replace((SELECT prosrc FROM pg_proc WHERE oid='public.neo_print_agent_claim(text,uuid)'::regprocedure),E'\r\n',E'\n') IS DISTINCT FROM replace($neo_expected$
DECLARE
  v_agent public.neo_print_agents;
  v_printer public.printer_profiles;
  v_job public.print_jobs;
  v_claim uuid;
BEGIN
  SELECT *
  INTO v_agent
  FROM public.neo_print_agents
  WHERE token_hash = lower(coalesce(_token_hash, ''))
    AND active;

  IF v_agent.id IS NULL THEN
    RAISE EXCEPTION 'invalid_print_agent_token'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO v_printer
  FROM public.printer_profiles
  WHERE id = _printer
    AND organization_id = v_agent.organization_id
    AND active
    AND (
      v_agent.branch_id IS NULL
      OR branch_id = v_agent.branch_id
    );

  IF v_printer.id IS NULL THEN
    RAISE EXCEPTION 'printer_not_available_to_agent'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.neo_print_agents
  SET
    last_seen_at = now(),
    updated_at = now()
  WHERE id = v_agent.id;

  UPDATE public.print_jobs
  SET
    status = 'failed',
    last_error =
      'Print-agent claim expired; physical outcome is unknown. Review before retrying.',
    claim_id = NULL,
    claimed_by_agent_id = NULL,
    claimed_at = NULL,
    claim_expires_at = NULL,
    updated_at = now()
  WHERE printer_id = _printer
    AND organization_id = v_agent.organization_id
    AND status = 'printing'
    AND claim_expires_at < now();

  SELECT j.*
  INTO v_job
  FROM public.print_jobs j
  WHERE j.printer_id = _printer
    AND j.organization_id = v_agent.organization_id
    AND j.branch_id = v_printer.branch_id
    AND j.status = 'queued'
    AND j.next_attempt_at <= now()
  ORDER BY
    j.next_attempt_at,
    j.created_at,
    j.id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_job.id IS NULL THEN
    RETURN NULL;
  END IF;

  v_claim := gen_random_uuid();

  UPDATE public.print_jobs
  SET
    status = 'printing',
    claim_id = v_claim,
    claimed_by_agent_id = v_agent.id,
    claimed_at = now(),
    claim_expires_at = now() + interval '2 minutes',
    updated_at = now()
  WHERE id = v_job.id;

  RETURN jsonb_build_object(
    'job_id', v_job.id,
    'claim_id', v_claim,
    'document_type', v_job.document_type,
    'title', v_job.title,
    'payload', v_job.payload,
    'attempt', coalesce(v_job.attempts, 0) + 1,
    'max_attempts', v_job.max_attempts,
    'printer',
      jsonb_build_object(
        'id', v_printer.id,
        'name', v_printer.name,
        'connection_type', v_printer.connection_type,
        'address', v_printer.address
      )
  );
END;
$neo_expected$,E'\r\n',E'\n') THEN
  RAISE EXCEPTION 'Printer backend differs from reviewed physical-agent source; inspect deployment before applying';
 END IF;
 IF replace((SELECT prosrc FROM pg_proc WHERE oid='public.neo_print_agent_finish(text,uuid,uuid,text,text)'::regprocedure),E'\r\n',E'\n') IS DISTINCT FROM replace($neo_expected$
DECLARE
  v_agent public.neo_print_agents;
  v_job public.print_jobs;
  v_printer public.printer_profiles;
  v_fallback public.printer_profiles;
  v_status text;
  v_failed_over boolean := false;
  v_backoff integer;
BEGIN
  SELECT *
  INTO v_agent
  FROM public.neo_print_agents
  WHERE token_hash = lower(coalesce(_token_hash, ''))
    AND active;

  IF v_agent.id IS NULL THEN
    RAISE EXCEPTION 'invalid_print_agent_token'
      USING ERRCODE = '42501';
  END IF;

  IF _outcome NOT IN (
    'completed',
    'not_printed',
    'outcome_unknown'
  ) THEN
    RAISE EXCEPTION 'invalid_print_outcome'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_job
  FROM public.print_jobs
  WHERE id = _job
  FOR UPDATE;

  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'print_job_not_found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_job.organization_id <> v_agent.organization_id
     OR v_job.claimed_by_agent_id <> v_agent.id
     OR v_job.claim_id <> _claim
     OR v_job.status <> 'printing' THEN
    RAISE EXCEPTION 'invalid_or_stale_print_claim'
      USING ERRCODE = '40001';
  END IF;

  SELECT *
  INTO v_printer
  FROM public.printer_profiles
  WHERE id = v_job.printer_id;

  IF _outcome = 'completed' THEN
    UPDATE public.print_jobs
    SET
      status = 'completed',
      attempts = attempts + 1,
      completed_at = now(),
      last_error = NULL,
      claim_id = NULL,
      claimed_by_agent_id = NULL,
      claimed_at = NULL,
      claim_expires_at = NULL,
      updated_at = now()
    WHERE id = v_job.id;

    UPDATE public.printer_profiles
    SET
      status = 'connected',
      health_status = 'online',
      last_success_at = now(),
      last_checked_at = now(),
      last_error = NULL,
      updated_at = now()
    WHERE id = v_job.printer_id;

    RETURN jsonb_build_object(
      'status', 'completed',
      'failed_over', false
    );
  END IF;

  UPDATE public.printer_profiles
  SET
    health_status = 'error',
    last_failure_at = now(),
    last_checked_at = now(),
    last_error = left(
      coalesce(
        nullif(btrim(_error), ''),
        replace(_outcome, '_', ' ')
      ),
      1000
    ),
    updated_at = now()
  WHERE id = v_job.printer_id;

  IF _outcome = 'outcome_unknown' THEN
    UPDATE public.print_jobs
    SET
      status = 'failed',
      attempts = attempts + 1,
      last_error =
        'Physical outcome unknown. Review before manually retrying. '
        || left(coalesce(_error, ''), 800),
      claim_id = NULL,
      claimed_by_agent_id = NULL,
      claimed_at = NULL,
      claim_expires_at = NULL,
      updated_at = now()
    WHERE id = v_job.id;

    RETURN jsonb_build_object(
      'status', 'failed',
      'failed_over', false,
      'outcome_unknown', true
    );
  END IF;

  v_backoff :=
    greatest(
      1,
      coalesce(v_printer.retry_backoff_seconds, 30)
    );

  IF v_job.attempts + 1 < v_job.max_attempts THEN
    v_status := 'queued';

    UPDATE public.print_jobs
    SET
      status = 'queued',
      attempts = attempts + 1,
      last_error = left(
        coalesce(_error, 'Printer reported not printed'),
        1000
      ),
      next_attempt_at =
        now() + make_interval(secs => v_backoff),
      claim_id = NULL,
      claimed_by_agent_id = NULL,
      claimed_at = NULL,
      claim_expires_at = NULL,
      updated_at = now()
    WHERE id = v_job.id;

  ELSE
    SELECT fp.*
    INTO v_fallback
    FROM public.printer_profiles fp
    WHERE fp.id = v_printer.fallback_printer_id
      AND fp.active
      AND fp.organization_id =
          v_printer.organization_id
      AND fp.branch_id
          IS NOT DISTINCT FROM v_printer.branch_id
      AND fp.department_id
          IS NOT DISTINCT FROM v_printer.department_id
      AND fp.station_id
          IS NOT DISTINCT FROM v_printer.station_id
      AND fp.printer_role
          IS NOT DISTINCT FROM v_printer.printer_role;

    IF v_fallback.id IS NOT NULL
       AND NOT v_job.failed_over THEN
      v_status := 'queued';
      v_failed_over := true;

      UPDATE public.print_jobs
      SET
        status = 'queued',
        printer_id = v_fallback.id,
        attempts = 0,
        failed_over = true,
        last_error = left(
          coalesce(
            _error,
            'Primary printer reported not printed'
          ),
          1000
        ),
        next_attempt_at = now(),
        claim_id = NULL,
        claimed_by_agent_id = NULL,
        claimed_at = NULL,
        claim_expires_at = NULL,
        updated_at = now()
      WHERE id = v_job.id;
    ELSE
      v_status := 'failed';

      UPDATE public.print_jobs
      SET
        status = 'failed',
        attempts = attempts + 1,
        last_error = left(
          coalesce(
            _error,
            'Printer reported not printed'
          ),
          1000
        ),
        claim_id = NULL,
        claimed_by_agent_id = NULL,
        claimed_at = NULL,
        claim_expires_at = NULL,
        updated_at = now()
      WHERE id = v_job.id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', v_status,
    'failed_over', v_failed_over
  );
END;
$neo_expected$,E'\r\n',E'\n') THEN
  RAISE EXCEPTION 'Printer backend differs from reviewed physical-agent source; inspect deployment before applying';
 END IF;
END
$neo_print_guard$;
ALTER TABLE public.neo_print_agents
 ADD COLUMN IF NOT EXISTS discovery_request_id uuid,
 ADD COLUMN IF NOT EXISTS discovery_kind text,
 ADD COLUMN IF NOT EXISTS discovery_requested_at timestamptz,
 ADD COLUMN IF NOT EXISTS discovery_reported_request_id uuid,
 ADD COLUMN IF NOT EXISTS discovery_reported_at timestamptz,
 ADD COLUMN IF NOT EXISTS discovery_result jsonb;

CREATE OR REPLACE FUNCTION public.neo_print_discovery_authorize(_agent uuid)
RETURNS public.neo_print_agents LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $function$
DECLARE v_row public.neo_print_agents; v_org uuid:=public.current_org_id();
BEGIN
 IF auth.uid() IS NULL OR v_org IS NULL OR NOT (
  public.is_org_admin_for(v_org) OR public.has_permission('integrations','edit')
  OR public.has_permission('pos','settings.manage')) THEN
  RAISE EXCEPTION 'Printer configuration permission required' USING ERRCODE='42501';
 END IF;
 SELECT * INTO v_row FROM public.neo_print_agents WHERE id=_agent AND organization_id=v_org AND active;
 IF v_row.id IS NULL OR v_row.branch_id IS NULL OR NOT public.neo_branch_in_scope(v_row.branch_id) THEN
  RAISE EXCEPTION 'Print agent outside authorised property' USING ERRCODE='42501';
 END IF;
 RETURN v_row;
END
$function$;

CREATE OR REPLACE FUNCTION public.neo_print_discovery_request(_agent uuid,_kind text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $function$
DECLARE v_row public.neo_print_agents; v_id uuid;
BEGIN
 v_row:=public.neo_print_discovery_authorize(_agent);
 IF _kind IS NULL OR _kind NOT IN ('network','windows','usb','bluetooth') THEN RAISE EXCEPTION 'Unsupported discovery kind'; END IF;
 SELECT * INTO v_row FROM public.neo_print_agents WHERE id=_agent FOR UPDATE;
 IF v_row.discovery_request_id IS NOT NULL
  AND v_row.discovery_reported_request_id IS DISTINCT FROM v_row.discovery_request_id
  AND v_row.discovery_requested_at>now()-interval '2 minutes' THEN
  IF v_row.discovery_kind<>_kind THEN RAISE EXCEPTION 'Wait for the current printer search to finish'; END IF;
  RETURN jsonb_build_object('ok',true,'request_id',v_row.discovery_request_id,'requested_at',v_row.discovery_requested_at);
 END IF;
 IF v_row.discovery_requested_at>now()-interval '10 seconds' THEN RAISE EXCEPTION 'Wait ten seconds before searching again'; END IF;
 v_id:=gen_random_uuid();
 UPDATE public.neo_print_agents SET discovery_request_id=v_id,discovery_kind=_kind,
  discovery_requested_at=now(),discovery_result=NULL WHERE id=_agent;
 RETURN jsonb_build_object('ok',true,'request_id',v_id,'requested_at',now());
END
$function$;

CREATE OR REPLACE FUNCTION public.neo_print_discovery_status(_agent uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $function$
DECLARE v_row public.neo_print_agents;
BEGIN
 v_row:=public.neo_print_discovery_authorize(_agent);
 RETURN jsonb_build_object('agent_id',v_row.id,'branch_id',v_row.branch_id,'last_seen_at',v_row.last_seen_at,
  'request_id',v_row.discovery_request_id,'kind',v_row.discovery_kind,'requested_at',v_row.discovery_requested_at,
  'reported_request_id',v_row.discovery_reported_request_id,'reported_at',v_row.discovery_reported_at,
  'result',CASE WHEN v_row.discovery_reported_request_id=v_row.discovery_request_id THEN v_row.discovery_result ELSE NULL END);
END
$function$;

CREATE OR REPLACE FUNCTION public.neo_print_agent_discovery_poll(_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $function$
DECLARE v_row public.neo_print_agents;
BEGIN
 SELECT * INTO v_row FROM public.neo_print_agents WHERE token_hash=lower(coalesce(_token_hash,'')) AND active;
 IF v_row.id IS NULL OR v_row.branch_id IS NULL THEN RAISE EXCEPTION 'invalid_print_agent_token' USING ERRCODE='42501'; END IF;
 UPDATE public.neo_print_agents SET last_seen_at=now() WHERE id=v_row.id;
 IF v_row.discovery_request_id IS NULL OR v_row.discovery_reported_request_id=v_row.discovery_request_id
  OR v_row.discovery_requested_at<now()-interval '2 minutes' THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('request_id',v_row.discovery_request_id,'kind',v_row.discovery_kind);
END
$function$;

CREATE OR REPLACE FUNCTION public.neo_print_agent_discovery_report(_token_hash text,_request uuid,_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $function$
DECLARE v_row public.neo_print_agents; v_item jsonb;
BEGIN
 SELECT * INTO v_row FROM public.neo_print_agents WHERE token_hash=lower(coalesce(_token_hash,'')) AND active FOR UPDATE;
 IF v_row.id IS NULL OR v_row.branch_id IS NULL THEN RAISE EXCEPTION 'invalid_print_agent_token' USING ERRCODE='42501'; END IF;
 IF _request IS NULL OR _request IS DISTINCT FROM v_row.discovery_request_id
  OR v_row.discovery_requested_at<now()-interval '2 minutes' THEN
  RAISE EXCEPTION 'invalid_or_stale_discovery_request' USING ERRCODE='40001';
 END IF;
 IF _result IS NULL OR jsonb_typeof(_result)<>'object' OR octet_length(_result::text)>64000
  OR jsonb_typeof(_result->'printers') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid printer discovery result'; END IF;
 IF jsonb_array_length(_result->'printers')>100 THEN RAISE EXCEPTION 'Too many discovered printers'; END IF;
 FOR v_item IN SELECT * FROM jsonb_array_elements(_result->'printers') LOOP
  IF jsonb_typeof(v_item)<>'object' OR length(coalesce(v_item->>'name','')) NOT BETWEEN 1 AND 240
   OR length(coalesce(v_item->>'address',''))>500
   OR coalesce(v_item->>'connection_type','') NOT IN ('network','windows','unsupported') THEN
   RAISE EXCEPTION 'Invalid discovered printer';
  END IF;
 END LOOP;
 -- A repeated acknowledgement never replaces the already recorded result.
 IF v_row.discovery_reported_request_id=_request THEN RETURN jsonb_build_object('ok',true,'already_recorded',true); END IF;
 UPDATE public.neo_print_agents SET discovery_reported_request_id=_request,discovery_reported_at=now(),
  discovery_result=_result,last_seen_at=now() WHERE id=v_row.id;
 RETURN jsonb_build_object('ok',true);
END
$function$;
REVOKE ALL ON FUNCTION public.neo_print_discovery_authorize(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.neo_print_discovery_request(uuid,text),public.neo_print_discovery_status(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_print_discovery_request(uuid,text),public.neo_print_discovery_status(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.neo_print_agent_discovery_poll(text),public.neo_print_agent_discovery_report(text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.neo_print_agent_discovery_poll(text),public.neo_print_agent_discovery_report(text,uuid,jsonb) TO service_role;
COMMIT;