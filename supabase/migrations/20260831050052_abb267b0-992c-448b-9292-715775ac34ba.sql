CREATE OR REPLACE FUNCTION public.neo_reservation_create(_payload jsonb, _idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _branch uuid := NULLIF(_payload->>'branch_id','')::uuid;
  _room uuid := NULLIF(_payload->>'room_id','')::uuid;
  _room_type uuid := NULLIF(_payload->>'room_type_id','')::uuid;
  _arrival date := (_payload->>'arrival_date')::date;
  _departure date := (_payload->>'departure_date')::date;
  _adults integer := COALESCE((_payload->>'adults')::integer,1);
  _children integer := COALESCE((_payload->>'children')::integer,0);
  _group uuid := NULLIF(_payload->>'group_booking_id','')::uuid;
  _existing public.reservations;
  _created public.reservations;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No active organisation'; END IF;
  IF NOT (public.has_permission('pms','reservations.create') OR public.has_permission('pms','reservations.edit')) THEN
    RAISE EXCEPTION 'Not permitted to create reservations';
  END IF;
  IF NULLIF(btrim(COALESCE(_idempotency_key,'')), '') IS NULL THEN RAISE EXCEPTION 'A reservation idempotency key is required'; END IF;
  IF _branch IS NULL OR NOT EXISTS (SELECT 1 FROM public.branches WHERE id=_branch AND organization_id=_org) THEN RAISE EXCEPTION 'Select a valid property'; END IF;
  IF _arrival IS NULL OR _departure IS NULL OR _departure <= _arrival THEN RAISE EXCEPTION 'Departure must be after arrival'; END IF;

  SELECT * INTO _existing FROM public.reservations WHERE organization_id=_org AND idempotency_key=_idempotency_key;
  IF _existing.id IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'idempotent',true,'id',_existing.id,'confirmation_number',_existing.confirmation_number,'room_id',_existing.room_id);
  END IF;

  IF _room IS NOT NULL THEN
    PERFORM 1 FROM public.rooms WHERE id=_room AND organization_id=_org AND branch_id=_branch FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'The selected room does not belong to this property'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.pms_available_rooms(_branch,_arrival,_departure,_room_type,_adults,_children,_group) a
       WHERE a.room_id=_room
    ) THEN RAISE EXCEPTION 'The selected room is no longer available for these stay dates'; END IF;
  END IF;

  INSERT INTO public.reservations
    (organization_id,branch_id,confirmation_number,customer_id,corporate_account_id,group_booking_id,
     booking_source,reservation_type,external_reference,arrival_date,departure_date,nights,adults,children,
     infants,room_type_id,room_id,rate_plan_id,meal_plan_id,nightly_rate,tax_amount,discount_amount,total_amount,
     deposit_required,balance,guarantee_method,special_requests,is_vip,status,rate_source,rate_override_reason,
     rate_quoted_amount,idempotency_key,created_by)
  VALUES
    (_org,_branch,_payload->>'confirmation_number',NULLIF(_payload->>'customer_id','')::uuid,
     NULLIF(_payload->>'corporate_account_id','')::uuid,_group,COALESCE(NULLIF(_payload->>'booking_source',''),'direct'),
     COALESCE(NULLIF(_payload->>'reservation_type',''),'individual'),NULLIF(_payload->>'external_reference',''),
     _arrival,_departure,(_departure-_arrival),_adults,_children,COALESCE((_payload->>'infants')::integer,0),
     _room_type,_room,NULLIF(_payload->>'rate_plan_id','')::uuid,NULLIF(_payload->>'meal_plan_id','')::uuid,
     COALESCE((_payload->>'nightly_rate')::numeric,0),COALESCE((_payload->>'tax_amount')::numeric,0),
     COALESCE((_payload->>'discount_amount')::numeric,0),COALESCE((_payload->>'total_amount')::numeric,0),
     COALESCE((_payload->>'deposit_required')::numeric,0),COALESCE((_payload->>'balance')::numeric,0),
     COALESCE(NULLIF(_payload->>'guarantee_method',''),'none'),COALESCE(_payload->>'special_requests',''),
     COALESCE((_payload->>'is_vip')::boolean,false),COALESCE(NULLIF(_payload->>'status',''),'tentative'),
     NULLIF(_payload->>'rate_source',''),NULLIF(_payload->>'rate_override_reason',''),
     NULLIF(_payload->>'rate_quoted_amount','')::numeric,_idempotency_key,auth.uid())
  RETURNING * INTO _created;

  IF _room IS NOT NULL THEN PERFORM public.pms_assign_room(_created.id,_room,'Selected during reservation creation'); END IF;
  INSERT INTO public.reservation_history (organization_id,reservation_id,action,new_value,changed_by)
  VALUES (_org,_created.id,'created',jsonb_build_object('status',_created.status,'arrival',_arrival,'departure',_departure,'nights',_created.nights,'room_id',_room),auth.uid());
  INSERT INTO public.audit_logs (organization_id,branch_id,user_id,user_name,action,module,record_id,new_value)
  VALUES (_org,_branch,auth.uid(),'', 'pms.reservation.created','front-office',_created.id::text,
          jsonb_build_object('confirmation',_created.confirmation_number,'arrival',_arrival,'departure',_departure,'total',_created.total_amount,'room_id',_room));
  RETURN jsonb_build_object('ok',true,'idempotent',false,'id',_created.id,'confirmation_number',_created.confirmation_number,'room_id',_created.room_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.neo_reservation_create(jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_reservation_create(jsonb,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.pms_check_out(_reservation uuid, _force boolean DEFAULT false, _notes text DEFAULT ''::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id(); _stay public.stays; _f public.folios;
  _charges numeric := 0; _paid numeric := 0; _line_paid numeric := 0; _outstanding numeric := 0;
BEGIN
  IF NOT public.has_permission('pms','checkout.perform') THEN RAISE EXCEPTION 'Not permitted to check out guests'; END IF;
  SELECT * INTO _stay FROM public.stays WHERE reservation_id=_reservation AND organization_id=_org FOR UPDATE;
  IF _stay.id IS NULL THEN RAISE EXCEPTION 'No stay found for this reservation'; END IF;
  IF _stay.status='checked-out' THEN RETURN jsonb_build_object('stay_id',_stay.id,'idempotent',true); END IF;
  SELECT * INTO _f FROM public.folios WHERE stay_id=_stay.id AND folio_type='guest' FOR UPDATE;

  SELECT COALESCE(sum(l.net_amount),0) INTO _charges FROM public.folio_lines l
   JOIN public.folios f ON f.id=l.folio_id WHERE f.stay_id=_stay.id
   AND COALESCE(l.status,'posted') NOT IN ('void','voided','reversed')
   AND COALESCE(l.line_type,'charge') NOT IN ('payment','deposit','refund');
  SELECT COALESCE(sum(a.amount),0) INTO _paid FROM public.payment_allocations a
   JOIN public.folios f ON f.id=a.folio_id JOIN public.payments p ON p.id=a.payment_id
   WHERE f.stay_id=_stay.id AND p.status='confirmed';
  SELECT COALESCE(sum(l.net_amount),0) INTO _line_paid FROM public.folio_lines l
   JOIN public.folios f ON f.id=l.folio_id WHERE f.stay_id=_stay.id
   AND COALESCE(l.status,'posted') NOT IN ('void','voided','reversed')
   AND COALESCE(l.line_type,'charge') IN ('payment','deposit');
  _outstanding := round(_charges-_paid-_line_paid,2);

  IF _outstanding > 0 THEN
    IF NOT _force THEN RAISE EXCEPTION 'Folio is not settled — outstanding balance of %. Settle the bill before check-out.',_outstanding; END IF;
    IF NOT (public.has_permission('pms','folio.override') OR public.is_org_admin()) THEN RAISE EXCEPTION 'Checking out with an unsettled balance requires folio override authority.'; END IF;
    IF btrim(COALESCE(_notes,''))='' THEN RAISE EXCEPTION 'A written reason is required to check out with an unsettled balance.'; END IF;
  END IF;

  UPDATE public.stays SET status='checked-out',checked_out_at=now(),checked_out_by=auth.uid(),updated_at=now() WHERE id=_stay.id;
  UPDATE public.reservations SET status='checked-out',updated_at=now() WHERE id=_reservation;
  UPDATE public.room_assignments SET status='released',updated_at=now() WHERE reservation_id=_reservation AND status='active';
  IF _f.id IS NOT NULL THEN
    UPDATE public.folios SET total_charges=_charges,total_payments=_paid+_line_paid,balance=_outstanding,
      status=CASE WHEN _outstanding<=0 THEN 'settled' ELSE 'under-review' END,
      closed_at=CASE WHEN _outstanding<=0 THEN now() ELSE NULL END,updated_at=now() WHERE id=_f.id;
  END IF;
  IF _stay.room_id IS NOT NULL THEN
    PERFORM set_config('neo.system_posting','on',true);
    PERFORM public.ops_set_room_status(_stay.room_id,'dirty','operational','Guest checked out','pms',_reservation,'vacant');
  END IF;
  INSERT INTO public.pms_workflow_events
    (organization_id,branch_id,event_type,reservation_id,stay_id,folio_id,idempotency_key,created_by)
  VALUES (_org,_stay.branch_id,'guest.checked-out',_reservation,_stay.id,_f.id,'checkout:'||_reservation::text,auth.uid())
  ON CONFLICT (organization_id,idempotency_key) DO NOTHING;
  INSERT INTO public.audit_logs (organization_id,branch_id,user_id,user_name,action,module,record_id,new_value,reason)
  VALUES (_org,_stay.branch_id,auth.uid(),'', 'pms.checkout','front-office',_reservation::text,
    jsonb_build_object('stay_id',_stay.id,'folio_id',_f.id,'outstanding',_outstanding,'forced',_force AND _outstanding>0),_notes);
  RETURN jsonb_build_object('ok',true,'stay_id',_stay.id,'folio_id',_f.id,'outstanding',_outstanding,'idempotent',false,'room_state','vacant-dirty');
END;
$function$;
REVOKE ALL ON FUNCTION public.pms_check_out(uuid,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pms_check_out(uuid,boolean,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.inventory_post_receipt(_receipt uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_org uuid:=current_org_id(); r record; l record; v_total numeric:=0; v_lines integer:=0; v_accepted numeric; v_err text;
BEGIN
 IF NOT has_permission('procurement','receiving.manage') THEN RAISE EXCEPTION 'Not permitted to receive stock'; END IF;
 SELECT * INTO r FROM goods_receipts WHERE id=_receipt AND organization_id=v_org FOR UPDATE;
 IF r IS NULL THEN RAISE EXCEPTION 'Receipt not found'; END IF;
 IF r.status='posted' AND r.accrual_journal_id IS NOT NULL THEN RETURN jsonb_build_object('status','already-posted','journal_id',r.accrual_journal_id); END IF;
 IF r.status<>'posted' THEN
  FOR l IN SELECT * FROM goods_receipt_lines WHERE receipt_id=_receipt LOOP
   v_accepted:=COALESCE(l.quantity_accepted,GREATEST(COALESCE(l.quantity_received,0)-COALESCE(l.quantity_rejected,0)-COALESCE(l.quantity_damaged,0)-COALESCE(l.quantity_returned,0),0));
   IF v_accepted>0 THEN
    PERFORM inventory_apply_movement(l.stock_item_id,COALESCE(l.location_id,r.location_id),v_accepted,l.unit,'receipt',
      CASE WHEN l.unit_price>0 THEN l.unit_price/NULLIF(inventory_convert(1,l.unit,(SELECT base_unit FROM stock_items WHERE id=l.stock_item_id)),0) ELSE NULL END,
      'goods_receipt',_receipt,'Goods accepted','grn:'||_receipt::text||':'||l.id::text,l.batch_number,l.expiry_date);
    v_total:=v_total+(v_accepted*COALESCE(l.unit_price,0)); v_lines:=v_lines+1;
   END IF;
   IF l.order_line_id IS NOT NULL THEN UPDATE purchase_order_lines SET received_quantity=COALESCE(received_quantity,0)+COALESCE(l.quantity_received,0),accepted_quantity=COALESCE(accepted_quantity,0)+v_accepted,rejected_quantity=COALESCE(rejected_quantity,0)+COALESCE(l.quantity_rejected,0),returned_quantity=COALESCE(returned_quantity,0)+COALESCE(l.quantity_returned,0) WHERE id=l.order_line_id; END IF;
  END LOOP;
  UPDATE goods_receipts SET status='posted',posted_at=now(),total_value=v_total WHERE id=_receipt;
 ELSE v_total:=COALESCE(r.total_value,0); END IF;
 BEGIN
  PERFORM public.neo_grn_post_accrual(_receipt);
  UPDATE goods_receipts SET accrual_error=NULL WHERE id=_receipt;
 EXCEPTION WHEN OTHERS THEN
  v_err:=SQLERRM; UPDATE goods_receipts SET accrual_error=v_err WHERE id=_receipt;
  PERFORM public.neo_record_posting_receipt(v_org,r.branch_id,'inventory',_receipt,COALESCE(r.grn_number,_receipt::text),'failed',v_total,'KES',NULL,'Goods receipt accrual',v_err,CURRENT_DATE);
 END;
 RETURN jsonb_build_object('status',CASE WHEN v_err IS NULL THEN 'posted' ELSE 'pending-finance' END,'lines',v_lines,'value',v_total,'finance_error',v_err);
END;
$function$;

DROP FUNCTION IF EXISTS public.neo_ap_journal_register(uuid,date,date,text,integer);
CREATE FUNCTION public.neo_ap_journal_register(_branch uuid DEFAULT NULL,_from date DEFAULT NULL,_to date DEFAULT NULL,_match_status text DEFAULT NULL,_limit integer DEFAULT 300)
RETURNS TABLE(invoice_id uuid,invoice_number text,invoice_date date,due_date date,supplier_id uuid,supplier_name text,branch_id uuid,property text,order_id uuid,order_number text,receipt_id uuid,grn_number text,amount numeric,tax_amount numeric,matched_amount numeric,paid_amount numeric,variance numeric,status text,match_status text,exception_count integer,critical_count integer,line_count integer,journal_id uuid,journal_number text,journal_status text,accounting_date date,total_debit numeric,total_credit numeric,balanced boolean,posted_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _org uuid:=public.current_org_id();
BEGIN
 IF _org IS NULL OR NOT (public.is_org_admin() OR public.has_permission('finance','ap.view') OR public.has_permission('finance','view') OR public.can_read_general_ledger()) THEN RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT si.id,si.invoice_number,si.invoice_date,si.due_date,si.supplier_id,s.name,si.branch_id,b.name,si.order_id,po.order_number,si.receipt_id,gr.grn_number,COALESCE(si.amount,0),COALESCE(si.tax_amount,0),COALESCE(si.matched_amount,0),COALESCE(si.paid_amount,0),COALESCE(si.variance,0),si.status,COALESCE(si.match_status,'unmatched'),
  (SELECT count(*)::int FROM public.supplier_invoice_discrepancies d WHERE d.supplier_invoice_id=si.id AND d.resolved=false),
  (SELECT count(*)::int FROM public.supplier_invoice_discrepancies d WHERE d.supplier_invoice_id=si.id AND d.resolved=false AND d.severity='critical'),
  (SELECT count(*)::int FROM public.supplier_invoice_lines il WHERE il.supplier_invoice_id=si.id),j.id,j.journal_number,j.status,j.accounting_date,COALESCE(j.total_debit,0),COALESCE(j.total_credit,0),CASE WHEN j.id IS NULL THEN false ELSE abs(COALESCE(j.total_debit,0)-COALESCE(j.total_credit,0))<0.01 END,j.posted_at
 FROM public.supplier_invoices si LEFT JOIN public.suppliers s ON s.id=si.supplier_id LEFT JOIN public.branches b ON b.id=si.branch_id LEFT JOIN public.purchase_orders po ON po.id=si.order_id LEFT JOIN public.goods_receipts gr ON gr.id=si.receipt_id LEFT JOIN public.journal_entries j ON j.id=si.journal_id
 WHERE si.organization_id=_org AND (_branch IS NULL OR si.branch_id=_branch) AND (_from IS NULL OR si.invoice_date>=_from) AND (_to IS NULL OR si.invoice_date<=_to) AND (_match_status IS NULL OR COALESCE(si.match_status,'unmatched')=_match_status)
 ORDER BY si.invoice_date DESC NULLS LAST,si.created_at DESC LIMIT greatest(1,least(COALESCE(_limit,300),1000));
END;
$function$;
REVOKE ALL ON FUNCTION public.neo_ap_journal_register(uuid,date,date,text,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_ap_journal_register(uuid,date,date,text,integer) TO authenticated;

CREATE UNIQUE INDEX IF NOT EXISTS night_audit_runs_one_per_day_idx ON public.night_audit_runs(organization_id,branch_id,business_date);

CREATE OR REPLACE FUNCTION public.neo_night_audit_run(_branch uuid,_date date DEFAULT NULL,_mode text DEFAULT 'manual')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_org uuid:=public.current_org_id(); v_date date:=COALESCE(_date,current_date); v_run uuid; v_blocking int:=0; v_warning int:=0; v_pos_revenue numeric:=0; v_pos_paid numeric:=0; v_rooms_revenue numeric:=0; v_collections numeric:=0; v_outstanding numeric:=0;
BEGIN
 IF v_org IS NULL THEN RAISE EXCEPTION 'No workspace context'; END IF;
 IF NOT (public.has_permission('finance','eod','view') OR public.is_org_admin()) THEN RAISE EXCEPTION 'Forbidden'; END IF;
 IF _branch IS NULL OR NOT EXISTS(SELECT 1 FROM public.branches b WHERE b.id=_branch AND b.organization_id=v_org) THEN RAISE EXCEPTION 'Unknown property'; END IF;
 INSERT INTO public.night_audit_runs(organization_id,branch_id,business_date,run_mode,created_by,started_at)
 VALUES(v_org,_branch,v_date,COALESCE(_mode,'manual'),auth.uid(),now())
 ON CONFLICT(organization_id,branch_id,business_date) DO UPDATE SET run_mode=EXCLUDED.run_mode,created_by=auth.uid(),started_at=now(),completed_at=NULL
 RETURNING id INTO v_run;
 DELETE FROM public.night_audit_exceptions WHERE run_id=v_run;
 INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount)
 SELECT v_run,v_org,_branch,v_date,'cashier-session','blocking',COALESCE(s.shift_number,s.id::text),'Cashier session is still open for the audited business day.',s.expected_cash FROM public.pos_shifts s WHERE s.organization_id=v_org AND s.branch_id=_branch AND s.status='open' AND s.opened_at::date<=v_date;
 INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount)
 SELECT v_run,v_org,_branch,v_date,'cash-variance','warning',COALESCE(s.shift_number,s.id::text),CASE WHEN s.variance<0 THEN 'Cash shortage recorded on a closed cashier session.' ELSE 'Cash overage recorded on a closed cashier session.' END,s.variance FROM public.pos_shifts s WHERE s.organization_id=v_org AND s.branch_id=_branch AND s.status<>'open' AND s.closed_at::date=v_date AND COALESCE(s.variance,0)<>0;
 INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount)
 SELECT v_run,v_org,_branch,v_date,'unsettled-bill','warning',o.order_number,'Bill is not fully settled.',GREATEST(COALESCE(o.grand_total,0)-COALESCE(o.paid_total,0),0) FROM public.pos_orders o WHERE o.organization_id=v_org AND o.branch_id=_branch AND o.created_at::date=v_date AND COALESCE(o.payment_status,'unpaid') NOT IN('paid','settled','credit','transferred') AND COALESCE(o.grand_total,0)-COALESCE(o.paid_total,0)>0;
 INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount)
 SELECT v_run,v_org,_branch,v_date,'open-folio','warning',f.folio_number,'Guest folio carries an outstanding balance.',f.balance FROM public.folios f WHERE f.organization_id=v_org AND f.branch_id=_branch AND f.status='open' AND COALESCE(f.balance,0)<>0;
 INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount)
 SELECT v_run,v_org,_branch,v_date,'finance-posting','blocking',q.reference,COALESCE(q.last_error,q.required_action),q.amount FROM public.neo_finance_posting_queue(_branch,v_date,v_date) q WHERE q.eligible OR q.posting_status='failed';
 INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount)
 SELECT v_run,v_org,_branch,v_date,'approval','warning',COALESCE(a.request_number,a.id::text),'Controlled transaction is still awaiting approval.',a.amount FROM public.approval_requests a WHERE a.organization_id=v_org AND a.branch_id=_branch AND a.created_at::date<=v_date AND public.neo_approval_normalize_status(a.status)='pending';
 SELECT COALESCE(sum(o.grand_total),0),COALESCE(sum(o.paid_total),0) INTO v_pos_revenue,v_pos_paid FROM public.pos_orders o WHERE o.organization_id=v_org AND o.branch_id=_branch AND o.created_at::date=v_date;
 SELECT COALESCE(sum(l.total_amount),0) INTO v_rooms_revenue FROM public.folio_lines l WHERE l.organization_id=v_org AND l.branch_id=_branch AND l.posted_at::date=v_date AND l.category='room';
 SELECT COALESCE(sum(f.balance),0) INTO v_outstanding FROM public.folios f WHERE f.organization_id=v_org AND f.branch_id=_branch AND f.status='open'; v_collections:=v_pos_paid;
 IF round(v_pos_revenue-v_pos_paid,2)<>0 THEN INSERT INTO public.night_audit_exceptions(run_id,organization_id,branch_id,business_date,category,severity,reference,detail,amount) VALUES(v_run,v_org,_branch,v_date,'revenue-reconciliation','warning','Revenue vs collections','Recorded revenue does not equal collections; the difference must sit in authorised outstanding balances.',round(v_pos_revenue-v_pos_paid,2)); END IF;
 SELECT count(*) FILTER(WHERE severity='blocking'),count(*) FILTER(WHERE severity='warning') INTO v_blocking,v_warning FROM public.night_audit_exceptions WHERE run_id=v_run;
 UPDATE public.night_audit_runs SET blocking_count=v_blocking,warning_count=v_warning,status=CASE WHEN v_blocking>0 THEN 'exception' ELSE 'completed' END,completed_at=now(),summary=jsonb_build_object('pos_revenue',v_pos_revenue,'pos_collections',v_pos_paid,'rooms_revenue',v_rooms_revenue,'collections',v_collections,'outstanding_balances',v_outstanding) WHERE id=v_run;
 RETURN jsonb_build_object('run_id',v_run,'business_date',v_date,'blocking',v_blocking,'warnings',v_warning,'status',CASE WHEN v_blocking>0 THEN 'exception' ELSE 'completed' END);
END;
$function$;
REVOKE ALL ON FUNCTION public.neo_night_audit_run(uuid,date,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_night_audit_run(uuid,date,text) TO authenticated;