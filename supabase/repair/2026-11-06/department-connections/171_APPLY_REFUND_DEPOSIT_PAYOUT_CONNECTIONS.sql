BEGIN;
DO $guard$ DECLARE mismatch boolean; BEGIN IF EXISTS(SELECT 1 FROM unnest(ARRAY['public.neo_cash_refund_payment_valid(uuid)','public.neo_cash_refund_request_v2(uuid,numeric,text,uuid)','public.neo_deposit_net_amount(uuid)','public.neo_pos_refund_position(uuid)','public.neo_pos_refund_request(uuid,uuid,numeric,text,uuid)','public.neo_pos_refund_settle(uuid,text,uuid,boolean)','public.neo_refund_payment_write_guard()','public.neo_refund_receipt_lock(uuid)','public.neo_refund_reserve(uuid,numeric,text,text,uuid,boolean,uuid)','public.neo_refund_settle_internal(uuid,boolean,text,uuid)','public.neo_refunded_deposit_id(uuid)']) s WHERE to_regprocedure(s) IS NOT NULL) THEN RAISE EXCEPTION 'Refund connection repair already exists; run the postcheck'; END IF; WITH expected(signature,hash) AS(VALUES ('public.neo_cash_refund_decide(uuid,boolean,text)','eeb93dd1c6bdb7d5b5bc5f097f87aa57'),('public.neo_cash_refund_request(uuid,numeric,text)','22663566c3f3417cf6b24fa034121942'),('public.neo_cash_refund_settle(uuid)','e19efc4e9ff87b16b67d229ad232dce2'),('public.neo_cash_refunds(uuid)','8d550329f7849916d058eed1a9af0ea9'),('public.neo_finance_post_refund(text,uuid,boolean)','b3766e03334b06b480f5dc8da3ec2b62'),('public.neo_finance_post_txn(text,uuid,boolean)','dbb01aba5b96dd7badbdf3e30a5bc7dc'),('public.neo_pos_refund_decide(uuid,boolean,text)','b0091ffed016fba845495c9fbbebdeef'),('public.neo_reservation_collection_facts(uuid,uuid,uuid)','a13333be00fef8e23a31d7cfef2a2d46'),('public.neo_reservation_deposit_position(uuid)','0e01761b972470170084715d3cab29db'),('public.pms_apply_deposits_to_folio()','7a61f8cddce838ab71480e710140c608'),('public.neo_connection_journal_matches(uuid,uuid,uuid,text,numeric,text,uuid)','209395bb00e8b95f142fd52b2abd0a4e')) SELECT bool_or(md5(pg_get_functiondef(to_regprocedure(signature))) IS DISTINCT FROM hash) INTO mismatch FROM expected;IF mismatch THEN RAISE EXCEPTION 'Refund/Finance prerequisites changed; inspect before replacing'; END IF; IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.cash_movements'::regclass AND conname='cash_movements_type_chk' AND pg_get_constraintdef(oid)='CHECK ((movement_type = ANY (ARRAY[''float-in''::text, ''cash-sale''::text, ''paid-out''::text, ''petty-cash''::text, ''drop''::text, ''count''::text, ''adjustment''::text, ''pickup''::text, ''float-top-up''::text, ''rider-cash''::text])))') THEN RAISE EXCEPTION 'Till movement constraint changed; inspect before extending';END IF; END $guard$;
ALTER TABLE public.cash_refund_requests ADD COLUMN request_key text;
CREATE UNIQUE INDEX neo_cash_refund_request_key_uq ON public.cash_refund_requests(organization_id,request_key) WHERE request_key IS NOT NULL;
ALTER TABLE public.pos_refund_requests ADD COLUMN cash_refund_request_id uuid REFERENCES public.cash_refund_requests(id);
CREATE UNIQUE INDEX neo_pos_refund_cash_link_uq ON public.pos_refund_requests(cash_refund_request_id) WHERE cash_refund_request_id IS NOT NULL;

CREATE FUNCTION public.neo_refund_reserve(_payment uuid,_amount numeric,_reason text,_key text,_requester uuid,_force_review boolean,_exclude_pos uuid DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $f$
DECLARE org uuid:=public.current_org_id(); p jsonb; r public.cash_refund_requests; threshold numeric; needs boolean; reserved numeric; legacy_reserved numeric; rid uuid;
BEGIN
 IF _requester IS NULL THEN RAISE EXCEPTION 'A refund requester is required'; END IF;
 IF _amount IS NULL OR _amount<=0 OR _amount::text IN ('NaN','Infinity','-Infinity') OR round(_amount,2)<>_amount THEN RAISE EXCEPTION 'Enter a finite positive refund amount in cents'; END IF;
 IF length(btrim(coalesce(_reason,'')))<3 OR length(btrim(_reason))>500 OR nullif(btrim(_key),'') IS NULL THEN RAISE EXCEPTION 'A refund reason and request identity are required'; END IF;
 p:=public.neo_refund_receipt_lock(_payment);
 IF p->>'method' NOT IN ('cash','mpesa','card','card-terminal','debit-card','credit-card','qr','bank-transfer') THEN RAISE EXCEPTION 'This payment needs its credit-note or original tender reversal workflow'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('refund-request:'||org::text||':'||_key,0));
 SELECT * INTO r FROM public.cash_refund_requests WHERE organization_id=org AND request_key=_key;
 IF r.id IS NOT NULL THEN
  IF coalesce(r.payment_id,r.pos_payment_id) IS DISTINCT FROM _payment OR r.amount IS DISTINCT FROM _amount OR r.reason IS DISTINCT FROM btrim(_reason) OR r.requested_by IS DISTINCT FROM _requester OR r.branch_id IS DISTINCT FROM (p->>'branch_id')::uuid OR r.currency IS DISTINCT FROM p->>'currency' THEN RAISE EXCEPTION 'Refund request identity belongs to different details'; END IF;
  RETURN r.id;
 END IF;
 SELECT coalesce(sum(amount),0) INTO reserved FROM public.cash_refund_requests WHERE organization_id=org AND status IN ('pending_approval','approved','settled') AND (payment_id=_payment OR pos_payment_id=_payment);
 IF EXISTS(SELECT 1 FROM public.pos_refund_requests x WHERE x.organization_id=org AND x.payment_id=_payment AND x.status='processed' AND x.cash_refund_request_id IS NULL) THEN RAISE EXCEPTION 'Legacy processed refund evidence must be reconciled before another payout'; END IF;
 SELECT coalesce(sum(x.amount),0) INTO legacy_reserved FROM public.pos_refund_requests x WHERE x.organization_id=org AND x.payment_id=_payment AND x.status IN ('pending','approved') AND x.cash_refund_request_id IS NULL AND x.id IS DISTINCT FROM _exclude_pos;
 reserved:=reserved+legacy_reserved;
 IF reserved::text IN ('NaN','Infinity','-Infinity') OR reserved<0 OR reserved+_amount>(p->>'amount')::numeric THEN RAISE EXCEPTION 'Refund exceeds the unreserved amount on the original receipt'; END IF;
 SELECT approval_threshold INTO threshold FROM public.cash_refund_policies WHERE organization_id=org AND (branch_id=(p->>'branch_id')::uuid OR branch_id IS NULL) ORDER BY (branch_id IS NULL) LIMIT 1;
 threshold:=coalesce(threshold,0);
 IF threshold<0 OR threshold::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Refund approval policy needs review'; END IF;
 needs:=_force_review OR _amount>threshold;
 INSERT INTO public.cash_refund_requests(organization_id,branch_id,payment_id,pos_payment_id,folio_id,original_receipt_number,amount,currency,reason,status,requires_approval,requested_by,approved_by,approved_at,decision_note,request_key)
 VALUES(org,(p->>'branch_id')::uuid,CASE WHEN p->>'kind'='folio' THEN _payment END,CASE WHEN p->>'kind'='pos' THEN _payment END,nullif(p->>'folio_id','')::uuid,p->>'receipt_number',_amount,p->>'currency',btrim(_reason),CASE WHEN needs THEN 'pending_approval' ELSE 'approved' END,needs,_requester,NULL,CASE WHEN NOT needs THEN now() END,CASE WHEN NOT needs THEN 'Automatically authorised under configured threshold; no staff self-approval' END,_key) RETURNING id INTO rid;
 RETURN rid;
END $f$;
REVOKE ALL ON FUNCTION public.neo_refund_reserve(uuid,numeric,text,text,uuid,boolean,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.neo_cash_refund_request_v2(_payment uuid,_amount numeric,_reason text,_attempt uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $f$
DECLARE r public.cash_refund_requests; p jsonb; rid uuid;
BEGIN
 IF NOT coalesce(public.has_permission('finance','till.confirm_cash') OR public.has_permission('pms','payments.record') OR public.has_permission('pos','payments.record') OR public.is_org_admin(),false) THEN RAISE EXCEPTION 'Not permitted to raise refunds' USING ERRCODE='42501'; END IF;
 IF _attempt IS NULL THEN RAISE EXCEPTION 'A refund attempt identity is required'; END IF;
 p:=public.neo_refund_receipt_lock(_payment);
 IF p->>'method' IS DISTINCT FROM 'cash' THEN RAISE EXCEPTION 'Use the original tender refund workflow; this screen raises cash refunds only'; END IF;
 rid:=public.neo_refund_reserve(_payment,_amount,_reason,'cash-refund:'||_attempt::text,auth.uid(),false);
 SELECT * INTO r FROM public.cash_refund_requests WHERE id=rid AND organization_id=public.current_org_id();
 RETURN jsonb_build_object('ok',true,'status',r.status,'refund_id',r.id,'amount',r.amount,'original_receipt_number',r.original_receipt_number,'refund_receipt_number',r.refund_receipt_number,'payment_id',r.refund_payment_id);
END $f$;
REVOKE ALL ON FUNCTION public.neo_cash_refund_request_v2(uuid,numeric,text,uuid) FROM PUBLIC,anon;GRANT EXECUTE ON FUNCTION public.neo_cash_refund_request_v2(uuid,numeric,text,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_cash_refund_request(_payment uuid,_amount numeric,_reason text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $f$
BEGIN RETURN public.neo_cash_refund_request_v2(_payment,_amount,_reason,md5('legacy-refund:'||coalesce(public.current_org_id()::text,'')||':'||auth.uid()::text||':'||_payment::text||':'||_amount::text||':'||coalesce(btrim(_reason),''))::uuid);END $f$;

CREATE OR REPLACE FUNCTION public.neo_cash_refund_decide(_refund uuid,_approve boolean,_note text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $f$
DECLARE org uuid:=public.current_org_id(); r public.cash_refund_requests; p jsonb; pid uuid; desired text;
BEGIN
 IF _approve IS NULL THEN RAISE EXCEPTION 'Choose approve or reject'; END IF;
 SELECT coalesce(payment_id,pos_payment_id) INTO pid FROM public.cash_refund_requests WHERE id=_refund AND organization_id=org;
 IF pid IS NULL THEN RAISE EXCEPTION 'Refund not found'; END IF;
 p:=public.neo_refund_receipt_lock(pid);
 SELECT * INTO r FROM public.cash_refund_requests WHERE id=_refund AND organization_id=org FOR UPDATE;
 IF NOT coalesce(public.has_permission('finance','payment.approve') OR public.has_permission('finance','approve') OR public.is_org_admin() OR (r.pos_payment_id IS NOT NULL AND (public.has_permission('pos','refunds.approve') OR public.has_permission('pos','approve') OR public.has_permission('restaurant','approvals.approve'))),false) THEN RAISE EXCEPTION 'Not permitted to approve refunds' USING ERRCODE='42501'; END IF;
 IF r.branch_id IS DISTINCT FROM (p->>'branch_id')::uuid OR r.currency IS DISTINCT FROM p->>'currency' THEN RAISE EXCEPTION 'Refund receipt property or currency needs review'; END IF;
 IF r.requested_by IS NOT DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'A different authorised person must decide the refund' USING ERRCODE='42501'; END IF;
 desired:=CASE WHEN _approve THEN 'approved' ELSE 'rejected' END;
 IF r.status<> 'pending_approval' THEN
  IF r.status=desired OR (_approve AND r.status='settled') THEN
   IF r.status='settled' AND NOT public.neo_cash_refund_payment_valid(r.refund_payment_id) THEN RAISE EXCEPTION 'Saved refund payout evidence is incomplete'; END IF;
   RETURN jsonb_build_object('ok',true,'status',r.status,'refund_id',r.id,'idempotent',true,'payment_id',r.refund_payment_id,'refund_receipt_number',r.refund_receipt_number);
  END IF;
  RAISE EXCEPTION 'Saved refund decision differs; refresh and review';
 END IF;
 UPDATE public.cash_refund_requests SET status=desired,approved_by=auth.uid(),approved_at=now(),decision_note=nullif(btrim(_note),''),updated_at=now() WHERE id=r.id;
 UPDATE public.pos_refund_requests SET status=CASE WHEN _approve THEN 'approved' ELSE 'rejected' END,decided_by=auth.uid(),decided_at=now(),decision_note=_note,updated_at=now() WHERE cash_refund_request_id=r.id AND organization_id=org;
 INSERT INTO public.audit_logs(organization_id,user_id,user_name,action,module,record_id,new_value,reason) VALUES(org,auth.uid(),'','finance.refund.'||desired,'finance',r.id::text,jsonb_build_object('amount',r.amount,'original_receipt',r.original_receipt_number),_note);
 RETURN jsonb_build_object('ok',true,'status',desired,'refund_id',r.id,'payout_required',_approve);
END $f$;

CREATE FUNCTION public.neo_refund_settle_internal(_refund uuid,_cash boolean,_reference text DEFAULT NULL,_account uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $f$
DECLARE org uuid:=public.current_org_id(); r public.cash_refund_requests; s public.pos_shifts; f public.folios; p jsonb; pid uuid; pay uuid; receipt text; expected numeric; reserved numeric; post jsonb; jid uuid; debit_code text; credit_code text; method text; account uuid; applied_line public.folio_lines;
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
  SELECT public.neo_gl_revenue_code(o.order_type) INTO debit_code FROM public.pos_orders o WHERE o.id=(p->>'order_id')::uuid AND o.organization_id=org;
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
 post:=public.neo_gl_post(org,r.branch_id,'refund','cash_refund',r.id,'refund',(now() AT TIME ZONE public.neo_fact_timezone(org,r.branch_id))::date,r.currency,'Refund '||r.original_receipt_number,jsonb_build_array(jsonb_build_object('code',debit_code,'debit',r.amount,'credit',0,'description',r.reason),jsonb_build_object('code',credit_code,'debit',0,'credit',r.amount,'description',CASE WHEN _cash THEN 'Cash returned from till' ELSE 'Completed electronic refund '||btrim(_reference) END)),nullif(p->>'customer_id','')::uuid,NULL);
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
END $f$;
REVOKE ALL ON FUNCTION public.neo_refund_settle_internal(uuid,boolean,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.neo_cash_refund_settle(_refund uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $f$
BEGIN RETURN public.neo_refund_settle_internal(_refund,true,NULL,NULL);END $f$;

CREATE FUNCTION public.neo_cash_refund_payment_valid(_payment uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $f$
 SELECT EXISTS(SELECT 1 FROM public.payments p JOIN public.cash_refund_requests r ON r.id=p.source_record_id AND r.organization_id=p.organization_id LEFT JOIN public.pos_payments original_pos ON original_pos.id=r.pos_payment_id AND original_pos.organization_id=r.organization_id LEFT JOIN public.payments original_folio ON original_folio.id=r.payment_id AND original_folio.organization_id=r.organization_id WHERE p.id=_payment AND p.organization_id=public.current_org_id() AND p.source_module='cash_refund' AND p.status='confirmed' AND r.status='settled' AND r.refund_payment_id=p.id AND p.branch_id IS NOT DISTINCT FROM r.branch_id AND p.currency=r.currency AND p.method=coalesce(original_pos.method,original_folio.method) AND r.branch_id IS NOT DISTINCT FROM coalesce(original_pos.branch_id,original_folio.branch_id) AND r.currency=coalesce(original_pos.currency,original_folio.currency) AND p.amount=-r.amount AND r.amount>0 AND r.amount::text NOT IN ('NaN','Infinity','-Infinity') AND public.neo_connection_journal_matches(p.posted_journal_id,p.organization_id,p.branch_id,p.currency,r.amount,'cash_refund:refund',r.id))
$f$;
REVOKE ALL ON FUNCTION public.neo_cash_refund_payment_valid(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.neo_refunded_deposit_id(_payment uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $f$
 SELECT d.id FROM public.payments p JOIN public.cash_refund_requests r ON r.id=p.source_record_id AND r.organization_id=p.organization_id JOIN public.reservation_deposits d ON d.payment_id=r.payment_id AND d.organization_id=r.organization_id WHERE p.id=_payment AND p.organization_id=public.current_org_id() AND r.refund_payment_id=p.id AND r.status='settled' AND public.neo_cash_refund_payment_valid(p.id) LIMIT 1
$f$;
REVOKE ALL ON FUNCTION public.neo_refunded_deposit_id(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.neo_deposit_net_amount(_deposit uuid) RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $f$
DECLARE d public.reservation_deposits; refunds numeric;
BEGIN
 SELECT * INTO d FROM public.reservation_deposits WHERE id=_deposit AND organization_id=public.current_org_id();
 IF d.id IS NULL OR d.amount IS NULL OR d.amount<0 OR d.amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Deposit amount evidence needs review'; END IF;
 IF EXISTS(SELECT 1 FROM public.cash_refund_requests r WHERE r.organization_id=d.organization_id AND r.payment_id=d.payment_id AND r.status='settled' AND (r.branch_id IS DISTINCT FROM d.branch_id OR r.currency IS DISTINCT FROM d.currency OR NOT public.neo_cash_refund_payment_valid(r.refund_payment_id))) THEN RAISE EXCEPTION 'Deposit refund receipt and journal evidence needs reconciliation'; END IF;
 SELECT coalesce(sum(r.amount),0) INTO refunds FROM public.cash_refund_requests r WHERE r.organization_id=d.organization_id AND r.payment_id=d.payment_id AND r.status='settled';
 IF refunds>d.amount OR refunds<0 OR refunds::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Deposit refunds exceed original receipt evidence'; END IF;
 RETURN d.amount-refunds;
END $f$;
REVOKE ALL ON FUNCTION public.neo_deposit_net_amount(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.neo_refund_receipt_lock(_payment uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $f$
DECLARE org uuid:=public.current_org_id(); p public.payments; pp public.pos_payments; deposit public.reservation_deposits; oid uuid; fid uuid; booking uuid; result jsonb; delivery_invoice public.invoices;
BEGIN
 IF auth.uid() IS NULL OR org IS NULL OR public.current_access_scope() IS NULL OR public.current_access_scope()='technical' THEN RAISE EXCEPTION 'Not permitted to access refund receipts' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM public.pos_payments WHERE id=_payment AND organization_id=org) AND EXISTS(SELECT 1 FROM public.payments WHERE id=_payment AND organization_id=org) THEN RAISE EXCEPTION 'Receipt identity is ambiguous across payment modules'; END IF;
 SELECT order_id INTO oid FROM public.pos_payments WHERE id=_payment AND organization_id=org;
 IF FOUND THEN
  PERFORM 1 FROM public.pos_orders WHERE id=oid AND organization_id=org FOR UPDATE;
  SELECT * INTO pp FROM public.pos_payments WHERE id=_payment AND organization_id=org FOR UPDATE;
  IF pp.id IS NULL THEN RAISE EXCEPTION 'Original payment not found'; END IF;
  result:=jsonb_build_object('kind','pos','id',pp.id,'organization_id',org,'branch_id',pp.branch_id,'order_id',pp.order_id,'amount',pp.amount,'currency',pp.currency,'method',pp.method,'status',pp.status,'receipt_number',pp.receipt_number,'customer_id',pp.customer_id,'destination_account_id',pp.destination_account_id);
 ELSE
  SELECT * INTO p FROM public.payments WHERE id=_payment AND organization_id=org;
  IF p.source_module='delivery' THEN
   PERFORM 1 FROM public.delivery_orders WHERE id=p.source_record_id AND organization_id=org FOR UPDATE;
   IF (SELECT count(*) FROM public.invoices i WHERE i.organization_id=org AND i.notes LIKE 'delivery-order:'||p.source_record_id::text||'%')<>1 THEN RAISE EXCEPTION 'Delivery receipt requires one unambiguous invoice'; END IF;
   SELECT * INTO delivery_invoice FROM public.invoices i WHERE i.organization_id=org AND i.notes LIKE 'delivery-order:'||p.source_record_id::text||'%' FOR UPDATE;
   IF delivery_invoice.branch_id IS DISTINCT FROM p.branch_id OR delivery_invoice.currency IS DISTINCT FROM p.currency THEN RAISE EXCEPTION 'Delivery refund invoice scope needs review'; END IF;
  END IF;
  SELECT * INTO deposit FROM public.reservation_deposits WHERE payment_id=p.id AND organization_id=org;
  IF (SELECT count(*) FROM public.reservation_deposits WHERE payment_id=p.id AND organization_id=org)>1 THEN RAISE EXCEPTION 'Receipt has ambiguous deposit links'; END IF;
  fid:=coalesce(p.folio_id,CASE WHEN deposit.status='applied' THEN deposit.applied_folio_id END); booking:=coalesce(p.reservation_id,deposit.reservation_id);
  IF booking IS NULL AND fid IS NOT NULL THEN SELECT reservation_id INTO booking FROM public.folios WHERE id=fid AND organization_id=org; END IF;
  IF coalesce(booking,fid) IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended(org::text||':reservation-collection:'||coalesce(booking,fid)::text,0)); END IF;
  IF booking IS NOT NULL THEN PERFORM 1 FROM public.reservations WHERE id=booking AND organization_id=org FOR UPDATE; END IF;
  IF fid IS NOT NULL THEN PERFORM 1 FROM public.folios WHERE id=fid AND organization_id=org FOR UPDATE; END IF;
  SELECT * INTO p FROM public.payments WHERE id=_payment AND organization_id=org FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'Original payment not found'; END IF;
  IF deposit.id IS NOT NULL THEN
   SELECT * INTO deposit FROM public.reservation_deposits WHERE id=deposit.id AND organization_id=org FOR UPDATE;
   IF deposit.amount IS DISTINCT FROM p.amount OR deposit.branch_id IS DISTINCT FROM p.branch_id OR deposit.currency IS DISTINCT FROM p.currency OR deposit.status NOT IN ('held','applied') THEN RAISE EXCEPTION 'Original deposit receipt evidence needs review'; END IF;
  END IF;
  IF fid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.folios f WHERE f.id=fid AND f.organization_id=org AND f.branch_id IS NOT DISTINCT FROM p.branch_id AND f.currency=p.currency) THEN RAISE EXCEPTION 'Refund folio property and currency need review'; END IF;
  result:=jsonb_build_object('kind','folio','id',p.id,'organization_id',org,'branch_id',p.branch_id,'folio_id',fid,'reservation_id',booking,'deposit_id',deposit.id,'deposit_status',deposit.status,'amount',p.amount,'currency',p.currency,'method',p.method,'status',p.status,'receipt_number',p.receipt_number,'customer_id',p.customer_id,'destination_account_id',p.destination_account_id,'source_module',p.source_module,'source_record_id',p.source_record_id,'delivery_invoice_id',delivery_invoice.id,'posted_journal_id',p.posted_journal_id);
 END IF;
 IF nullif(result->>'branch_id','') IS NULL OR NOT coalesce(public.neo_branch_in_scope((result->>'branch_id')::uuid),false) THEN RAISE EXCEPTION 'Refund property is outside your access' USING ERRCODE='42501'; END IF;
 IF result->>'status' IS DISTINCT FROM 'confirmed' OR (result->>'amount')::numeric<=0 OR (result->>'amount')::numeric::text IN ('NaN','Infinity','-Infinity') OR nullif(result->>'currency','') IS NULL THEN RAISE EXCEPTION 'Original confirmed receipt amount and currency could not be verified'; END IF;
 IF result->>'currency' IS DISTINCT FROM public.neo_fact_currency(org,(result->>'branch_id')::uuid) THEN RAISE EXCEPTION 'Original receipt differs from the property currency'; END IF;
 RETURN result;
END $f$;
REVOKE ALL ON FUNCTION public.neo_refund_receipt_lock(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.neo_pos_refund_request(_order uuid,_payment uuid,_amount numeric,_reason text,_attempt uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $f$
DECLARE org uuid:=public.current_org_id(); p jsonb; o public.pos_orders; rid uuid; saved public.pos_refund_requests;
BEGIN
 IF NOT coalesce(public.has_permission('pos','refunds.request') OR public.has_permission('finance','till.confirm_cash') OR public.has_permission('pos','payments.record') OR public.is_org_admin(),false) THEN RAISE EXCEPTION 'Not permitted to request a payment refund' USING ERRCODE='42501'; END IF;
 IF _attempt IS NULL THEN RAISE EXCEPTION 'A refund attempt identity is required'; END IF;
 p:=public.neo_refund_receipt_lock(_payment);
 IF p->>'kind' IS DISTINCT FROM 'pos' OR (p->>'order_id')::uuid IS DISTINCT FROM _order THEN RAISE EXCEPTION 'Payment does not belong to this POS order'; END IF;
 SELECT * INTO o FROM public.pos_orders WHERE id=_order AND organization_id=org;
 IF NOT coalesce(public.in_my_scope(o.organization_id,o.branch_id,o.department_id,o.station_id,o.waiter_id,o.created_by) OR public.is_shared_with_me('pos_order',o.id) OR public.is_org_admin() OR public.has_permission('finance','approve'),false) THEN RAISE EXCEPTION 'Order is outside your normal scope'; END IF;
 rid:=public.neo_refund_reserve(_payment,_amount,_reason,'pos-refund:'||_attempt::text,auth.uid(),true,NULL);
 SELECT * INTO saved FROM public.pos_refund_requests WHERE cash_refund_request_id=rid AND organization_id=org;
 IF saved.id IS NOT NULL THEN RETURN jsonb_build_object('ok',true,'request_id',saved.id,'status',saved.status,'idempotent',true); END IF;
 INSERT INTO public.pos_refund_requests(organization_id,branch_id,order_id,payment_id,amount,method,reason,status,requested_by,cash_refund_request_id)
 VALUES(org,o.branch_id,o.id,_payment,_amount,p->>'method',btrim(_reason),'pending',auth.uid(),rid) RETURNING * INTO saved;
 RETURN jsonb_build_object('ok',true,'request_id',saved.id,'status','pending','refund_id',rid);
END $f$;
REVOKE ALL ON FUNCTION public.neo_pos_refund_request(uuid,uuid,numeric,text,uuid) FROM PUBLIC,anon;GRANT EXECUTE ON FUNCTION public.neo_pos_refund_request(uuid,uuid,numeric,text,uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_pos_refund_decide(_request uuid,_approve boolean,_note text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $f$
DECLARE org uuid:=public.current_org_id(); r public.pos_refund_requests; pid uuid; p jsonb; result jsonb; cash_id uuid;
BEGIN
 IF _approve IS NULL THEN RAISE EXCEPTION 'Choose approve or reject'; END IF;
 IF NOT coalesce(public.is_org_admin() OR public.has_permission('pos','refunds.approve') OR public.has_permission('pos','approve') OR public.has_permission('restaurant','approvals.approve') OR public.has_permission('finance','approve'),false) THEN RAISE EXCEPTION 'Not permitted to decide refunds' USING ERRCODE='42501'; END IF;
 SELECT payment_id INTO pid FROM public.pos_refund_requests WHERE id=_request AND organization_id=org;
 IF pid IS NULL THEN RAISE EXCEPTION 'Refund request not found'; END IF;
 p:=public.neo_refund_receipt_lock(pid);
 SELECT * INTO r FROM public.pos_refund_requests WHERE id=_request AND organization_id=org FOR UPDATE;
 IF r.order_id IS DISTINCT FROM (p->>'order_id')::uuid OR r.branch_id IS DISTINCT FROM (p->>'branch_id')::uuid OR r.method IS DISTINCT FROM p->>'method' THEN RAISE EXCEPTION 'Refund source order, property or tender needs review'; END IF;
 IF r.requested_by IS NOT DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'A different authorised person must decide this refund'; END IF;
 IF r.status='processed' THEN
  IF r.cash_refund_request_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.cash_refund_requests x WHERE x.id=r.cash_refund_request_id AND x.organization_id=org AND x.status='settled' AND public.neo_cash_refund_payment_valid(x.refund_payment_id)) THEN RAISE EXCEPTION 'Historical processed refund requires payout evidence reconciliation'; END IF;
  IF NOT _approve THEN RAISE EXCEPTION 'A completed refund cannot be rejected'; END IF;
  RETURN jsonb_build_object('ok',true,'status','processed','request_id',r.id,'idempotent',true);
 END IF;
 IF r.status='rejected' THEN
  IF _approve THEN RAISE EXCEPTION 'A rejected refund cannot be approved'; END IF;
  RETURN jsonb_build_object('ok',true,'status','rejected','request_id',r.id,'idempotent',true);
 END IF;
 cash_id:=r.cash_refund_request_id;
 IF cash_id IS NULL THEN
  cash_id:=public.neo_refund_reserve(r.payment_id,r.amount,r.reason,'legacy-pos-refund:'||r.id::text,r.requested_by,true,r.id);
  UPDATE public.pos_refund_requests SET cash_refund_request_id=cash_id WHERE id=r.id AND organization_id=org;
 END IF;
 result:=public.neo_cash_refund_decide(cash_id,_approve,_note);
 RETURN result||jsonb_build_object('request_id',r.id,'status',CASE WHEN _approve THEN 'approved' ELSE 'rejected' END,'payout_required',_approve,'original_receipt_unchanged',true);
END $f$;

CREATE FUNCTION public.neo_pos_refund_settle(_request uuid,_reference text,_account uuid,_completed_externally boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $f$
DECLARE org uuid:=public.current_org_id(); r public.pos_refund_requests; p jsonb;
BEGIN
 IF _completed_externally IS DISTINCT FROM true THEN RAISE EXCEPTION 'Confirm that the bank/provider has already completed this refund before recording it'; END IF;
 SELECT * INTO r FROM public.pos_refund_requests WHERE id=_request AND organization_id=org;
 IF r.id IS NULL OR r.cash_refund_request_id IS NULL THEN RAISE EXCEPTION 'Approve this refund through the guarded decision workflow first'; END IF;
 p:=public.neo_refund_receipt_lock(r.payment_id);
 IF r.status NOT IN ('approved','processed') THEN RAISE EXCEPTION 'Refund must be approved before its completed payout is recorded'; END IF;
 RETURN public.neo_refund_settle_internal(r.cash_refund_request_id,false,_reference,_account);
END $f$;
REVOKE ALL ON FUNCTION public.neo_pos_refund_settle(uuid,text,uuid,boolean) FROM PUBLIC,anon;GRANT EXECUTE ON FUNCTION public.neo_pos_refund_settle(uuid,text,uuid,boolean) TO authenticated;

REVOKE INSERT,UPDATE,DELETE ON public.pos_refund_requests,public.cash_refund_requests FROM authenticated;

CREATE FUNCTION public.neo_refund_payment_write_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $f$
DECLARE r public.cash_refund_requests; original_method text;
BEGIN
 IF NEW.source_module IS DISTINCT FROM 'cash_refund' AND (TG_OP='INSERT' OR OLD.source_module IS DISTINCT FROM 'cash_refund') THEN RETURN NEW; END IF;
 IF current_user IN ('authenticated','anon','service_role') THEN RAISE EXCEPTION 'Refund receipts can only be written by the approved payout command' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND OLD.status='confirmed' AND (to_jsonb(NEW)-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at') THEN RAISE EXCEPTION 'Confirmed refund receipts cannot be edited'; END IF;
 SELECT * INTO r FROM public.cash_refund_requests WHERE id=NEW.source_record_id AND organization_id=NEW.organization_id;
 SELECT coalesce(pp.method,p.method) INTO original_method FROM public.cash_refund_requests x LEFT JOIN public.pos_payments pp ON pp.id=x.pos_payment_id AND pp.organization_id=x.organization_id LEFT JOIN public.payments p ON p.id=x.payment_id AND p.organization_id=x.organization_id WHERE x.id=r.id;
 IF r.id IS NULL OR NEW.amount IS DISTINCT FROM -r.amount OR NEW.amount>=0 OR NEW.method IS DISTINCT FROM original_method OR NEW.branch_id IS DISTINCT FROM r.branch_id OR NEW.currency IS DISTINCT FROM r.currency OR NEW.folio_id IS DISTINCT FROM r.folio_id THEN RAISE EXCEPTION 'Refund receipt does not match its approved source'; END IF;
 IF NEW.status='draft' THEN
  IF r.status NOT IN ('approved','settled') THEN RAISE EXCEPTION 'Refund must be approved before a payout receipt is prepared'; END IF;
 ELSIF NEW.status='confirmed' THEN
  IF r.status<>'settled' OR r.refund_payment_id IS DISTINCT FROM NEW.id OR NOT public.neo_connection_journal_matches(NEW.posted_journal_id,NEW.organization_id,NEW.branch_id,NEW.currency,r.amount,'cash_refund:refund',r.id) THEN RAISE EXCEPTION 'Refund cannot be confirmed before its matching journal posts'; END IF;
 ELSE RAISE EXCEPTION 'Refund receipts use the controlled draft-to-confirmed lifecycle';
 END IF;
 RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION public.neo_refund_payment_write_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER aab_neo_refund_payment_write_guard BEFORE INSERT OR UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.neo_refund_payment_write_guard();
ALTER TABLE public.cash_movements DROP CONSTRAINT cash_movements_type_chk;
ALTER TABLE public.cash_movements ADD CONSTRAINT cash_movements_type_chk CHECK (movement_type=ANY(ARRAY['float-in','cash-sale','paid-out','petty-cash','drop','count','adjustment','pickup','float-top-up','rider-cash','refund']::text[]));

CREATE OR REPLACE FUNCTION public.neo_finance_post_txn(_source_type text, _source_id uuid, _silent boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  branch uuid; cur text; ref text; occurred date; amount numeric := 0;
  posting text := 'revenue'; lines jsonb := '[]'::jsonb; res jsonb;
  customer uuid; net numeric; tax numeric; svc numeric; settle text;
  o public.pos_orders; fl public.folio_lines; pay public.payments;
  ev public.event_bookings; inv public.invoices; si public.supplier_invoices;
  sp public.supplier_payments; lo public.guest_laundry_orders; deliv record;
  paid numeric; remainder numeric; key text; refund_deposit_source public.reservation_deposits; refund_deposit_journal uuid;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT _silent AND NOT (public.is_org_admin()
        OR public.has_permission('finance','edit') OR public.has_permission('finance','approve')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(_source_type || ':' || _source_id::text, 0));

  IF _source_type = 'pos_order' THEN
    SELECT * INTO o FROM public.pos_orders
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF o.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    IF EXISTS(SELECT 1 FROM public.delivery_orders d WHERE d.pos_order_id=o.id AND d.organization_id=org) THEN
      SELECT i.* INTO inv FROM public.invoices i JOIN public.delivery_orders d ON i.notes LIKE 'delivery-order:'||d.id::text||'%' AND i.organization_id=d.organization_id WHERE d.pos_order_id=o.id AND d.organization_id=org ORDER BY i.created_at LIMIT 1;
      IF inv.id IS NOT NULL AND inv.branch_id IS NOT DISTINCT FROM o.branch_id AND public.neo_connection_journal_matches(inv.journal_id,org,inv.branch_id,inv.currency,inv.total,'delivery_invoice',inv.id) THEN RETURN jsonb_build_object('ok',true,'journal_id',inv.journal_id,'duplicate_prevented',true,'posting_type','invoice','amount',inv.total); END IF;
      RETURN jsonb_build_object('ok',false,'reason','delivery_source_owns_posting','detail','This production order is accounted for by its linked delivery, not a second POS sale.');
    END IF;
    branch := o.branch_id; ref := o.order_number; customer := o.customer_id;
    occurred := (coalesce(o.closed_at, o.created_at))::date; amount := coalesce(o.grand_total,0);
    IF o.status NOT IN ('closed','paid','settled','completed','charged-to-room') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Order is ' || o.status || '. Draft, sent, ready and served orders are not revenue.');
    END IF;

    IF o.folio_id IS NOT NULL THEN
      posting := 'room_charge';
      res := public.neo_post_pos_order(o.id);
      PERFORM public.neo_record_posting_receipt(org, branch, 'pos', o.id, ref,
        CASE WHEN coalesce((res->>'ok')::boolean,false) THEN 'posted' ELSE 'blocked' END,
        amount, public.neo_fact_currency(org, branch), nullif(res->>'folio_line_id','')::uuid,
        'Routed to folio ' || o.folio_id::text || ' - revenue is recognised on the folio charge, not on the order.',
        NULL, occurred);
      UPDATE public.finance_posting_receipts SET posting_type = posting
        WHERE organization_id = org AND idempotency_key = 'pos:' || o.id::text;
      SELECT coalesce(res,'{}'::jsonb) || jsonb_build_object(
        'posting_type',posting,'posting_receipt_id',r.id,'folio_line_id',r.folio_line_id,'journal_id',r.journal_id,
        'ok',r.status='posted' AND r.folio_line_id IS NOT NULL AND r.journal_id IS NOT NULL,
        'reason',CASE WHEN r.status='posted' AND r.folio_line_id IS NOT NULL AND r.journal_id IS NOT NULL
                     THEN 'room_charge_reconciled' ELSE 'room_charge_journal_unverified' END)
      INTO res FROM public.finance_posting_receipts r
      WHERE r.organization_id=org AND r.idempotency_key='pos:'||o.id::text;
      RETURN coalesce(res,jsonb_build_object('ok',false,'reason','room_charge_receipt_missing'));
    END IF;

    tax := coalesce(o.tax_total,0); svc := coalesce(o.service_charge_total,0);
    amount := greatest(coalesce(o.grand_total,0),
                       coalesce(o.subtotal,0) - coalesce(o.discount_total,0));
    net := amount - tax - svc;
    IF o.corporate_account_id IS NOT NULL AND coalesce(o.paid_total,0) < amount THEN
      settle := '1060';
    ELSE
      -- The money account follows the receipt: the account the cashier chose,
      -- otherwise the account this property uses for that tender.
      SELECT public.neo_gl_account_code(org, p.method, p.destination_account_id) INTO settle
        FROM public.pos_payments p WHERE p.order_id = o.id
         AND p.status IN ('confirmed','paid','completed','captured','settled')
        ORDER BY p.amount DESC LIMIT 1;
      settle := coalesce(settle, public.neo_gl_settlement_code_for(org, 'cash'), '1010');
    END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', settle, 'debit', amount, 'description', 'Settlement ' || coalesce(ref,'')),
      jsonb_build_object('code', public.neo_gl_revenue_code_scoped(org, o.order_type, NULL), 'credit', net),
      jsonb_build_object('code', '2040', 'credit', tax, 'description', 'VAT'),
      jsonb_build_object('code', '2050', 'credit', svc, 'description', 'Service charge'));

  ELSIF _source_type = 'folio_charge' THEN
    SELECT * INTO fl FROM public.folio_lines
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF fl.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := fl.branch_id; ref := coalesce(fl.reference, fl.description); customer := fl.customer_id;
    occurred := coalesce(fl.operational_date, fl.posting_date::date);
    IF fl.status <> 'posted' OR coalesce(fl.line_type,'charge') = 'payment' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Only posted folio charges are recognised.');
    END IF;
    tax := coalesce(fl.tax_amount,0);
    svc := coalesce(fl.service_charge_amount,0);
    amount := coalesce(fl.gross_amount,0) - coalesce(fl.discount_amount,0) + tax + svc;
    net := coalesce(fl.gross_amount,0) - coalesce(fl.discount_amount,0);
    IF amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount'); END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', '1060', 'debit', amount, 'description', 'Guest ledger ' || coalesce(ref,'')),
      jsonb_build_object('code', public.neo_gl_revenue_code_scoped(org, fl.category, fl.revenue_centre), 'credit', net),
      jsonb_build_object('code', '2040', 'credit', tax, 'description', 'VAT'),
      jsonb_build_object('code', '2050', 'credit', svc, 'description', 'Service charge'));

  ELSIF _source_type = 'folio_payment' THEN
    SELECT * INTO pay FROM public.payments
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF pay.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := pay.branch_id; ref := pay.receipt_number; customer := pay.customer_id;
    occurred := coalesce(pay.paid_at, pay.created_at)::date; amount := coalesce(pay.amount,0);
    posting := 'collection';
    IF coalesce(pay.status,'') NOT IN ('confirmed','completed','paid','succeeded','captured') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Only confirmed receipts reduce the outstanding balance.');
    END IF;
    SELECT * INTO refund_deposit_source FROM public.reservation_deposits d WHERE d.payment_id=pay.id AND d.organization_id=org AND d.status IN ('held','applied');
    IF refund_deposit_source.id IS NOT NULL THEN
      IF refund_deposit_source.amount IS DISTINCT FROM amount THEN RAISE EXCEPTION 'Original deposit receipt amount differs'; END IF;
      SELECT j.id INTO refund_deposit_journal FROM public.journal_entries j WHERE public.neo_connection_journal_matches(j.id,org,branch,pay.currency,amount,'reservation_deposit:deposit',refund_deposit_source.id) LIMIT 1;
      IF refund_deposit_journal IS NULL THEN RAISE EXCEPTION 'Original deposit receipt requires its posted liability journal'; END IF;
      RETURN jsonb_build_object('ok',true,'journal_id',refund_deposit_journal,'duplicate_prevented',true,'posting_type','deposit','amount',amount);
    END IF;
    IF pay.source_module='cash_refund' THEN
      IF NOT public.neo_cash_refund_payment_valid(pay.id) THEN RAISE EXCEPTION 'Refund receipt requires its settled original-receipt link and matching posted journal'; END IF;
      PERFORM public.neo_record_posting_receipt(org,branch,_source_type,_source_id,ref,'posted',amount,pay.currency,NULL,'Verified separately linked refund payout journal',NULL,occurred);
      UPDATE public.finance_posting_receipts SET posting_type='refund',journal_id=pay.posted_journal_id WHERE organization_id=org AND source_module=_source_type AND source_id=_source_id;
      RETURN jsonb_build_object('ok',true,'journal_id',pay.posted_journal_id,'duplicate_prevented',true,'amount',amount,'posting_type','refund');
    END IF;
    IF pay.source_module='delivery' AND pay.posted_journal_id IS NOT NULL THEN
      IF NOT EXISTS(SELECT 1 FROM public.journal_entries j WHERE j.id=pay.posted_journal_id AND j.organization_id=org AND j.branch_id IS NOT DISTINCT FROM branch AND j.status='posted' AND j.source_module='delivery' AND j.source_document_type='delivery_payment' AND j.source_document_id=pay.id AND j.currency=pay.currency AND j.total_debit=amount AND j.total_credit=amount AND amount>0 AND amount::text NOT IN ('NaN','Infinity','-Infinity') AND NOT EXISTS(SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_id=j.id AND (l.organization_id IS DISTINCT FROM org OR l.branch_id IS DISTINCT FROM branch)) AND (SELECT coalesce(sum(l.debit),0) FROM public.journal_entry_lines l WHERE l.journal_id=j.id)=amount AND (SELECT coalesce(sum(l.credit),0) FROM public.journal_entry_lines l WHERE l.journal_id=j.id)=amount) THEN RAISE EXCEPTION 'Delivery payment journal evidence is incomplete'; END IF;
      PERFORM public.neo_record_posting_receipt(org,branch,_source_type,_source_id,ref,'posted',amount,pay.currency,NULL,'Existing delivery receipt journal verified',NULL,occurred);
      UPDATE public.finance_posting_receipts SET posting_type='collection',journal_id=pay.posted_journal_id WHERE organization_id=org AND source_module=_source_type AND source_id=_source_id;
      RETURN jsonb_build_object('ok',true,'journal_id',pay.posted_journal_id,'duplicate_prevented',true,'amount',amount,'posting_type','collection');
    END IF;
    IF amount = 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount'); END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', public.neo_gl_account_code(org, pay.method, pay.destination_account_id),
                         'debit', amount, 'description', 'Receipt ' || coalesce(ref,'')),
      jsonb_build_object('code', '1060', 'credit', amount, 'description', 'Guest / customer ledger'));

  ELSIF _source_type = 'event_deposit' THEN
    SELECT * INTO ev FROM public.event_bookings
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF ev.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := ev.branch_id; ref := ev.event_reference; customer := ev.customer_id;
    occurred := coalesce(ev.confirmed_at::date, ev.event_date); posting := 'deposit';
    amount := coalesce(ev.deposit_paid, 0);
    IF amount <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'No deposit has been received. Forecast is never revenue.');
    END IF;
    SELECT public.neo_gl_account_code(org, p.method, p.destination_account_id) INTO settle
      FROM public.payments p
     WHERE p.organization_id = org AND p.source_module = 'events' AND p.source_record_id = ev.id
       AND coalesce(p.status,'') IN ('confirmed','completed','paid','succeeded','captured')
     ORDER BY p.amount DESC LIMIT 1;
    settle := coalesce(settle, public.neo_gl_settlement_code_for(org, 'cash'), '1010');
    lines := jsonb_build_array(
      jsonb_build_object('code', settle, 'debit', amount, 'description', 'Event deposit ' || coalesce(ref,'')),
      jsonb_build_object('code', '2030', 'credit', amount, 'description', 'Event deposit held'));

  ELSIF _source_type = 'event_invoice' THEN
    SELECT * INTO inv FROM public.invoices
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF inv.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := inv.branch_id; ref := inv.invoice_number; customer := inv.customer_id;
    occurred := inv.issue_date; posting := 'invoice'; amount := coalesce(inv.total,0);
    IF coalesce(inv.status,'draft') NOT IN ('issued','sent','partially_paid','paid','overdue') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Draft and cancelled invoices are not receivables.');
    END IF;
    IF inv.notes LIKE 'delivery-order:%' THEN
      IF NOT public.neo_connection_journal_matches(inv.journal_id,org,branch,inv.currency,amount,'delivery_invoice',inv.id) THEN RAISE EXCEPTION 'Delivery invoice journal evidence needs review'; END IF;
      RETURN jsonb_build_object('ok',true,'journal_id',inv.journal_id,'duplicate_prevented',true,'posting_type','invoice','amount',amount);
    END IF;
    net := coalesce(inv.subtotal,0) - coalesce(inv.discount_total,0);
    lines := jsonb_build_array(
      jsonb_build_object('code', '1060', 'debit', amount, 'description', 'Invoice ' || coalesce(ref,'')),
      jsonb_build_object('code', CASE WHEN inv.event_booking_id IS NOT NULL THEN public.neo_gl_revenue_code_scoped(org, 'events', NULL) ELSE '4090' END,
                         'credit', net),
      jsonb_build_object('code', '2050', 'credit', coalesce(inv.service_charge_total,0),
                         'description', 'Service charge'),
      jsonb_build_object('code', '2040', 'credit', coalesce(inv.tax_total,0), 'description', 'VAT'));

  ELSIF _source_type = 'event_earned' THEN
    SELECT * INTO ev FROM public.event_bookings
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF ev.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := ev.branch_id; ref := ev.event_reference; customer := ev.customer_id;
    occurred := ev.event_date; posting := 'earned'; amount := coalesce(ev.total_amount,0);
    IF ev.status NOT IN ('completed','closed') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Event is ' || ev.status || '. Confirmed and provisional bookings are forecast, not revenue.');
    END IF;
    IF amount <= 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount'); END IF;
    paid := least(coalesce(ev.deposit_paid,0), amount);
    remainder := amount - paid;
    lines := jsonb_build_array(
      jsonb_build_object('code', '2030', 'debit', paid, 'description', 'Deposit applied'),
      jsonb_build_object('code', '1060', 'debit', remainder, 'description', 'Event receivable'),
      jsonb_build_object('code', public.neo_gl_revenue_code_scoped(org, 'events', NULL), 'credit', amount, 'description', 'Event revenue ' || coalesce(ref,'')));

  ELSIF _source_type = 'event_cancellation' THEN
    SELECT * INTO ev FROM public.event_bookings
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF ev.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := ev.branch_id; ref := ev.event_reference; customer := ev.customer_id;
    occurred := coalesce(ev.cancelled_at::date, ev.event_date); posting := 'cancellation';
    IF ev.status <> 'cancelled' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle');
    END IF;
    PERFORM public.neo_finance_reverse_posting('event_earned', ev.id, 'earned', 'Event cancelled');
    amount := coalesce(ev.cancellation_fee, 0);
    paid := coalesce(ev.deposit_paid, 0);
    remainder := greatest(paid - amount, 0);
    IF amount = 0 AND remainder = 0 THEN
      RETURN jsonb_build_object('ok', true, 'reason', 'nothing_to_recognise');
    END IF;
    SELECT public.neo_gl_account_code(org, p.method, p.destination_account_id) INTO settle
      FROM public.payments p
     WHERE p.organization_id = org AND p.source_module = 'events' AND p.source_record_id = ev.id
     ORDER BY p.amount DESC LIMIT 1;
    settle := coalesce(settle, public.neo_gl_settlement_code_for(org, 'cash'), '1010');
    lines := jsonb_build_array(
      jsonb_build_object('code', '2030', 'debit', paid, 'description', 'Deposit released'),
      jsonb_build_object('code', '1060', 'debit', greatest(amount - paid, 0),
                         'description', 'Cancellation receivable'),
      jsonb_build_object('code', public.neo_gl_revenue_code_scoped(org, 'events', NULL), 'credit', amount, 'description', 'Cancellation fee ' || coalesce(ref,'')),
      jsonb_build_object('code', settle, 'credit', remainder, 'description', 'Refund to client'));
    amount := greatest(amount, paid);

  ELSIF _source_type = 'delivery_order' THEN
    SELECT d.id, d.branch_id, d.order_number, d.customer_id, d.grand_total, d.tax_total,
           d.order_status, d.payment_status, d.payment_method, d.delivered_at, d.created_at
      INTO deliv FROM public.delivery_orders d
      WHERE d.id = _source_id AND d.organization_id = org FOR UPDATE;
    IF deliv.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := deliv.branch_id; ref := deliv.order_number; customer := deliv.customer_id;
    occurred := coalesce(deliv.delivered_at, deliv.created_at)::date;
    amount := coalesce(deliv.grand_total,0); tax := coalesce(deliv.tax_total,0);
    IF deliv.order_status NOT IN ('delivered','completed') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Only completed deliveries are recognised.');
    END IF;
    SELECT * INTO inv FROM public.invoices i WHERE i.organization_id=org AND i.notes LIKE 'delivery-order:'||deliv.id::text||'%' ORDER BY i.created_at LIMIT 1;
    IF inv.id IS NOT NULL THEN
      IF inv.branch_id IS DISTINCT FROM branch OR inv.currency IS DISTINCT FROM public.neo_fact_currency(org,branch) OR inv.total IS DISTINCT FROM amount OR NOT public.neo_connection_journal_matches(inv.journal_id,org,branch,inv.currency,amount,'delivery_invoice',inv.id) THEN RAISE EXCEPTION 'Completed delivery invoice evidence needs review'; END IF;
      RETURN jsonb_build_object('ok',true,'journal_id',inv.journal_id,'duplicate_prevented',true,'posting_type','invoice','amount',amount);
    END IF;
    IF deliv.payment_status IN ('paid','settled','completed') THEN
      SELECT public.neo_gl_account_code(org, coalesce(p.method, deliv.payment_method), p.destination_account_id)
        INTO settle
        FROM public.payments p
       WHERE p.organization_id = org AND p.source_module = 'delivery' AND p.source_record_id = deliv.id
         AND coalesce(p.status,'') IN ('confirmed','completed','paid','succeeded','captured')
       ORDER BY p.amount DESC LIMIT 1;
      settle := coalesce(settle, public.neo_gl_account_code(org, deliv.payment_method, NULL), '1010');
    ELSE
      settle := '1060';
    END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', settle, 'debit', amount, 'description', 'Delivery ' || coalesce(ref,'')),
      jsonb_build_object('code', '4070', 'credit', amount - tax),
      jsonb_build_object('code', '2040', 'credit', tax, 'description', 'VAT'));

  ELSIF _source_type = 'laundry_order' THEN
    SELECT * INTO lo FROM public.guest_laundry_orders
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF lo.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := lo.branch_id; ref := lo.laundry_number;
    occurred := coalesce(lo.delivered_at, lo.created_at)::date; amount := coalesce(lo.total,0);
    IF lo.status NOT IN ('delivered','completed','closed') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Only completed laundry orders are recognised.');
    END IF;
    IF lo.folio_id IS NULL AND (lo.reservation_id IS NOT NULL OR lo.resident IS TRUE) THEN
      RETURN jsonb_build_object('ok',false,'reason','resident_laundry_missing_folio',
        'detail','Resident laundry must reach a guest folio; it cannot be treated as an assumed cash collection.');
    END IF;
    IF lo.folio_id IS NOT NULL THEN
      posting := 'folio_charge';
      res := public.laundry_post_charge(lo.id);
      PERFORM public.neo_record_posting_receipt(org, branch, 'laundry', lo.id, ref,
        CASE WHEN coalesce((res->>'ok')::boolean,false) THEN 'posted' ELSE 'blocked' END,
        amount, public.neo_fact_currency(org, branch), nullif(res->>'folio_line_id','')::uuid,
        'Charged to the guest folio - revenue is recognised on the folio charge.', NULL, occurred);
      UPDATE public.finance_posting_receipts SET posting_type = posting
        WHERE organization_id = org AND source_module = 'laundry' AND source_id = lo.id;
      RETURN coalesce(res,'{}'::jsonb) || jsonb_build_object('posting_type', posting);
    END IF;
    tax := coalesce(lo.tax_amount,0);
    settle := coalesce(public.neo_gl_settlement_code_for(org, 'cash'), '1010');
    lines := jsonb_build_array(
      jsonb_build_object('code', settle, 'debit', amount, 'description', 'Laundry ' || coalesce(ref,'')),
      jsonb_build_object('code', public.neo_gl_revenue_code_scoped(org, 'laundry', NULL), 'credit', amount - tax),
      jsonb_build_object('code', '2040', 'credit', tax, 'description', 'VAT'));

  ELSIF _source_type = 'supplier_invoice' THEN
    SELECT * INTO si FROM public.supplier_invoices
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF si.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := si.branch_id; ref := si.invoice_number; occurred := si.invoice_date;
    amount := coalesce(si.amount,0); tax := coalesce(si.tax_amount,0); posting := 'payable';
    IF si.approved_at IS NULL OR si.status NOT IN ('approved','matched','partially_paid','paid') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle',
        'detail', 'Only approved supplier invoices become payables. Requests and purchase orders do not.');
    END IF;
    lines := jsonb_build_array(
      jsonb_build_object('code', '1070', 'debit', amount - tax, 'description', 'Goods / services received'),
      jsonb_build_object('code', '2040', 'debit', tax, 'description', 'Input VAT'),
      jsonb_build_object('code', '2010', 'credit', amount, 'description', 'Supplier invoice ' || coalesce(ref,'')));

  ELSIF _source_type = 'supplier_payment' THEN
    SELECT * INTO sp FROM public.supplier_payments
      WHERE id = _source_id AND organization_id = org FOR UPDATE;
    IF sp.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    branch := sp.branch_id; ref := sp.payment_number; occurred := sp.paid_on;
    amount := coalesce(sp.amount,0); posting := 'payable_payment';
    IF sp.status NOT IN ('paid','completed','settled') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_lifecycle');
    END IF;
    -- Money leaves the account the hotel actually paid from.
    lines := jsonb_build_array(
      jsonb_build_object('code', '2010', 'debit', amount, 'description', 'Supplier payment ' || coalesce(ref,'')),
      jsonb_build_object('code', public.neo_gl_account_code(org, sp.method, sp.bank_account_id),
                         'credit', amount));

  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_source_type');
  END IF;

  cur := public.neo_fact_currency(org, branch);
  occurred := coalesce(occurred, (now() AT TIME ZONE public.neo_fact_timezone(org, branch))::date);
  key := _source_type || ':' || _source_id::text || ':' || posting;

  res := public.neo_gl_post(org, branch, split_part(_source_type,'_',1), _source_type, _source_id,
                            posting, occurred, cur,
                            initcap(replace(_source_type,'_',' ')) || ' ' || coalesce(ref,''),
                            lines, customer, NULL);

  -- A duplicate key or ok flag alone is not evidence of a completed posting.
  IF res->>'ok' IS DISTINCT FROM 'true' OR NOT EXISTS(
    SELECT 1 FROM public.journal_entries j
    CROSS JOIN LATERAL(SELECT coalesce(sum(l.debit),0) AS d,coalesce(sum(l.credit),0) AS c
      FROM public.journal_entry_lines l WHERE l.journal_id=j.id) actual
    WHERE j.id=nullif(res->>'journal_id','')::uuid AND j.organization_id=org
      AND j.branch_id IS NOT DISTINCT FROM branch AND j.status='posted'
      AND j.reversed_by_journal_id IS NULL AND j.currency=cur
      AND j.source_document_id=_source_id AND j.source_document_type=_source_type||':'||posting
      AND actual.d=round(amount,2) AND actual.c=round(amount,2)
      AND j.total_debit=actual.d AND j.total_credit=actual.c
      AND NOT EXISTS(SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_id=j.id
        AND (l.organization_id IS DISTINCT FROM org OR l.branch_id IS DISTINCT FROM branch))
  ) THEN
    RAISE EXCEPTION 'Posting did not produce a matching balanced posted journal' USING ERRCODE='23514';
  END IF;

  PERFORM public.neo_record_posting_receipt(org, branch, _source_type, _source_id, ref,
    'posted', amount, cur, NULL,
    CASE WHEN coalesce((res->>'duplicate_prevented')::boolean,false)
         THEN 'Duplicate replay prevented - the existing journal was reused.'
         ELSE 'Posted to journal ' || (res->>'journal_id') END,
    NULL, occurred);

  UPDATE public.finance_posting_receipts
     SET posting_type = posting, journal_id = (res->>'journal_id')::uuid
   WHERE organization_id = org AND source_module = _source_type AND source_id = _source_id;

  PERFORM public.emit_domain_event(org, branch, 'finance.posted', _source_type, _source_id,
    jsonb_build_object('posting_type', posting, 'amount', amount, 'currency', cur,
                       'journal_id', res->>'journal_id', 'occurred_on', occurred),
    'finance.posted:' || key, customer);

  RETURN res || jsonb_build_object('source_type', _source_type, 'source_id', _source_id,
                                   'posting_type', posting, 'amount', amount);
EXCEPTION WHEN OTHERS THEN
  PERFORM public.neo_record_posting_receipt(org, branch, _source_type, _source_id, ref,
    'failed', amount, coalesce(cur,'KES'), NULL, NULL, SQLERRM, occurred);
  IF _silent THEN RETURN jsonb_build_object('ok', false, 'reason', 'failed', 'detail', SQLERRM); END IF;
  RAISE;
END $function$
;

CREATE OR REPLACE FUNCTION public.neo_reservation_collection_facts(_reservation uuid, _exclude_payment uuid DEFAULT NULL::uuid, _exclude_request uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE booking public.reservations; cur text; deposits numeric:=0; collected numeric:=0; pending numeric:=0; cash_pending numeric:=0; room_charges numeric:=0; extras numeric:=0; obligation numeric; required numeric;
BEGIN
 SELECT * INTO booking FROM public.reservations WHERE id=_reservation AND organization_id=public.current_org_id();
 IF booking.id IS NULL THEN RAISE EXCEPTION 'Reservation not found in the active workspace'; END IF;
 cur:=public.neo_fact_currency(booking.organization_id,booking.branch_id);
 IF nullif(btrim(cur),'') IS NULL THEN RAISE EXCEPTION 'Property currency could not be verified'; END IF;
 IF booking.total_amount IS NULL OR booking.total_amount<0 OR booking.total_amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Reservation quote is incomplete or non-finite'; END IF;
 IF EXISTS(SELECT 1 FROM public.reservation_deposits d WHERE d.reservation_id=booking.id AND d.organization_id=booking.organization_id AND d.status IN ('held','applied') AND (d.branch_id IS DISTINCT FROM booking.branch_id OR d.currency IS DISTINCT FROM cur OR d.amount IS NULL OR d.amount<=0 OR d.amount::text IN ('NaN','Infinity','-Infinity'))) THEN RAISE EXCEPTION 'Deposit amount, property or currency evidence needs review'; END IF;
 IF EXISTS(SELECT 1 FROM public.folios f WHERE f.reservation_id=booking.id AND f.organization_id=booking.organization_id AND f.status NOT IN ('void','voided','cancelled') AND (f.branch_id IS DISTINCT FROM booking.branch_id OR f.currency IS DISTINCT FROM cur)) THEN RAISE EXCEPTION 'Reservation folio properties or currencies differ'; END IF;
 IF EXISTS(SELECT 1 FROM public.reservation_deposits d LEFT JOIN public.payments p ON p.id=d.payment_id AND p.organization_id=d.organization_id WHERE d.organization_id=booking.organization_id AND d.reservation_id=booking.id AND d.status IN ('held','applied') AND d.payment_id IS NOT NULL AND (p.id IS NULL OR p.amount IS DISTINCT FROM d.amount OR p.currency IS DISTINCT FROM d.currency OR p.branch_id IS DISTINCT FROM d.branch_id OR p.status NOT IN ('confirmed','completed','posted','paid','settled','succeeded','captured'))) THEN RAISE EXCEPTION 'Deposit lacks matching confirmed linked-payment evidence'; END IF;
 IF EXISTS(SELECT 1 FROM public.payments p WHERE p.organization_id=booking.organization_id AND p.status IN ('confirmed','completed','posted','paid','settled','succeeded','captured','pending','processing','submitted','initiated') AND ((p.folio_id IS NULL AND p.reservation_id=booking.id) OR EXISTS(SELECT 1 FROM public.folios f WHERE f.id=p.folio_id AND f.reservation_id=booking.id AND f.organization_id=booking.organization_id AND f.status NOT IN ('void','voided','cancelled'))) AND (p.branch_id IS DISTINCT FROM booking.branch_id OR p.currency IS DISTINCT FROM cur OR p.amount IS NULL OR (p.amount=0 OR (p.amount<0 AND NOT public.neo_cash_refund_payment_valid(p.id))) OR p.amount::text IN ('NaN','Infinity','-Infinity'))) THEN RAISE EXCEPTION 'Payment amount, property or currency evidence needs review'; END IF;
 SELECT coalesce(sum(public.neo_deposit_net_amount(d.id)),0) INTO deposits FROM public.reservation_deposits d WHERE d.reservation_id=booking.id AND d.organization_id=booking.organization_id AND d.branch_id IS NOT DISTINCT FROM booking.branch_id AND d.status IN ('held','applied');
 SELECT coalesce(sum(p.amount) FILTER(WHERE p.status IN ('confirmed','completed','posted','paid','settled','succeeded','captured')),0),coalesce(sum(p.amount) FILTER(WHERE p.status IN ('pending','processing','submitted','initiated')),0) INTO collected,pending FROM public.payments p WHERE p.organization_id=booking.organization_id AND p.branch_id IS NOT DISTINCT FROM booking.branch_id AND p.id IS DISTINCT FROM _exclude_payment AND ((p.folio_id IS NULL AND p.reservation_id=booking.id) OR EXISTS(SELECT 1 FROM public.folios f WHERE f.id=p.folio_id AND f.reservation_id=booking.id AND f.organization_id=booking.organization_id AND f.status NOT IN ('void','voided','cancelled'))) AND public.neo_refunded_deposit_id(p.id) IS NULL AND NOT EXISTS(SELECT 1 FROM public.reservation_deposits d WHERE d.payment_id=p.id AND d.organization_id=p.organization_id AND d.reservation_id=booking.id AND d.status IN ('held','applied'));
 SELECT coalesce(sum(fl.net_amount) FILTER(WHERE fl.category='accommodation'),0),coalesce(sum(fl.net_amount) FILTER(WHERE fl.category IS DISTINCT FROM 'accommodation'),0) INTO room_charges,extras FROM public.folio_lines fl JOIN public.folios f ON f.id=fl.folio_id AND f.organization_id=fl.organization_id WHERE f.reservation_id=booking.id AND f.organization_id=booking.organization_id AND f.branch_id IS NOT DISTINCT FROM booking.branch_id AND f.status NOT IN ('void','voided','cancelled') AND coalesce(fl.status,'posted') NOT IN ('void','voided','reversed','cancelled') AND coalesce(fl.line_type,'charge') NOT IN ('payment','deposit','refund');
 IF EXISTS(SELECT 1 FROM public.cash_payment_requests r JOIN public.folios f ON f.id=r.folio_id AND f.organization_id=r.organization_id WHERE f.reservation_id=booking.id AND f.organization_id=booking.organization_id AND r.status='pending' AND (r.branch_id IS DISTINCT FROM booking.branch_id OR r.currency IS DISTINCT FROM cur OR r.amount IS NULL OR r.amount<=0 OR r.amount::text IN ('NaN','Infinity','-Infinity'))) THEN RAISE EXCEPTION 'Pending cash amount, property or currency needs review'; END IF;
 SELECT coalesce(sum(r.amount),0) INTO cash_pending FROM public.cash_payment_requests r WHERE r.organization_id=booking.organization_id AND r.branch_id IS NOT DISTINCT FROM booking.branch_id AND r.status='pending' AND r.id IS DISTINCT FROM _exclude_request AND EXISTS(SELECT 1 FROM public.folios f WHERE f.id=r.folio_id AND f.reservation_id=booking.id AND f.organization_id=booking.organization_id AND f.status NOT IN ('void','voided','cancelled'));
 IF deposits::text IN ('NaN','Infinity','-Infinity') OR collected::text IN ('NaN','Infinity','-Infinity') OR pending::text IN ('NaN','Infinity','-Infinity') OR cash_pending::text IN ('NaN','Infinity','-Infinity') OR room_charges::text IN ('NaN','Infinity','-Infinity') OR extras::text IN ('NaN','Infinity','-Infinity') OR pending<0 OR cash_pending<0 THEN RAISE EXCEPTION 'Reservation collection amounts are incomplete or non-finite'; END IF;
 collected:=collected+deposits;
 obligation:=greatest(0,CASE WHEN booking.status IN ('cancelled','no-show','checked-out','checked_out','departed') THEN room_charges+extras ELSE greatest(booking.total_amount,room_charges)+extras END);
 required:=coalesce(booking.deposit_required,0);
 IF required<0 OR required::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Deposit requirement is invalid'; END IF;
 RETURN jsonb_build_object('reservation_id',booking.id,'currency',cur,'quote',booking.total_amount,'posted_room_charges',room_charges,'posted_extras',extras,'obligation',round(obligation,2),'deposit_paid',deposits,'collected',round(collected,2),'pending',round(pending+cash_pending,2),'outstanding',round(greatest(obligation-collected,0),2),'credit',round(greatest(collected-obligation,0),2),'headroom',round(greatest(obligation-collected-pending-cash_pending,0),2),'payment_status',CASE WHEN collected<=0 THEN 'unpaid' WHEN obligation>0 AND collected+0.009>=obligation THEN 'paid' ELSE 'part-paid' END,'minimum_deposit_satisfied',required>0 AND deposits+0.009>=required);
END $function$
;

CREATE OR REPLACE FUNCTION public.neo_reservation_deposit_position(_reservation uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _res public.reservations;
  _held numeric := 0; _applied numeric := 0; _required numeric := 0;
  _waiver text := NULL; _override uuid; _policy jsonb; _policy_amount numeric := 0;
  _source text := 'reservation';
BEGIN
  SELECT * INTO _res FROM public.reservations WHERE id=_reservation AND organization_id=_org;
  IF _res.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'Reservation not found'); END IF;

  SELECT COALESCE(sum(public.neo_deposit_net_amount(id)) FILTER (WHERE status='held'),0),
         COALESCE(sum(public.neo_deposit_net_amount(id)) FILTER (WHERE status='applied'),0)
    INTO _held, _applied
  FROM public.reservation_deposits WHERE reservation_id=_reservation AND organization_id=_org;

  _policy := public.neo_deposit_policy_for(_reservation);
  _policy_amount := COALESCE((_policy->>'amount')::numeric, 0);
  _required := COALESCE(_res.deposit_required, 0);
  IF _required <= 0 AND _policy_amount > 0 THEN
    _required := _policy_amount;
    _source := 'policy';
  END IF;

  IF _res.corporate_account_id IS NOT NULL THEN _waiver := 'corporate-credit'; END IF;

  SELECT id INTO _override FROM public.checkin_deposit_overrides
   WHERE reservation_id=_reservation AND consumed_at IS NULL
   ORDER BY created_at DESC LIMIT 1;

  RETURN jsonb_build_object(
    'ok', true,
    'reservation_id', _reservation,
    'currency', public.neo_fact_currency(_org,_res.branch_id),
    'required', _required,
    'required_source', _source,
    'policy_id', _policy->>'policy_id',
    'policy_name', _policy->>'policy_name',
    'policy_reason', _policy->>'reason',
    'policy_amount', _policy_amount,
    'held', _held,
    'applied', _applied,
    'paid', _held + _applied,
    'outstanding', GREATEST(_required - (_held + _applied), 0),
    'waiver', _waiver,
    'override_id', _override,
    'may_check_in', (_required - (_held + _applied)) <= 0.009 OR _waiver IS NOT NULL OR _override IS NOT NULL
  );
END $function$

;

CREATE OR REPLACE FUNCTION public.pms_apply_deposits_to_folio()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _d record; _line uuid; _net numeric; _post jsonb;
BEGIN
  IF NEW.reservation_id IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text||':reservation-collection:'||NEW.reservation_id::text,0));
  PERFORM 1 FROM public.reservations WHERE id=NEW.reservation_id AND organization_id=NEW.organization_id FOR UPDATE;
  FOR _d IN SELECT * FROM public.reservation_deposits
             WHERE reservation_id = NEW.reservation_id AND organization_id=NEW.organization_id AND status = 'held' ORDER BY id FOR UPDATE
  LOOP
    IF _d.branch_id IS DISTINCT FROM NEW.branch_id OR _d.currency IS DISTINCT FROM NEW.currency THEN RAISE EXCEPTION 'Deposit and folio property/currency differ'; END IF;
    _net:=public.neo_deposit_net_amount(_d.id);
    IF _net=0 THEN CONTINUE; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.journal_entries j WHERE public.neo_connection_journal_matches(j.id,_d.organization_id,_d.branch_id,_d.currency,_d.amount,'reservation_deposit:deposit',_d.id)) THEN RAISE EXCEPTION 'Deposit must have its original posted liability journal before folio application'; END IF;
    _post:=public.neo_gl_post(_d.organization_id,_d.branch_id,'pms','deposit_application',_d.id,'application',(now() AT TIME ZONE public.neo_fact_timezone(_d.organization_id,_d.branch_id))::date,_d.currency,'Apply pre-arrival deposit to folio',jsonb_build_array(jsonb_build_object('code','2020','debit',_net,'credit',0),jsonb_build_object('code','1060','debit',0,'credit',_net)),_d.customer_id,NULL);
    IF _post->>'ok' IS DISTINCT FROM 'true' OR NOT public.neo_connection_journal_matches(nullif(_post->>'journal_id','')::uuid,_d.organization_id,_d.branch_id,_d.currency,_net,'deposit_application:application',_d.id) THEN RAISE EXCEPTION 'Deposit application journal did not post'; END IF;
    INSERT INTO public.folio_lines (organization_id, branch_id, folio_id, reservation_id, line_type,
      category, source_module, description, operational_date, quantity, unit_price,
      gross_amount, net_amount, posted_by)
    VALUES (NEW.organization_id, NEW.branch_id, NEW.id, NEW.reservation_id, 'payment', 'payment', 'pms',
      'Pre-arrival deposit' || COALESCE(' · ' || _d.reference, ''), current_date, 1, _net,
      _net, _net, auth.uid())
    RETURNING id INTO _line;

    UPDATE public.reservation_deposits
       SET status='applied', applied_folio_id=NEW.id, applied_folio_line_id=_line, applied_at=now()
     WHERE id=_d.id;

    -- A deposit applied to the folio is money already banked: it must reduce
    -- what the guest owes, not sit on the folio as an unreconciled line.
    UPDATE public.folios
       SET total_payments = COALESCE(total_payments,0) + _net,
           balance = COALESCE(balance,0) - _net,
           updated_at = now()
     WHERE id = NEW.id;
  END LOOP;
  RETURN NEW;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.neo_cash_refunds(_branch uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', r.id, 'amount', r.amount, 'currency', r.currency, 'reason', r.reason, 'status', r.status,
    'requires_approval', r.requires_approval, 'original_receipt_number', r.original_receipt_number,
    'payment_id', COALESCE(r.payment_id, r.pos_payment_id), 'folio_id', r.folio_id,
    'refund_receipt_number', r.refund_receipt_number, 'refund_payment_id', r.refund_payment_id,
    'requested_by_name', COALESCE(qp.full_name,'—'), 'approved_by_name', ap.full_name,
    'decision_note', r.decision_note, 'created_at', r.created_at, 'settled_at', r.settled_at,
    'mine', (r.requested_by = auth.uid()), 'can_approve',coalesce(public.has_permission('finance','approve') OR public.has_permission('finance','payment.approve') OR public.has_permission('pos','refunds.approve') OR public.has_permission('pos','approve') OR public.has_permission('restaurant','approvals.approve') OR public.is_org_admin(),false),'can_settle',coalesce(public.has_permission('finance','payments','refund_payment') OR public.is_org_admin(),false)
  ) ORDER BY r.created_at DESC), '[]'::jsonb)
  FROM public.cash_refund_requests r
  LEFT JOIN public.payments original_folio ON original_folio.id=r.payment_id AND original_folio.organization_id=r.organization_id
  LEFT JOIN public.pos_payments original_pos ON original_pos.id=r.pos_payment_id AND original_pos.organization_id=r.organization_id
  LEFT JOIN public.profiles qp ON qp.id = r.requested_by
  LEFT JOIN public.profiles ap ON ap.id = r.approved_by
  WHERE r.organization_id = public.current_org_id() AND coalesce(public.has_permission('finance','view') OR public.has_permission('finance','till.confirm_cash') OR public.has_permission('finance','approve') OR public.has_permission('pos','refunds.approve') OR public.is_org_admin(),false) AND auth.uid() IS NOT NULL AND public.current_access_scope() IS DISTINCT FROM 'technical' AND r.branch_id IS NOT NULL AND coalesce(public.neo_branch_in_scope(r.branch_id),false) AND coalesce(original_pos.method,original_folio.method)='cash'
    AND (_branch IS NULL OR r.branch_id IS NULL OR r.branch_id = _branch)
    AND r.created_at > now() - interval '90 days';
$function$
;

CREATE FUNCTION public.neo_pos_refund_position(_order uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $f$
DECLARE o public.pos_orders; result jsonb;
BEGIN
 IF auth.uid() IS NULL OR public.current_org_id() IS NULL OR public.current_access_scope() IS NULL OR public.current_access_scope()='technical' THEN RAISE EXCEPTION 'An authorised staff workspace is required'; END IF;
 SELECT * INTO o FROM public.pos_orders WHERE id=_order AND organization_id=public.current_org_id();
 IF o.id IS NULL OR NOT coalesce(public.neo_branch_in_scope(o.branch_id),false) OR NOT coalesce(public.in_my_scope(o.organization_id,o.branch_id,o.department_id,o.station_id,o.waiter_id,o.created_by) OR public.is_shared_with_me('pos_order',o.id) OR public.is_org_admin() OR public.has_permission('finance','approve'),false) THEN RAISE EXCEPTION 'Order is outside your normal scope'; END IF;
 IF EXISTS(SELECT 1 FROM public.cash_refund_requests r JOIN public.pos_payments p ON p.id=r.pos_payment_id AND p.organization_id=r.organization_id WHERE p.order_id=o.id AND r.organization_id=o.organization_id AND (r.amount IS NULL OR r.amount<=0 OR r.amount::text IN ('NaN','Infinity','-Infinity'))) THEN RAISE EXCEPTION 'Refund amounts require reconciliation'; END IF;
 SELECT jsonb_build_object('order_id',o.id,'payments',coalesce(jsonb_agg(jsonb_build_object('id',p.id,'receipt_number',p.receipt_number,'amount',p.amount,'method',p.method,'status',p.status,'destination_account_id',p.destination_account_id,'refunded',coalesce((SELECT sum(r.amount) FROM public.cash_refund_requests r WHERE r.pos_payment_id=p.id AND r.organization_id=p.organization_id AND r.status='settled' AND public.neo_cash_refund_payment_valid(r.refund_payment_id)),0),'reserved',coalesce((SELECT sum(r.amount) FROM public.cash_refund_requests r WHERE r.pos_payment_id=p.id AND r.organization_id=p.organization_id AND r.status IN ('pending_approval','approved','settled')),0),'legacy_review',EXISTS(SELECT 1 FROM public.pos_refund_requests x WHERE x.payment_id=p.id AND x.organization_id=p.organization_id AND x.status IN ('pending','approved','processed') AND x.cash_refund_request_id IS NULL),'refundable',CASE WHEN p.status<>'confirmed' OR EXISTS(SELECT 1 FROM public.pos_refund_requests x WHERE x.payment_id=p.id AND x.organization_id=p.organization_id AND x.status IN ('pending','approved','processed') AND x.cash_refund_request_id IS NULL) THEN 0 ELSE greatest(p.amount-coalesce((SELECT sum(r.amount) FROM public.cash_refund_requests r WHERE r.pos_payment_id=p.id AND r.organization_id=p.organization_id AND r.status IN ('pending_approval','approved','settled')),0),0) END) ORDER BY p.created_at,p.id),'[]'::jsonb)) INTO result FROM public.pos_payments p WHERE p.order_id=o.id AND p.organization_id=o.organization_id AND p.status IN ('confirmed','refunded');
 RETURN result;
END $f$;
REVOKE ALL ON FUNCTION public.neo_pos_refund_position(uuid) FROM PUBLIC,anon;GRANT EXECUTE ON FUNCTION public.neo_pos_refund_position(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_finance_post_refund(_source_type text, _source_id uuid, _silent boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  branch uuid; cur text; ref text; occurred date; amount numeric := 0;
  customer uuid; settle text; revenue text; lines jsonb; res jsonb;
  dest uuid;
BEGIN
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF auth.uid() IS NULL OR public.current_access_scope() IS NULL OR public.current_access_scope()='technical' OR NOT coalesce(public.is_org_admin() OR public.has_permission('finance','payments','refund_payment') OR public.has_permission('finance','approve') OR public.has_permission('pos','refunds.approve'),false) THEN RAISE EXCEPTION 'Refund posting authority is required' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(_source_type || ':' || _source_id::text, 0));

  IF _source_type = 'pos_refund' THEN
    SELECT p.posted_journal_id INTO dest FROM public.pos_refund_requests r JOIN public.cash_refund_requests c ON c.id=r.cash_refund_request_id AND c.organization_id=r.organization_id JOIN public.payments p ON p.id=c.refund_payment_id AND p.organization_id=c.organization_id WHERE r.id=_source_id AND r.organization_id=org AND r.status='processed' AND c.status='settled' AND public.neo_cash_refund_payment_valid(p.id);
    IF dest IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','awaiting_verified_payout','detail','Approval alone does not return money. Complete the guarded payout and its journal first.'); END IF;
    RETURN jsonb_build_object('ok',true,'journal_id',dest,'duplicate_prevented',true,'posting_type','refund');
  ELSIF _source_type = 'folio_refund' THEN
    SELECT r.amount, r.branch_id, coalesce(p.receipt_number, 'Refund'), p.customer_id,
           p.method, coalesce(r.processed_at, r.created_at)::date, p.destination_account_id
      INTO amount, branch, ref, customer, settle, occurred, dest
      FROM public.refunds r
      LEFT JOIN public.payments p ON p.id = r.payment_id
     WHERE r.id = _source_id AND r.organization_id = org AND r.status='processed';
    IF amount IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    revenue := '1060';
  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_source_type');
  END IF;

  IF NOT coalesce(public.neo_branch_in_scope(branch),false) OR amount IS NULL OR amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Refund property and amount evidence needs review'; END IF;
  IF coalesce(amount,0) <= 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount'); END IF;

  -- Money goes back out of the same account it came into, when one was recorded.
  settle := coalesce(public.neo_gl_account_code(org, settle, dest), '1010');
  cur := public.neo_fact_currency(org, branch);
  occurred := coalesce(occurred, (now() AT TIME ZONE public.neo_fact_timezone(org, branch))::date);

  lines := jsonb_build_array(
    jsonb_build_object('code', revenue, 'debit', amount, 'description', 'Refund ' || coalesce(ref,'')),
    jsonb_build_object('code', settle, 'credit', amount, 'description', 'Cash / settlement returned'));

  res := public.neo_gl_post(org, branch, 'refund', _source_type, _source_id, 'refund',
                            occurred, cur, 'Refund ' || coalesce(ref,''), lines, customer, NULL);

  PERFORM public.neo_record_posting_receipt(org, branch, _source_type, _source_id, ref,
    'posted', amount, cur, NULL, 'Posted to journal ' || (res->>'journal_id'), NULL, occurred);

  PERFORM public.emit_domain_event(org, branch, 'finance.posted', _source_type, _source_id,
    jsonb_build_object('posting_type', 'refund', 'amount', amount, 'currency', cur,
                       'journal_id', res->>'journal_id', 'occurred_on', occurred),
    'finance.posted:' || _source_type || ':' || _source_id::text, customer);

  RETURN res || jsonb_build_object('ok', true, 'amount', amount, 'posting_type', 'refund');
EXCEPTION WHEN OTHERS THEN
  IF _silent THEN RETURN jsonb_build_object('ok', false, 'reason', 'failed', 'detail', SQLERRM); END IF;
  RAISE;
END $function$
;

REVOKE ALL ON FUNCTION public.neo_cash_refund_request(uuid,numeric,text),public.neo_cash_refund_decide(uuid,boolean,text),public.neo_cash_refund_settle(uuid),public.neo_pos_refund_decide(uuid,boolean,text),public.neo_finance_post_refund(text,uuid,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_cash_refund_request(uuid,numeric,text),public.neo_cash_refund_decide(uuid,boolean,text),public.neo_cash_refund_settle(uuid),public.neo_pos_refund_decide(uuid,boolean,text),public.neo_finance_post_refund(text,uuid,boolean) TO authenticated;
NOTIFY pgrst,'reload schema';
WITH expected(signature,hash) AS(VALUES ('public.neo_cash_refund_decide(uuid,boolean,text)','c0cb1476a9b2f12dafa30e07dc8b69be'),('public.neo_cash_refund_payment_valid(uuid)','aedb1ece270a29f673d725a314388bae'),('public.neo_cash_refund_request(uuid,numeric,text)','8a19bdc11ff823207b02dc5ce842eed8'),('public.neo_cash_refund_request_v2(uuid,numeric,text,uuid)','912527bf21fb6177b5f15d19d08d27ef'),('public.neo_cash_refund_settle(uuid)','7ec402c61a72c6a541172effce7b2828'),('public.neo_cash_refunds(uuid)','ad76d94642b967c5b0e76187b771ba16'),('public.neo_deposit_net_amount(uuid)','66a6e2341f495f35ef62986a69d73a67'),('public.neo_finance_post_refund(text,uuid,boolean)','994257ec1800781f26deaa23610f55e3'),('public.neo_finance_post_txn(text,uuid,boolean)','5f33d5ef8c7b352450d588e8d927d469'),('public.neo_pos_refund_decide(uuid,boolean,text)','59ee0e7a23924215c37689d4accc9a55'),('public.neo_pos_refund_position(uuid)','fbaa13682bb6b2c78fc6b78f0c76cc09'),('public.neo_pos_refund_request(uuid,uuid,numeric,text,uuid)','8600de894d91daec066ccfbfbba9abe1'),('public.neo_pos_refund_settle(uuid,text,uuid,boolean)','77f37f0a0af71ea5bb3942ab49ffc75a'),('public.neo_refund_payment_write_guard()','0938ecb9542da01bf2f3104451615072'),('public.neo_refund_receipt_lock(uuid)','d694ea988fe7c20c60c88f54cbc0cfde'),('public.neo_refund_reserve(uuid,numeric,text,text,uuid,boolean,uuid)','7bba44baad6ade143f1b3a476584da32'),('public.neo_refund_settle_internal(uuid,boolean,text,uuid)','bafd3b18d1ef2be1f81746921a797ce1'),('public.neo_refunded_deposit_id(uuid)','f19a90c7b69904c3cc18a19865e78ba5'),('public.neo_reservation_collection_facts(uuid,uuid,uuid)','1d68cac737af11a39bc235ccdb1d5d8c'),('public.neo_reservation_deposit_position(uuid)','10054e585f7d5b8c5afb70eca919600b'),('public.pms_apply_deposits_to_folio()','467b12198c2e8a2dde3038ce0797a9b3')),checked AS(SELECT signature,coalesce(md5(pg_get_functiondef(to_regprocedure(signature)))=hash,false) matches FROM expected) SELECT jsonb_build_object('diagnostic_version','refund-deposit-payout-connections-v1','definitions_match',(SELECT bool_and(matches) FROM checked),'definition_checks',(SELECT jsonb_agg(to_jsonb(checked)) FROM checked),'direct_refund_decisions_disabled',NOT has_table_privilege('authenticated','public.pos_refund_requests','INSERT') AND NOT has_table_privilege('authenticated','public.pos_refund_requests','UPDATE') AND NOT has_table_privilege('authenticated','public.cash_refund_requests','INSERT') AND NOT has_table_privilege('authenticated','public.cash_refund_requests','UPDATE'),'refund_write_guard_enabled',EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.payments'::regclass AND tgname='aab_neo_refund_payment_write_guard' AND tgenabled IN ('O','A')),'scope','Installs guarded refund requests, independent approval, verified payout recording, net deposit calculations and forward-only folio liability application. Installation does not refund money, confirm a provider transaction, apply deposits, alter guest history or move stock.') result;
COMMIT;
