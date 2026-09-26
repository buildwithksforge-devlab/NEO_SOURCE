CREATE OR REPLACE FUNCTION public.neo_grn_post_accrual(_receipt uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid;
  r record; pol public.procurement_matching_policies;
  v_value numeric := 0; v_currency text; v_res jsonb; v_journal uuid;
BEGIN
  SELECT * INTO r FROM public.goods_receipts WHERE id = _receipt;
  IF r IS NULL THEN RAISE EXCEPTION 'Receipt not found'; END IF;
  v_org := r.organization_id;
  pol := public.neo_matching_policy(v_org, r.branch_id);

  SELECT COALESCE(sum(
    COALESCE(l.quantity_accepted,
      GREATEST(COALESCE(l.quantity_received,0) - COALESCE(l.quantity_rejected,0)
               - COALESCE(l.quantity_damaged,0) - COALESCE(l.quantity_returned,0), 0))
    * COALESCE(l.unit_price,0)), 0)
    INTO v_value
    FROM public.goods_receipt_lines l WHERE l.receipt_id = _receipt;

  IF round(COALESCE(v_value,0),2) <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'zero_value');
  END IF;

  SELECT COALESCE(po.currency,'KES') INTO v_currency FROM public.purchase_orders po WHERE po.id = r.order_id;
  v_currency := COALESCE(v_currency, 'KES');

  PERFORM public.neo_finance_ensure_account(v_org, pol.inventory_account_code, 'Inventory', 'asset', 'Inventory');
  PERFORM public.neo_finance_ensure_account(v_org, pol.grni_account_code, 'Goods Received Not Invoiced', 'liability', 'Payables');

  v_res := public.neo_gl_post(
    v_org, r.branch_id, 'procurement', 'goods_receipt', _receipt, 'accrual',
    COALESCE(r.received_at::date, CURRENT_DATE), v_currency,
    'Goods received ' || COALESCE(r.grn_number, _receipt::text),
    jsonb_build_array(
      jsonb_build_object('code', pol.inventory_account_code, 'debit', round(v_value,2), 'description','Stock received'),
      jsonb_build_object('code', pol.grni_account_code, 'credit', round(v_value,2), 'description','Goods received not invoiced')
    ));

  v_journal := (v_res->>'journal_id')::uuid;

  UPDATE public.goods_receipts
     SET accrual_journal_id = v_journal,
         accrued_value = round(v_value,2),
         accrual_error = NULL
   WHERE id = _receipt;

  -- Durable handoff: the consequences of an accepted receipt are events on the
  -- outbox, keyed so a retry re-uses the same event instead of posting twice.
  PERFORM public.emit_domain_event(v_org, r.branch_id, 'grn.accepted', 'procurement', _receipt,
    jsonb_build_object('reference', r.grn_number, 'value', round(v_value,2), 'currency', v_currency),
    'grn:' || _receipt::text || ':accepted');
  PERFORM public.emit_domain_event(v_org, r.branch_id, 'inventory.recognised', 'procurement', _receipt,
    jsonb_build_object('reference', r.grn_number, 'value', round(v_value,2), 'currency', v_currency),
    'grn:' || _receipt::text || ':inventory_recognised');
  PERFORM public.emit_domain_event(v_org, r.branch_id, 'finance.posted', 'procurement', _receipt,
    jsonb_build_object('reference', r.grn_number, 'journal_id', v_journal, 'value', round(v_value,2), 'currency', v_currency),
    'grn:' || _receipt::text || ':finance_posted');

  PERFORM public.neo_canonical_transaction_set(
    _org := v_org, _branch := r.branch_id, _module := 'procurement', _source := _receipt,
    _reference := r.grn_number, _operational := 'posted', _financial := 'posted',
    _amount := round(v_value,2), _currency := v_currency,
    _idempotency := 'grn:' || _receipt::text, _actor := auth.uid(),
    _owner := 'Finance', _next_action := 'Match against the supplier invoice', _blocker := NULL,
    _journal := v_journal, _receipt := NULL,
    _downstream := jsonb_build_object('grn.finance', 'emitted'),
    _metadata := jsonb_build_object('entity_kind', 'grn'));

  RETURN v_res;
END $function$;

CREATE OR REPLACE FUNCTION public.neo_night_audit_run(_branch uuid, _date date DEFAULT NULL::date, _mode text DEFAULT 'manual'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE org uuid:=public.current_org_id(); d date:=coalesce(_date,current_date); rid uuid; ref text; attempt int; started timestamptz:=now(); blockers int:=0; warnings int:=0; counts jsonb:='{}'; snapshot jsonb:='[]'; summary jsonb; digest text; operator text; err text; outcome text;
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
  DELETE FROM public.night_audit_exceptions WHERE run_id=rid;
  INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount)
  SELECT rid,org,_branch,d,'finance-posting','blocking',e.reference,coalesce(e.detail,e.reason),e.amount FROM public.neo_finance_exception_register(_branch,d,d)e;
  INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount)
  SELECT rid,org,_branch,d,'finance-posting','blocking',q.reference,q.required_action,q.amount FROM public.neo_finance_posting_queue(_branch,d,d)q WHERE q.eligible;
  INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount)
  SELECT rid,org,_branch,d,'approval','warning',coalesce(nullif(a.reference,''),a.id::text),'Controlled transaction is still awaiting approval.',a.amount FROM public.approval_requests a WHERE a.organization_id=org AND a.branch_id=_branch AND a.created_at::date<=d AND public.neo_approval_normalize_status(a.status)='pending';
  SELECT count(*) FILTER(WHERE severity='blocking'),count(*) FILTER(WHERE severity='warning'),coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.created_at),'[]'::jsonb) INTO blockers,warnings,snapshot FROM public.night_audit_exceptions e WHERE e.run_id=rid;
  SELECT coalesce(jsonb_object_agg(source_module,c),'{}'::jsonb) INTO counts FROM(SELECT source_module,count(*) c FROM public.canonical_transaction_states WHERE organization_id=org AND branch_id=_branch AND occurred_at::date=d GROUP BY source_module)x;
  summary:=jsonb_build_object('reference',ref,'operator',operator,'started_at',started,'finished_at',now(),'source_counts',counts,'blocking',blockers,'warnings',warnings,'outcome',CASE WHEN blockers>0 THEN 'exception' ELSE 'completed' END);
  digest:=encode(digest(convert_to(summary::text,'UTF8'),'sha256'),'hex');
  UPDATE public.night_audit_runs SET blocking_count=blockers,warning_count=warnings,status=CASE WHEN blockers>0 THEN 'exception' ELSE 'completed' END,stage='signed',completed_at=now(),source_counts=counts,exception_snapshot=snapshot,summary=summary,result_digest=digest,signed_at=now() WHERE id=rid;
  UPDATE public.night_audit_attempts SET stage='signed',status=CASE WHEN blockers>0 THEN 'exception' ELSE 'completed' END,source_counts=counts,exception_snapshot=snapshot,result_digest=digest,completed_at=now() WHERE run_id=rid AND attempt_number=attempt;
 EXCEPTION WHEN OTHERS THEN
  err:=SQLERRM; blockers:=1;
  UPDATE public.night_audit_runs SET blocking_count=1,status='failed',stage='failed',completed_at=now(),summary=jsonb_build_object('reference',ref,'failed_stage','collecting','error',err),result_digest=NULL,signed_at=NULL WHERE id=rid;
  UPDATE public.night_audit_attempts SET stage='failed',status='failed',error=err,completed_at=now() WHERE run_id=rid AND attempt_number=attempt;
 END;

 outcome := CASE WHEN err IS NOT NULL THEN 'failed' WHEN blockers>0 THEN 'exception' ELSE 'completed' END;

 -- The audit result is a durable event of its own: one per run attempt, so a
 -- rerun is traceable and the close-day consumer can be replayed.
 PERFORM public.emit_domain_event(org,_branch,'night_audit.'||outcome,'finance',rid,
   jsonb_build_object('reference',ref,'business_date',d,'attempt',attempt,'blocking',blockers,'warnings',warnings,'digest',digest,'error',err),
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
   _metadata := jsonb_build_object('entity_kind','night_audit','business_date',d,'attempt',attempt,'source_counts',counts));

 RETURN jsonb_build_object('run_id',rid,'reference',ref,'business_date',d,'blocking',blockers,'warnings',warnings,'status',outcome,'stage',CASE WHEN err IS NOT NULL THEN 'failed' ELSE 'signed' END,'digest',digest,'error',err);
END $function$;