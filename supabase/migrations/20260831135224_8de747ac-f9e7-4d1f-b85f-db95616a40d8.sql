CREATE OR REPLACE FUNCTION public.neo_night_audit_run(_branch uuid, _date date DEFAULT NULL::date, _mode text DEFAULT 'manual'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE org uuid:=public.current_org_id(); d date:=coalesce(_date,current_date); rid uuid; ref text; attempt int; started timestamptz:=now(); blockers int:=0; warnings int:=0; counts jsonb:='{}'; snapshot jsonb:='[]'; summary jsonb; digest text; operator text; err text; outcome text; posting jsonb:='{}'::jsonb; may_post boolean;
BEGIN
 IF org IS NULL THEN RAISE EXCEPTION 'No workspace context'; END IF;
 IF NOT(public.has_permission('finance','eod','view') OR public.is_org_admin()) THEN RAISE EXCEPTION 'Forbidden'; END IF;
 IF _branch IS NULL OR NOT EXISTS(SELECT 1 FROM public.branches b WHERE b.id=_branch AND b.organization_id=org) THEN RAISE EXCEPTION 'Unknown property'; END IF;
 SELECT coalesce(p.full_name,p.email) INTO operator FROM public.profiles p WHERE p.id=auth.uid();
 INSERT INTO public.night_audit_runs(organization_id,branch_id,business_date,run_mode,created_by,started_at,operator_name,run_reference,status,stage,rerun_count)
 VALUES(org,_branch,d,coalesce(_mode,'manual'),auth.uid(),started,operator,public.neo_night_audit_reference(org,_branch,d),'running','collecting',0)
 ON CONFLICT(organization_id,branch_id,business_date) DO UPDATE SET run_mode=excluded.run_mode,created_by=auth.uid(),started_at=started,completed_at=NULL,operator_name=excluded.operator_name,status='running',stage='collecting',rerun_count=public.night_audit_runs.rerun_count+1
 RETURNING id,run_reference,rerun_count+1 INTO rid,ref,attempt;
 INSERT INTO public.night_audit_attempts(run_id,organization_id,branch_id,business_date,attempt_number,stage,status,started_at,actor_id) VALUES(rid,org,_branch,d,attempt,'collecting','running',started,auth.uid());
 BEGIN
  -- The audit is not a report on unposted money: it first hands every eligible
  -- deposit, settlement and room charge to Finance so the journals exist, then
  -- reports only what genuinely could not post.
  may_post := public.is_org_admin() OR public.has_permission('finance','edit') OR public.has_permission('finance','approve');
  IF may_post THEN
    UPDATE public.night_audit_runs SET stage='posting' WHERE id=rid;
    UPDATE public.night_audit_attempts SET stage='posting' WHERE run_id=rid AND attempt_number=attempt;
    posting := public.neo_finance_post_eligible(_branch, d, d, NULL, 200);
    UPDATE public.night_audit_runs SET stage='collecting' WHERE id=rid;
    UPDATE public.night_audit_attempts SET stage='collecting' WHERE run_id=rid AND attempt_number=attempt;
  ELSE
    posting := jsonb_build_object('skipped','no finance posting authority');
  END IF;

  DELETE FROM public.night_audit_exceptions WHERE run_id=rid;
  INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount)
  SELECT rid,org,_branch,d,'finance-posting','blocking',e.reference,coalesce(e.detail,e.reason),e.amount FROM public.neo_finance_exception_register(_branch,d,d)e;
  INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount)
  SELECT rid,org,_branch,d,'finance-posting','blocking',q.reference,q.required_action,q.amount FROM public.neo_finance_posting_queue(_branch,d,d)q WHERE q.eligible;
  INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount)
  SELECT rid,org,_branch,d,'approval','warning',coalesce(nullif(a.reference,''),a.id::text),'Controlled transaction is still awaiting approval.',a.amount FROM public.approval_requests a WHERE a.organization_id=org AND a.branch_id=_branch AND a.created_at::date<=d AND public.neo_approval_normalize_status(a.status)='pending';
  SELECT count(*) FILTER(WHERE severity='blocking'),count(*) FILTER(WHERE severity='warning'),coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.created_at),'[]'::jsonb) INTO blockers,warnings,snapshot FROM public.night_audit_exceptions e WHERE e.run_id=rid;
  SELECT coalesce(jsonb_object_agg(source_module,c),'{}'::jsonb) INTO counts FROM(SELECT source_module,count(*) c FROM public.canonical_transaction_states WHERE organization_id=org AND branch_id=_branch AND occurred_at::date=d GROUP BY source_module)x;
  summary:=jsonb_build_object('reference',ref,'operator',operator,'started_at',started,'finished_at',now(),'source_counts',counts,'posting',posting,'blocking',blockers,'warnings',warnings,'outcome',CASE WHEN blockers>0 THEN 'exception' ELSE 'completed' END);
  digest:=encode(digest(convert_to(summary::text,'UTF8'),'sha256'),'hex');
  UPDATE public.night_audit_runs SET blocking_count=blockers,warning_count=warnings,status=CASE WHEN blockers>0 THEN 'exception' ELSE 'completed' END,stage='signed',completed_at=now(),source_counts=counts,exception_snapshot=snapshot,summary=summary,result_digest=digest,signed_at=now() WHERE id=rid;
  UPDATE public.night_audit_attempts SET stage='signed',status=CASE WHEN blockers>0 THEN 'exception' ELSE 'completed' END,source_counts=counts,exception_snapshot=snapshot,result_digest=digest,completed_at=now() WHERE run_id=rid AND attempt_number=attempt;
 EXCEPTION WHEN OTHERS THEN
  err:=SQLERRM; blockers:=1;
  UPDATE public.night_audit_runs SET blocking_count=1,status='failed',stage='failed',completed_at=now(),summary=jsonb_build_object('reference',ref,'failed_stage','collecting','error',err),result_digest=NULL,signed_at=NULL WHERE id=rid;
  UPDATE public.night_audit_attempts SET stage='failed',status='failed',error=err,completed_at=now() WHERE run_id=rid AND attempt_number=attempt;
 END;

 outcome := CASE WHEN err IS NOT NULL THEN 'failed' WHEN blockers>0 THEN 'exception' ELSE 'completed' END;

 PERFORM public.emit_domain_event(org,_branch,'night_audit.'||outcome,'finance',rid,
   jsonb_build_object('reference',ref,'business_date',d,'attempt',attempt,'blocking',blockers,'warnings',warnings,'posting',posting,'digest',digest,'error',err),
   'night_audit:'||rid::text||':'||attempt::text);

 PERFORM public.neo_canonical_transaction_set(
   _org := org, _branch := _branch, _module := 'finance', _source := rid,
   _reference := ref, _operational := outcome,
   _financial := CASE WHEN outcome='completed' THEN 'posted' ELSE 'blocked' END,
   _amount := 0, _currency := 'KES',
   _idempotency := 'night_audit:'||rid::text, _actor := auth.uid(),
   _owner := 'Finance',
   _next_action := CASE WHEN outcome='completed' THEN 'Close the business day' ELSE 'Clear blocking exceptions and rerun' END,
   _blocker := CASE WHEN outcome='completed' THEN NULL ELSE coalesce(err, blockers||' blocking exception(s)') END,
   _journal := NULL, _receipt := NULL,
   _downstream := jsonb_build_object('night_audit.close_day', outcome),
   _metadata := jsonb_build_object('entity_kind','night_audit','business_date',d,'attempt',attempt,'source_counts',counts,'posting',posting));

 RETURN jsonb_build_object('run_id',rid,'reference',ref,'business_date',d,'blocking',blockers,'warnings',warnings,'status',outcome,'stage',CASE WHEN err IS NOT NULL THEN 'failed' ELSE 'signed' END,'digest',digest,'posting',posting,'error',err);
END $function$;

REVOKE EXECUTE ON FUNCTION public.neo_night_audit_run(uuid, date, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.neo_night_audit_run(uuid, date, text) TO authenticated;