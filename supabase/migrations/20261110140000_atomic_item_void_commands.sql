BEGIN;
DO $guard$
BEGIN
 IF to_regprocedure('public.neo_pos_void_request(uuid,uuid,text)') IS NOT NULL OR to_regprocedure('public.neo_pos_void_decide(uuid,boolean,text)') IS NOT NULL THEN RAISE EXCEPTION 'Atomic void repair already exists; run its postcheck instead'; END IF;
 IF md5(pg_get_functiondef(to_regprocedure('public.pos_enforce_item_status()'))) IS DISTINCT FROM 'f4965084982a115552b1c558af056325'
 OR md5(pg_get_functiondef(to_regprocedure('public.neo_pos_item_void_effect()'))) IS DISTINCT FROM 'cd55d43dd08c8ea30155c9e799f9a519'
 OR md5(pg_get_functiondef(to_regprocedure('public.neo_pos_status_rules()'))) IS DISTINCT FROM '2e89fa8e4652789f2dbe48544a47e149' THEN RAISE EXCEPTION 'Void prerequisites changed; inspect before installing'; END IF;
END $guard$;

CREATE FUNCTION public.neo_pos_void_request(_order uuid,_item uuid,_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE org uuid:=public.current_org_id(); actor uuid:=auth.uid(); o public.pos_orders; i public.pos_order_items; r public.pos_void_requests; reason text:=btrim(coalesce(_reason,''));
BEGIN
 IF actor IS NULL OR org IS NULL OR public.current_access_scope() IS NULL OR public.current_access_scope()='technical' OR NOT coalesce(public.has_permission('restaurant','orders.create') OR public.has_permission('restaurant','orders.void') OR public.has_permission('restaurant','approvals.approve'),false) THEN RAISE EXCEPTION 'Not permitted to request voids' USING ERRCODE='42501'; END IF;
 IF length(reason)<3 OR length(reason)>1000 THEN RAISE EXCEPTION 'Enter a void reason of 3 to 1000 characters'; END IF;
 SELECT * INTO o FROM public.pos_orders WHERE id=_order AND organization_id=org FOR UPDATE;
 IF o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
 IF o.branch_id IS NULL OR NOT coalesce(public.neo_branch_in_scope(o.branch_id),false) OR NOT coalesce(public.in_my_scope(o.organization_id,o.branch_id,o.department_id,o.station_id,o.waiter_id,o.created_by) OR public.is_shared_with_me('pos_order',o.id),false) THEN RAISE EXCEPTION 'Order is outside your access' USING ERRCODE='42501'; END IF;
 SELECT * INTO i FROM public.pos_order_items WHERE id=_item AND order_id=o.id AND organization_id=org FOR UPDATE;
 IF i.id IS NULL THEN RAISE EXCEPTION 'Order item not found'; END IF;
 IF i.status NOT IN ('sent','accepted','preparing','ready','served','cancel-pending') THEN RAISE EXCEPTION 'Only a current service item can be requested for void'; END IF;
 IF o.status IN ('paid','closed','charged-to-room','credit','cancelled','voided') OR o.payment_status IS DISTINCT FROM 'unpaid' OR o.paid_total<>0 OR o.folio_id IS NOT NULL OR o.folio_post_status='posted'
 OR EXISTS(SELECT 1 FROM public.pos_payments p WHERE p.order_id=o.id AND p.status NOT IN ('failed','cancelled'))
 OR EXISTS(SELECT 1 FROM public.cash_payment_requests c WHERE c.source_module='pos' AND c.source_record_id=o.id AND c.status NOT IN ('cancelled','rejected','failed')) THEN RAISE EXCEPTION 'This bill has settlement activity. Review the payment or refund before cancelling its charges'; END IF;
 IF i.line_total IS NULL OR i.line_total::text IN ('NaN','Infinity','-Infinity') OR i.line_total<0 THEN RAISE EXCEPTION 'Item amount cannot be verified'; END IF;
 SELECT * INTO r FROM public.pos_void_requests WHERE organization_id=org AND order_id=o.id AND order_item_id=i.id AND status='pending' ORDER BY created_at LIMIT 1;
 IF r.id IS NULL THEN
  INSERT INTO public.pos_void_requests(organization_id,branch_id,order_id,order_item_id,request_kind,amount,reason,preparation_status,requested_by)
  VALUES(org,o.branch_id,o.id,i.id,'item',i.line_total,reason,i.status,actor) RETURNING * INTO r;
 END IF;
 RETURN jsonb_build_object('ok',true,'request_id',r.id,'order_id',o.id,'status',r.status,'item_status',i.status);
END $function$;

CREATE FUNCTION public.neo_pos_void_decide(_request uuid,_approve boolean,_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE org uuid:=public.current_org_id(); actor uuid:=auth.uid(); oid uuid; o public.pos_orders; i public.pos_order_items; r public.pos_void_requests;
BEGIN
 IF actor IS NULL OR org IS NULL OR public.current_access_scope() IS NULL OR public.current_access_scope()='technical' OR NOT coalesce(public.has_permission('restaurant','orders.void') OR public.has_permission('restaurant','approvals.approve'),false) THEN RAISE EXCEPTION 'Not permitted to decide voids' USING ERRCODE='42501'; END IF;
 IF _approve IS NULL THEN RAISE EXCEPTION 'Choose approve or reject'; END IF;
 SELECT order_id INTO oid FROM public.pos_void_requests WHERE id=_request AND organization_id=org;
 SELECT * INTO o FROM public.pos_orders WHERE id=oid AND organization_id=org FOR UPDATE;
 IF o.id IS NULL THEN RAISE EXCEPTION 'Void request not found'; END IF;
 IF o.branch_id IS NULL OR NOT coalesce(public.neo_branch_in_scope(o.branch_id),false) OR NOT coalesce(public.in_my_scope(o.organization_id,o.branch_id,o.department_id,o.station_id,o.waiter_id,o.created_by) OR public.is_shared_with_me('pos_order',o.id),false) THEN RAISE EXCEPTION 'Order is outside your access' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM public.pos_void_requests WHERE id=_request AND organization_id=org AND order_id=o.id FOR UPDATE;
 IF r.requested_by IS NOT DISTINCT FROM actor THEN RAISE EXCEPTION 'A different authorised person must decide this request' USING ERRCODE='42501'; END IF;
 IF r.request_kind<>'item' OR r.order_item_id IS NULL OR r.branch_id IS DISTINCT FROM o.branch_id THEN RAISE EXCEPTION 'This request requires a separate bill or adjustment review'; END IF;
 SELECT * INTO i FROM public.pos_order_items WHERE id=r.order_item_id AND order_id=o.id AND organization_id=org FOR UPDATE;
 IF i.id IS NULL THEN RAISE EXCEPTION 'Order item not found'; END IF;
 IF r.status<>'pending' THEN
  IF (_approve AND r.status='applied' AND i.status='voided') OR (NOT _approve AND r.status='rejected') THEN RETURN jsonb_build_object('ok',true,'request_id',r.id,'order_id',o.id,'status',r.status,'item_status',i.status,'idempotent',true); END IF;
  RAISE EXCEPTION 'Saved decision differs from this action; refresh and review';
 END IF;
 IF _approve THEN
  IF o.status IN ('paid','closed','charged-to-room','credit','cancelled','voided') OR o.payment_status IS DISTINCT FROM 'unpaid' OR o.paid_total<>0 OR o.folio_id IS NOT NULL OR o.folio_post_status='posted'
  OR EXISTS(SELECT 1 FROM public.pos_payments p WHERE p.order_id=o.id AND p.status NOT IN ('failed','cancelled'))
  OR EXISTS(SELECT 1 FROM public.cash_payment_requests c WHERE c.source_module='pos' AND c.source_record_id=o.id AND c.status NOT IN ('cancelled','rejected','failed'))
  OR EXISTS(SELECT 1 FROM public.folio_lines l WHERE l.organization_id=org AND (l.source_record_uuid=o.id OR (l.source_module='pos' AND l.source_record_id=o.id::text)))
  OR EXISTS(SELECT 1 FROM public.journal_entries j WHERE j.organization_id=org AND j.source_document_id=o.id)
  OR EXISTS(SELECT 1 FROM public.delivery_orders d WHERE d.pos_order_id=o.id) THEN RAISE EXCEPTION 'This bill has settlement or downstream activity. Review its payment, refund or source order first'; END IF;
  IF i.status NOT IN ('sent','accepted','preparing','ready','served','cancel-pending') THEN RAISE EXCEPTION 'Item is no longer eligible for this void'; END IF;
  IF i.status<>'cancel-pending' THEN UPDATE public.pos_order_items SET status='cancel-pending' WHERE id=i.id; END IF;
  UPDATE public.pos_order_items SET status='voided' WHERE id=i.id;
  IF NOT EXISTS(SELECT 1 FROM public.pos_order_items x WHERE x.order_id=o.id AND x.status NOT IN ('voided','cancelled')) THEN
   IF NOT (public.neo_pos_status_rules()->o.status ? 'void-pending') AND o.status<>'void-pending' THEN RAISE EXCEPTION 'Bill cannot enter controlled void from its current state'; END IF;
   IF o.status<>'void-pending' THEN UPDATE public.pos_orders SET status='void-pending' WHERE id=o.id; END IF;
   UPDATE public.pos_orders SET status='voided',closed_at=coalesce(closed_at,now()) WHERE id=o.id;
  END IF;
 END IF;
 UPDATE public.pos_void_requests SET status=CASE WHEN _approve THEN 'applied' ELSE 'rejected' END,decided_by=actor,decided_at=now(),decision_note=nullif(btrim(_note),''),updated_at=now() WHERE id=r.id;
 INSERT INTO public.audit_logs(organization_id,branch_id,user_id,user_name,action,module,record_id,new_value,reason)
 VALUES(org,o.branch_id,actor,'',CASE WHEN _approve THEN 'pos.void.applied' ELSE 'pos.void.rejected' END,'pos',r.id::text,jsonb_build_object('order_id',o.id,'item_id',i.id),nullif(btrim(_note),''));
 RETURN jsonb_build_object('ok',true,'request_id',r.id,'order_id',o.id,'status',CASE WHEN _approve THEN 'applied' ELSE 'rejected' END,'item_status',CASE WHEN _approve THEN 'voided' ELSE i.status END);
END $function$;
REVOKE ALL ON FUNCTION public.neo_pos_void_request(uuid,uuid,text),public.neo_pos_void_decide(uuid,boolean,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.neo_pos_void_request(uuid,uuid,text),public.neo_pos_void_decide(uuid,boolean,text) TO authenticated;
-- All app decisions now use the scoped transaction rather than independent table writes.
REVOKE INSERT,UPDATE,DELETE ON public.pos_void_requests FROM authenticated;
NOTIFY pgrst,'reload schema';
WITH expected(signature,hash) AS (VALUES ('public.neo_pos_void_request(uuid,uuid,text)','e13c0a54402e8181a1e7afcc74d3f48f'),('public.neo_pos_void_decide(uuid,boolean,text)','312ffa842dbdca915b83799dd3421880')), checked AS (SELECT signature,coalesce(md5(pg_get_functiondef(to_regprocedure(signature)))=hash,false) AS matches FROM expected) SELECT jsonb_build_object('diagnostic_version','atomic-item-void-install-v1','definitions_match',(SELECT bool_and(matches) FROM checked),'definition_checks',(SELECT jsonb_agg(to_jsonb(checked)) FROM checked),'direct_decision_disabled',NOT has_table_privilege('authenticated','public.pos_void_requests','UPDATE'),'scope','Two atomic unpaid-item void commands only. No bill is voided, refund paid, stock moved or historical request rewritten by installation. Refund payout correction and broader acceptance remain open.') AS result;
COMMIT;
