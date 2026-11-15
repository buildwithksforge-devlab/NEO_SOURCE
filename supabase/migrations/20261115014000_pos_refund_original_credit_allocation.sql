-- Preserves payout authorization and original-receipt controls. Executes no payout.
BEGIN;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner
   WHERE p.oid=to_regprocedure('public.neo_refund_settle_internal(uuid,boolean,text,uuid)') AND owner.rolname NOT IN ('anon','authenticated')
   AND (md5(pg_get_functiondef(p.oid))='bafd3b18d1ef2be1f81746921a797ce1' OR md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))='47e51463928a1fcf7c2159571accb2ab')) THEN
  RAISE EXCEPTION 'Installed refund command differs from reviewed code; no replacement applied';
 END IF;
 IF to_regprocedure('public.neo_refund_credit_allocation(uuid,uuid,uuid,text,numeric,numeric,numeric,jsonb)') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.neo_refund_credit_allocation(uuid,uuid,uuid,text,numeric,numeric,numeric,jsonb)') AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))='27e0b0e58c38699b8228921ca4040a48') THEN
  RAISE EXCEPTION 'Refund allocation helper name is already in use by different code';
 END IF;
END $guard$;
CREATE TEMP TABLE neo_refund_acl_snapshot ON COMMIT DROP AS SELECT proowner,coalesce(proacl::text,'') acl FROM pg_proc WHERE oid='public.neo_refund_settle_internal(uuid,boolean,text,uuid)'::regprocedure;
-- Private arithmetic helper: reverse the original journal's actual credit split.
-- Allocate remaining original credits; prior allocations come from verified payouts.
CREATE OR REPLACE FUNCTION public.neo_refund_credit_allocation(
 _journal uuid, _org uuid, _branch uuid, _currency text,
 _total numeric, _previous numeric, _amount numeric, _prior jsonb
) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path TO 'public','pg_temp'
AS $function$
DECLARE result jsonb; credited numeric; allocated numeric;
BEGIN
 IF public.current_org_id() IS DISTINCT FROM _org
    OR public.neo_branch_in_scope(_branch) IS NOT TRUE THEN
  RAISE EXCEPTION 'Refund allocation is outside your property scope' USING ERRCODE='42501';
 END IF;
 IF _total IS NULL OR _previous IS NULL OR _amount IS NULL
    OR _total::text IN ('NaN','Infinity','-Infinity')
    OR _previous::text IN ('NaN','Infinity','-Infinity')
    OR _amount::text IN ('NaN','Infinity','-Infinity')
    OR _total<=0 OR _previous<0 OR _amount<=0
    OR _total<>round(_total,2) OR _previous<>round(_previous,2) OR _amount<>round(_amount,2)
    OR _previous+_amount>_total THEN
  RAISE EXCEPTION 'Refund allocation requires verified currency amounts within the original sale';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.journal_entries j
   WHERE j.id=_journal AND j.organization_id=_org AND j.branch_id IS NOT DISTINCT FROM _branch
     AND j.currency=_currency AND j.status='posted' AND j.reversed_by_journal_id IS NULL
     AND j.reverses_journal_id IS NULL AND j.total_debit=_total AND j.total_credit=_total) THEN
  RAISE EXCEPTION 'Original refund journal is not an unreversed posted sale';
 END IF;
 IF EXISTS(SELECT 1 FROM public.journal_entry_lines l LEFT JOIN public.chart_of_accounts a ON a.id=l.account_id
   WHERE l.journal_id=_journal AND (l.organization_id IS DISTINCT FROM _org
     OR l.branch_id IS DISTINCT FROM _branch OR a.organization_id IS DISTINCT FROM _org
     OR a.active IS NOT TRUE OR a.postable IS NOT TRUE OR coalesce(a.is_header,false)
     OR nullif(btrim(a.code),'') IS NULL OR l.debit IS NULL OR l.credit IS NULL
     OR l.debit<0 OR l.credit<0 OR (l.debit>0 AND l.credit>0)
     OR l.debit::text IN ('NaN','Infinity','-Infinity') OR l.credit::text IN ('NaN','Infinity','-Infinity'))) THEN
  RAISE EXCEPTION 'Original refund journal lines or accounts need review';
 END IF;
 SELECT coalesce(sum(l.credit),0),coalesce(sum(l.debit),0) INTO credited,allocated
 FROM public.journal_entry_lines l WHERE l.journal_id=_journal;
 IF credited<>_total OR allocated<>_total THEN
  RAISE EXCEPTION 'Original refund journal line totals do not match its sale';
 END IF;
 IF _prior IS NULL OR jsonb_typeof(_prior)<>'array' THEN RAISE EXCEPTION 'Prior refund allocation evidence is required'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(_prior) x
   WHERE jsonb_typeof(x)<>'object' OR nullif(btrim(x->>'code'),'') IS NULL
     OR x->>'amount' IS NULL OR (x->>'amount')::numeric<0
     OR ((x->>'amount')::numeric)::text IN ('NaN','Infinity','-Infinity')
     OR (x->>'amount')::numeric<>round((x->>'amount')::numeric,2))
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(_prior) x GROUP BY x->>'code' HAVING count(*)>1)
   OR (SELECT coalesce(sum((x->>'amount')::numeric),0) FROM jsonb_array_elements(_prior) x)<>_previous THEN
  RAISE EXCEPTION 'Prior refund allocations do not agree with verified payouts';
 END IF;
 IF EXISTS(WITH buckets AS (
   SELECT a.code,sum(l.credit) amount FROM public.journal_entry_lines l
   JOIN public.chart_of_accounts a ON a.id=l.account_id
   WHERE l.journal_id=_journal AND l.credit>0 GROUP BY a.code
  ) SELECT 1 FROM jsonb_array_elements(_prior) x LEFT JOIN buckets b ON b.code=x->>'code'
   WHERE b.code IS NULL OR (x->>'amount')::numeric>b.amount) THEN
  RAISE EXCEPTION 'Earlier refunds differ from the original sale accounts; reconcile before payout';
 END IF;
 WITH buckets AS (
  SELECT a.code,sum(l.credit) amount FROM public.journal_entry_lines l
  JOIN public.chart_of_accounts a ON a.id=l.account_id
  WHERE l.journal_id=_journal AND l.credit>0 GROUP BY a.code
 ), remaining AS (
  SELECT b.code,b.amount-coalesce((p.x->>'amount')::numeric,0) amount FROM buckets b
  LEFT JOIN LATERAL (SELECT x FROM jsonb_array_elements(_prior) x WHERE x->>'code'=b.code) p ON true
 ), shares AS (
  SELECT code,amount,100*_amount*amount/(_total-_previous) exact_cents FROM remaining
 ), ranked AS (
  SELECT *,floor(exact_cents) base_cents,
   row_number() OVER(ORDER BY exact_cents-floor(exact_cents) DESC,code) priority,
   (100*_amount-sum(floor(exact_cents)) OVER())::integer extra_cents FROM shares
 ), portions AS (
  SELECT code,(base_cents+CASE WHEN priority<=extra_cents THEN 1 ELSE 0 END)/100 amount FROM ranked
 )
 SELECT jsonb_agg(jsonb_build_object('code',code,'debit',amount,'credit',0,
   'description','Refund allocation from original sale') ORDER BY code),sum(amount)
 INTO result,allocated FROM portions WHERE amount<>0;
 IF result IS NULL OR allocated IS DISTINCT FROM _amount
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(result) x WHERE (x->>'debit')::numeric<0) THEN
  RAISE EXCEPTION 'Refund allocation cannot be represented safely; original credit breakdown needs review';
 END IF;
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.neo_refund_settle_internal(_refund uuid, _cash boolean, _reference text DEFAULT NULL::text, _account uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE org uuid:=public.current_org_id(); r public.cash_refund_requests; s public.pos_shifts; f public.folios; p jsonb; pid uuid; pay uuid; receipt text; expected numeric; reserved numeric; post jsonb; jid uuid; debit_code text; credit_code text; method text; account uuid; applied_line public.folio_lines; original_journal uuid; original_total numeric; previous_refunds numeric; previous_allocations jsonb; refund_lines jsonb;
BEGIN
 PERFORM public.neo_assert_capability('finance','payments','refund_payment');
 SELECT coalesce(payment_id,pos_payment_id) INTO pid FROM public.cash_refund_requests WHERE id=_refund AND organization_id=org;
 IF pid IS NULL THEN RAISE EXCEPTION 'Refund not found'; END IF;
 p:=public.neo_refund_receipt_lock(pid);
 SELECT * INTO r FROM public.cash_refund_requests WHERE id=_refund AND organization_id=org FOR UPDATE;
 IF (r.payment_id IS NULL)=(r.pos_payment_id IS NULL) THEN RAISE EXCEPTION 'Refund must identify exactly one original receipt'; END IF;
 IF r.branch_id IS DISTINCT FROM (p->>'branch_id')::uuid OR r.currency IS DISTINCT FROM p->>'currency' OR r.folio_id IS DISTINCT FROM nullif(p->>'folio_id','')::uuid THEN RAISE EXCEPTION 'Refund source property, folio or currency needs review'; END IF;
 method:=p->>'method';
 IF _cash IS NULL OR (_cash AND method<>'cash') OR (NOT _cash AND method='cash') THEN RAISE EXCEPTION 'Use the original tender refund workflow'; END IF;
 IF r.status='settled' THEN
  IF NOT _cash AND NOT EXISTS(SELECT 1 FROM public.payments x WHERE x.id=r.refund_payment_id AND x.organization_id=org AND x.destination_account_id IS NOT DISTINCT FROM _account AND x.external_reference IS NOT DISTINCT FROM btrim(_reference)) THEN RAISE EXCEPTION 'Saved electronic refund details differ from this retry'; END IF;
  IF NOT public.neo_cash_refund_payment_valid(r.refund_payment_id) THEN RAISE EXCEPTION 'Saved refund payout evidence is incomplete'; END IF;
  RETURN jsonb_build_object('ok',true,'status','settled','refund_id',r.id,'refund_receipt_number',r.refund_receipt_number,'payment_id',r.refund_payment_id,'journal_id',(SELECT posted_journal_id FROM public.payments WHERE id=r.refund_payment_id AND organization_id=org),'idempotent',true);
 END IF;
 IF r.status<>'approved' THEN RAISE EXCEPTION 'Refund must be authorised before payout'; END IF;
 IF r.requires_approval AND (r.approved_by IS NULL OR r.approved_by IS NOT DISTINCT FROM r.requested_by) THEN RAISE EXCEPTION 'Independent refund approval evidence is required'; END IF;
 IF r.amount IS NULL OR r.amount<=0 OR r.amount::text IN ('NaN','Infinity','-Infinity') OR round(r.amount,2)<>r.amount THEN RAISE EXCEPTION 'Refund amount needs review'; END IF;
 SELECT coalesce(sum(x.amount),0) INTO reserved FROM public.cash_refund_requests x WHERE x.organization_id=org AND x.status IN ('pending_approval','approved','settled') AND (x.payment_id=pid OR x.pos_payment_id=pid);
 IF reserved>(p->>'amount')::numeric OR reserved::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Refund reservations exceed the original receipt; reconcile before payout'; END IF;
 method:=p->>'method';
 IF _cash THEN
  IF method IS DISTINCT FROM 'cash' THEN RAISE EXCEPTION 'This receipt must be refunded through its original tender, not a cash till'; END IF;
  SELECT * INTO s FROM public.pos_shifts WHERE organization_id=org AND cashier_id=auth.uid() AND branch_id=r.branch_id AND status='open' ORDER BY opened_at DESC,id LIMIT 1 FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Open your own till at the refund property before payout'; END IF;
  expected:=public.cash_shift_expected(s.id);
  IF expected IS NULL OR expected::text IN ('NaN','Infinity','-Infinity') OR expected<r.amount THEN RAISE EXCEPTION 'The till does not hold enough verified expected cash for this refund'; END IF;
 ELSE
  IF method='cash' OR method NOT IN ('mpesa','card','card-terminal','debit-card','credit-card','qr','bank-transfer') THEN RAISE EXCEPTION 'This request requires its cash or credit-note workflow'; END IF;
  IF length(btrim(coalesce(_reference,'')))<3 THEN RAISE EXCEPTION 'Enter the completed bank/provider refund confirmation reference'; END IF;
  account:=public.neo_assert_financial_account(org,r.branch_id,_account);
  IF nullif(p->>'destination_account_id','') IS NOT NULL AND account IS DISTINCT FROM (p->>'destination_account_id')::uuid THEN RAISE EXCEPTION 'Use the original receiving account for this electronic refund'; END IF;
  IF account IS NULL THEN RAISE EXCEPTION 'Select the account used for the completed electronic refund'; END IF;
  IF method NOT IN ('card','card-terminal','debit-card','credit-card') AND NOT EXISTS(SELECT 1 FROM public.bank_accounts b JOIN public.chart_of_accounts a ON a.id=b.gl_account_id AND a.organization_id=b.organization_id WHERE b.id=account AND b.organization_id=org AND a.active AND a.postable AND NOT coalesce(a.is_header,false)) THEN RAISE EXCEPTION 'Map the refund account to an active postable ledger account before recording payout'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('refund-confirmation:'||org::text||':'||upper(btrim(_reference)),0));
  IF EXISTS(SELECT 1 FROM public.payments x WHERE x.organization_id=org AND upper(btrim(coalesce(x.external_reference,'')))=upper(btrim(_reference)) AND x.status NOT IN ('failed','cancelled')) THEN RAISE EXCEPTION 'Refund confirmation reference is already linked to a saved payment'; END IF;
 END IF;
 IF r.folio_id IS NOT NULL THEN
  SELECT * INTO f FROM public.folios WHERE id=r.folio_id AND organization_id=org FOR UPDATE;
  IF f.id IS NULL OR f.branch_id IS DISTINCT FROM r.branch_id OR f.currency IS DISTINCT FROM r.currency THEN RAISE EXCEPTION 'Refund folio evidence is incomplete'; END IF;
  IF f.status NOT IN ('open','under-review') AND coalesce(f.balance,0)+r.amount>0.005 THEN RAISE EXCEPTION 'Reopen and correct the folio charges or credit note before returning money that would create an unpaid closed folio'; END IF;
 END IF;
 IF r.pos_payment_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.pos_orders o JOIN public.journal_entries j ON j.source_document_id=o.id WHERE o.id=(p->>'order_id')::uuid AND o.organization_id=org AND public.neo_connection_journal_matches(j.id,org,r.branch_id,r.currency,o.grand_total,'pos_order:revenue',o.id)) THEN RAISE EXCEPTION 'Original POS sale requires matching posted Finance evidence before a refund payout'; END IF;
 ELSIF nullif(p->>'deposit_id','') IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.journal_entries j WHERE public.neo_connection_journal_matches(j.id,org,r.branch_id,r.currency,(p->>'amount')::numeric,'reservation_deposit:deposit',(p->>'deposit_id')::uuid)) THEN RAISE EXCEPTION 'Original deposit requires matching posted Finance evidence before a refund payout'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM public.journal_entries j WHERE public.neo_connection_journal_matches(j.id,org,r.branch_id,r.currency,(p->>'amount')::numeric,CASE WHEN p->>'source_module'='delivery' THEN 'delivery_payment' ELSE 'folio_payment:collection' END,(p->>'id')::uuid)) THEN RAISE EXCEPTION 'Original receipt requires matching posted Finance evidence before a refund payout'; END IF;
 END IF;
 receipt:=public.next_document_number('receipt',NULL,r.branch_id);
 INSERT INTO public.payments(organization_id,branch_id,receipt_number,folio_id,reservation_id,customer_id,amount,currency,method,external_reference,status,received_by,notes,shift_id,source_module,source_record_id,idempotency_key,destination_account_id)
 VALUES(org,r.branch_id,receipt,r.folio_id,nullif(p->>'reservation_id','')::uuid,nullif(p->>'customer_id','')::uuid,-r.amount,r.currency,method,CASE WHEN _cash THEN r.original_receipt_number ELSE btrim(_reference) END,'draft',auth.uid(),'Refund of '||coalesce(r.original_receipt_number,'receipt')||' — '||r.reason,s.id,'cash_refund',r.id,'cash-refund:'||r.id::text,account) RETURNING id INTO pay;
 UPDATE public.cash_refund_requests SET status='settled',settled_by=auth.uid(),settled_at=now(),refund_payment_id=pay,refund_receipt_number=receipt,shift_id=s.id,updated_at=now() WHERE id=r.id;
 IF r.pos_payment_id IS NOT NULL THEN
  SELECT o.grand_total INTO original_total FROM public.pos_orders o WHERE o.id=(p->>'order_id')::uuid AND o.organization_id=org;
  IF (SELECT count(*) FROM public.journal_entries j WHERE public.neo_connection_journal_matches(j.id,org,r.branch_id,r.currency,original_total,'pos_order:revenue',(p->>'order_id')::uuid) AND j.reverses_journal_id IS NULL)<>1 THEN RAISE EXCEPTION 'Original POS refund requires one unambiguous posted sale journal'; END IF;
  SELECT j.id INTO original_journal FROM public.journal_entries j WHERE public.neo_connection_journal_matches(j.id,org,r.branch_id,r.currency,original_total,'pos_order:revenue',(p->>'order_id')::uuid) AND j.reverses_journal_id IS NULL;
  IF EXISTS(SELECT 1 FROM public.cash_refund_requests prior JOIN public.pos_payments receipt ON receipt.id=prior.pos_payment_id AND receipt.organization_id=prior.organization_id
    WHERE prior.organization_id=org AND receipt.order_id=(p->>'order_id')::uuid AND prior.status='settled' AND prior.id<>r.id
      AND (prior.branch_id IS DISTINCT FROM r.branch_id OR prior.currency IS DISTINCT FROM r.currency OR NOT public.neo_cash_refund_payment_valid(prior.refund_payment_id))) THEN
   RAISE EXCEPTION 'Earlier POS refund payout evidence needs reconciliation';
  END IF;
  SELECT coalesce(sum(prior.amount),0) INTO previous_refunds FROM public.cash_refund_requests prior
   JOIN public.pos_payments receipt ON receipt.id=prior.pos_payment_id AND receipt.organization_id=prior.organization_id
   WHERE prior.organization_id=org AND receipt.order_id=(p->>'order_id')::uuid AND prior.status='settled' AND prior.id<>r.id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('code',credits.code,'amount',credits.amount)),'[]'::jsonb) INTO previous_allocations FROM (
   SELECT a.code,sum(l.debit) amount FROM public.cash_refund_requests prior
   JOIN public.pos_payments receipt ON receipt.id=prior.pos_payment_id AND receipt.organization_id=prior.organization_id
   JOIN public.payments payout ON payout.id=prior.refund_payment_id AND payout.organization_id=prior.organization_id
   JOIN public.journal_entry_lines l ON l.journal_id=payout.posted_journal_id AND l.organization_id=prior.organization_id
   JOIN public.chart_of_accounts a ON a.id=l.account_id AND a.organization_id=prior.organization_id
   WHERE prior.organization_id=org AND receipt.order_id=(p->>'order_id')::uuid AND prior.status='settled' AND prior.id<>r.id AND l.debit>0 GROUP BY a.code
  ) credits;
  refund_lines:=public.neo_refund_credit_allocation(original_journal,org,r.branch_id,r.currency,original_total,previous_refunds,r.amount,previous_allocations);
  debit_code:=refund_lines->0->>'code';
 ELSE
  debit_code:='1060';
  IF nullif(p->>'deposit_id','') IS NOT NULL THEN
   debit_code:='2020';
   IF p->>'deposit_status'='applied' THEN
    SELECT fl.* INTO applied_line FROM public.folio_lines fl JOIN public.reservation_deposits d ON d.applied_folio_line_id=fl.id AND d.organization_id=fl.organization_id WHERE d.id=(p->>'deposit_id')::uuid AND d.organization_id=org;
    IF EXISTS(SELECT 1 FROM public.journal_entries j WHERE public.neo_connection_journal_matches(j.id,org,r.branch_id,r.currency,applied_line.net_amount,'deposit_application:application',(p->>'deposit_id')::uuid)) THEN debit_code:='1060'; END IF;
   END IF;
  END IF;
 END IF;
 credit_code:=public.neo_gl_account_code(org,method,account);
 IF nullif(debit_code,'') IS NULL OR nullif(credit_code,'') IS NULL THEN RAISE EXCEPTION 'Refund ledger accounts are not configured'; END IF;
 post:=public.neo_gl_post(org,r.branch_id,'refund','cash_refund',r.id,'refund',(now() AT TIME ZONE public.neo_fact_timezone(org,r.branch_id))::date,r.currency,'Refund '||r.original_receipt_number,coalesce(refund_lines,jsonb_build_array(jsonb_build_object('code',debit_code,'debit',r.amount,'credit',0,'description',r.reason)))||jsonb_build_array(jsonb_build_object('code',credit_code,'debit',0,'credit',r.amount,'description',CASE WHEN _cash THEN 'Cash returned from till' ELSE 'Completed electronic refund '||btrim(_reference) END)),nullif(p->>'customer_id','')::uuid,NULL);
 jid:=nullif(post->>'journal_id','')::uuid;
 IF post->>'ok' IS DISTINCT FROM 'true' OR NOT public.neo_connection_journal_matches(jid,org,r.branch_id,r.currency,r.amount,'cash_refund:refund',r.id) THEN RAISE EXCEPTION 'Refund payout did not produce a verified posted journal'; END IF;
 UPDATE public.payments SET status='confirmed',paid_at=now(),posted_journal_id=jid WHERE id=pay;
 IF NOT public.neo_cash_refund_payment_valid(pay) THEN RAISE EXCEPTION 'Saved refund receipt and journal did not reconcile'; END IF;
 IF r.folio_id IS NOT NULL THEN
  INSERT INTO public.payment_allocations(organization_id,payment_id,folio_id,amount,created_by) VALUES(org,pay,r.folio_id,-r.amount,auth.uid());
  UPDATE public.folios SET total_payments=coalesce(total_payments,0)-r.amount,balance=coalesce(balance,0)+r.amount,updated_at=now() WHERE id=r.folio_id AND organization_id=org;
 END IF;
 IF nullif(p->>'delivery_invoice_id','') IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.invoices i WHERE i.id=(p->>'delivery_invoice_id')::uuid AND i.organization_id=org AND i.amount_paid>=r.amount AND i.amount_paid::text NOT IN ('NaN','Infinity','-Infinity') AND i.balance::text NOT IN ('NaN','Infinity','-Infinity')) THEN RAISE EXCEPTION 'Delivery refund exceeds its saved invoice collections'; END IF;
  UPDATE public.invoices SET amount_paid=amount_paid-r.amount,balance=balance+r.amount,status=CASE WHEN amount_paid-r.amount>0 THEN 'partially_paid' ELSE 'issued' END,updated_at=now() WHERE id=(p->>'delivery_invoice_id')::uuid AND organization_id=org;
  UPDATE public.delivery_orders SET payment_status=CASE WHEN (SELECT amount_paid FROM public.invoices WHERE id=(p->>'delivery_invoice_id')::uuid)>0 THEN 'partially-paid' ELSE 'unpaid' END,updated_at=now() WHERE id=(p->>'source_record_id')::uuid AND organization_id=org;
 END IF;
 IF _cash THEN INSERT INTO public.cash_movements(organization_id,shift_id,movement_type,amount,reason,reference,created_by) VALUES(org,s.id,'refund',r.amount,r.reason,receipt,auth.uid()); END IF;
 UPDATE public.pos_refund_requests SET status='processed',updated_at=now() WHERE organization_id=org AND cash_refund_request_id=r.id AND status='approved';
 INSERT INTO public.audit_logs(organization_id,user_id,user_name,action,module,record_id,new_value,reason) VALUES(org,auth.uid(),'','finance.refund.settle','finance',pay::text,jsonb_build_object('refund_id',r.id,'amount',r.amount,'method',method,'shift_id',s.id,'journal_id',jid,'expected_cash_before',expected,'original_receipt_unchanged',true),r.reason);
 RETURN jsonb_build_object('ok',true,'status','settled','refund_id',r.id,'payment_id',pay,'refund_receipt_number',receipt,'amount',r.amount,'journal_id',jid,'method',method);
END $function$
;

DO $private$ DECLARE owner_name text; BEGIN
 SELECT r.rolname INTO owner_name FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='public.neo_refund_settle_internal(uuid,boolean,text,uuid)'::regprocedure;
 EXECUTE format('ALTER FUNCTION public.neo_refund_credit_allocation(uuid,uuid,uuid,text,numeric,numeric,numeric,jsonb) OWNER TO %I',owner_name);
 REVOKE ALL ON FUNCTION public.neo_refund_credit_allocation(uuid,uuid,uuid,text,numeric,numeric,numeric,jsonb) FROM PUBLIC,anon,authenticated,service_role;
 EXECUTE format('GRANT EXECUTE ON FUNCTION public.neo_refund_credit_allocation(uuid,uuid,uuid,text,numeric,numeric,numeric,jsonb) TO %I',owner_name);
END $private$;
DO $verify$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN neo_refund_acl_snapshot s ON s.proowner=p.proowner AND s.acl=coalesce(p.proacl::text,'')
   WHERE p.oid='public.neo_refund_settle_internal(uuid,boolean,text,uuid)'::regprocedure AND p.prosecdef AND p.provolatile='v'
    AND p.proconfig=ARRAY['search_path=public'] AND p.prorettype='jsonb'::regtype AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))='47e51463928a1fcf7c2159571accb2ab') THEN
  RAISE EXCEPTION 'Refund command definition or permissions verification failed; installation rolled back';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='public.neo_refund_credit_allocation(uuid,uuid,uuid,text,numeric,numeric,numeric,jsonb)'::regprocedure AND NOT p.prosecdef AND p.provolatile='s'
   AND p.proconfig=ARRAY['search_path=public, pg_temp'] AND p.prorettype='jsonb'::regtype AND md5(regexp_replace(regexp_replace(p.prosrc,'--[^'||chr(10)||']*','','g'),'[[:space:]]','','g'))='27e0b0e58c38699b8228921ca4040a48')
   OR has_function_privilege('anon','public.neo_refund_credit_allocation(uuid,uuid,uuid,text,numeric,numeric,numeric,jsonb)','EXECUTE') OR has_function_privilege('authenticated','public.neo_refund_credit_allocation(uuid,uuid,uuid,text,numeric,numeric,numeric,jsonb)','EXECUTE') THEN
  RAISE EXCEPTION 'Private refund allocation boundary verification failed; installation rolled back';
 END IF;
END $verify$;
SELECT jsonb_build_object('diagnostic_version','pos-refund-original-credit-allocation-v1','definition_matches',true,'permissions_unchanged',true,
 'scope','Future standalone POS payouts reverse the original posted revenue, tax and liability accounts, using verified prior payouts. Installation pays no refund and changes no historical row. Existing approval and original-tender controls remain.');
COMMIT;
