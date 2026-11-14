-- Code-only feature installation. No existing order is removed by this script.
-- Removal cancels an unused draft and retains all records/audit history.
BEGIN;
DO $guard$ BEGIN
 IF to_regprocedure('public.neo_pos_remove_draft(uuid,text)') IS NOT NULL
 OR to_regprocedure('public.neo_pos_removed_draft_write_guard()') IS NOT NULL
 OR to_regclass('public.neo_pos_draft_removals') IS NOT NULL THEN
  RAISE EXCEPTION 'Draft-removal functions already exist. Inspect installed code before replacing.';
 END IF;
 IF to_regclass('public.pos_orders') IS NULL OR to_regclass('public.pos_payments') IS NULL
 OR to_regclass('public.cash_payment_requests') IS NULL OR to_regclass('public.pos_order_items') IS NULL
 OR to_regclass('public.audit_logs') IS NULL THEN RAISE EXCEPTION 'Required POS contracts are missing'; END IF;
 IF md5(pg_get_functiondef(to_regprocedure('public.neo_pos_guard_void_discount()')))
   IS DISTINCT FROM '4cee738d938c19f9b862510b2cf6ae07'
 OR md5(pg_get_functiondef(to_regprocedure('public.neo_pos_lifecycle_guard()')))
   IS DISTINCT FROM 'e6b9988870d2955341f77da0dd199bf8' THEN
  RAISE EXCEPTION 'POS authority/lifecycle contract changed. Review before installing draft removal.';
 END IF;
END $guard$;

CREATE TABLE public.neo_pos_draft_removals(
 order_id uuid PRIMARY KEY REFERENCES public.pos_orders(id) ON DELETE RESTRICT,
 organization_id uuid NOT NULL,branch_id uuid NOT NULL,removed_by uuid NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500),
 removed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.neo_pos_draft_removals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.neo_pos_draft_removals FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.neo_pos_removed_draft_write_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE v_order uuid; order_org uuid;
BEGIN
 IF TG_TABLE_NAME='cash_payment_requests' THEN
  IF NEW.source_module IS DISTINCT FROM 'pos' THEN RETURN NEW; END IF;
  v_order:=NEW.source_record_id;
 ELSIF TG_TABLE_NAME='station_ticket_items' THEN
  SELECT i.order_id INTO v_order FROM public.pos_order_items i WHERE i.id=NEW.order_item_id;
 ELSE v_order:=NEW.order_id;
 END IF;
 -- Serialise new work with draft removal, including cash-request paths which
 -- historically did not lock the parent before inserting their request.
 SELECT o.organization_id INTO order_org FROM public.pos_orders o WHERE o.id=v_order FOR UPDATE;
 IF order_org IS NOT NULL AND EXISTS(SELECT 1 FROM public.neo_pos_draft_removals r
   WHERE r.organization_id=order_org AND r.order_id=v_order) THEN
  RAISE EXCEPTION 'This draft order was removed. Open a new order for new work.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.neo_pos_removed_draft_write_guard() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.neo_pos_remove_draft(_order uuid,_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE org uuid:=public.current_org_id(); actor uuid:=auth.uid(); o public.pos_orders; reason text:=btrim(coalesce(_reason,''));
BEGIN
 IF actor IS NULL OR org IS NULL OR public.current_access_scope() IS NULL OR public.current_access_scope()='technical' THEN
  RAISE EXCEPTION 'Not permitted to remove orders' USING ERRCODE='42501'; END IF;
 IF NOT coalesce(public.is_org_admin() OR public.has_permission('restaurant','orders.void')
   OR public.has_permission('restaurant','approvals.approve'),false) THEN
  RAISE EXCEPTION 'Order removal requires existing void authority' USING ERRCODE='42501'; END IF;
 IF length(reason)<3 OR length(reason)>500 THEN RAISE EXCEPTION 'Enter a removal reason of 3 to 500 characters'; END IF;
 SELECT * INTO o FROM public.pos_orders WHERE id=_order AND organization_id=org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;
 IF o.branch_id IS NULL OR NOT coalesce(public.neo_branch_in_scope(o.branch_id),false) THEN
  RAISE EXCEPTION 'Order property is outside your access' USING ERRCODE='42501'; END IF;
 IF o.status='cancelled' AND EXISTS(SELECT 1 FROM public.neo_pos_draft_removals r WHERE r.organization_id=org AND r.order_id=o.id) THEN
  RETURN jsonb_build_object('ok',true,'removed',true,'already_removed',true,'order_id',o.id,'status','cancelled','history_retained',true);
 END IF;
 IF o.status IS DISTINCT FROM 'draft' OR coalesce(o.paid_total,0)<>0 OR coalesce(o.payment_status,'unpaid')<>'unpaid'
 OR o.folio_id IS NOT NULL OR coalesce(o.folio_post_status,'not-posted')='posted' THEN
  RAISE EXCEPTION 'Only unpaid, unused drafts can be removed. Use the existing void/refund workflow for other orders.';
 END IF;
 IF EXISTS(SELECT 1 FROM public.pos_order_items i WHERE i.order_id=o.id AND coalesce(i.status,'draft') NOT IN ('draft','cancelled','voided'))
 OR EXISTS(SELECT 1 FROM public.pos_payments p WHERE p.order_id=o.id)
 OR EXISTS(SELECT 1 FROM public.cash_payment_requests r WHERE r.source_module='pos' AND r.source_record_id=o.id)
 OR EXISTS(SELECT 1 FROM public.station_tickets t WHERE to_jsonb(t)->>'order_id'=o.id::text)
 OR EXISTS(SELECT 1 FROM public.station_ticket_items t JOIN public.pos_order_items i ON i.id=t.order_item_id WHERE i.order_id=o.id)
 OR EXISTS(SELECT 1 FROM public.inventory_posting_events e WHERE e.order_id=o.id)
 OR EXISTS(SELECT 1 FROM public.finance_posting_receipts r WHERE r.organization_id=org AND r.source_id=o.id)
 OR EXISTS(SELECT 1 FROM public.journal_entries j WHERE j.organization_id=org AND j.source_document_id=o.id)
 OR EXISTS(SELECT 1 FROM public.folio_lines f WHERE f.organization_id=org AND
   (f.source_record_uuid=o.id OR (f.source_module='pos' AND f.source_record_id=o.id::text)))
 OR EXISTS(SELECT 1 FROM public.delivery_orders d WHERE d.pos_order_id=o.id) THEN
  RAISE EXCEPTION 'This draft has payment, production, stock or downstream history. Use the existing controlled cancellation workflow.';
 END IF;
 IF EXISTS(SELECT 1 FROM public.canonical_transaction_states s WHERE s.organization_id=org
   AND s.source_module='pos' AND s.source_id=o.id AND s.financial_state NOT IN ('pending','not-applicable'))
 OR EXISTS(SELECT 1 FROM public.financial_states s WHERE s.organization_id=org
   AND s.source_module IN ('pos','pos_order') AND s.source_id=o.id AND s.financial_status NOT IN ('pending','not-applicable')) THEN
  RAISE EXCEPTION 'This draft has a financial lifecycle exception. Resolve it before removal.';
 END IF;
 UPDATE public.pos_orders SET status='cancelled',updated_at=now() WHERE id=o.id;
 UPDATE public.pos_order_items SET status='cancelled',updated_at=now() WHERE order_id=o.id AND coalesce(status,'draft')='draft';
 INSERT INTO public.neo_pos_draft_removals(order_id,organization_id,branch_id,removed_by,reason)
 VALUES(o.id,org,o.branch_id,actor,reason);
 UPDATE public.canonical_transaction_states SET operational_state='cancelled',financial_state='not-applicable',
   next_action=NULL,blocking_reason=NULL,updated_at=now(),version=version+1
 WHERE organization_id=org AND source_module='pos' AND source_id=o.id;
 UPDATE public.financial_states SET operational_status='cancelled',financial_status='not-applicable',
   reason='Unused draft removed before service or payment',last_error=NULL,updated_at=now()
 WHERE organization_id=org AND source_module IN ('pos','pos_order') AND source_id=o.id;
 INSERT INTO public.audit_logs(organization_id,branch_id,user_id,user_name,action,module,record_id,previous_value,new_value,reason)
 VALUES(org,o.branch_id,actor,'','pos.order.draft_removed','pos',o.id::text,
   jsonb_build_object('status',o.status,'order_number',o.order_number),
   jsonb_build_object('status','cancelled','history_retained',true),reason);
 RETURN jsonb_build_object('ok',true,'removed',true,'already_removed',false,'order_id',o.id,'status','cancelled','history_retained',true);
END $function$;
REVOKE ALL ON FUNCTION public.neo_pos_remove_draft(uuid,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.neo_pos_remove_draft(uuid,text) TO authenticated;

CREATE TRIGGER neo_removed_draft_payment_guard BEFORE INSERT ON public.pos_payments
 FOR EACH ROW EXECUTE FUNCTION public.neo_pos_removed_draft_write_guard();
CREATE TRIGGER neo_removed_draft_cash_request_guard BEFORE INSERT ON public.cash_payment_requests
 FOR EACH ROW EXECUTE FUNCTION public.neo_pos_removed_draft_write_guard();
CREATE TRIGGER neo_removed_draft_item_guard BEFORE INSERT ON public.pos_order_items
 FOR EACH ROW EXECUTE FUNCTION public.neo_pos_removed_draft_write_guard();
CREATE TRIGGER neo_removed_draft_ticket_guard BEFORE INSERT ON public.station_tickets
 FOR EACH ROW EXECUTE FUNCTION public.neo_pos_removed_draft_write_guard();
CREATE TRIGGER neo_removed_draft_ticket_item_guard BEFORE INSERT ON public.station_ticket_items
 FOR EACH ROW EXECUTE FUNCTION public.neo_pos_removed_draft_write_guard();
CREATE TRIGGER neo_removed_draft_stock_guard BEFORE INSERT ON public.inventory_posting_events
 FOR EACH ROW EXECUTE FUNCTION public.neo_pos_removed_draft_write_guard();
NOTIFY pgrst,'reload schema';
COMMIT;
