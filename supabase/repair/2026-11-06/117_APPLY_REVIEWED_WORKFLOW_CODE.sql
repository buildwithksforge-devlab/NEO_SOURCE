-- Atomic guarded code installation only. No operational command is invoked.
BEGIN;

-- 83_APPLY_SAFE_DRAFT_ORDER_REMOVAL.sql
-- Code-only feature installation. No existing order is removed by this script.
-- Removal cancels an unused draft and retains all records/audit history.

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


-- 85_APPLY_EVENT_REQUIREMENT_OWNERSHIP.sql
-- Code-only guard installation. Existing requirements and tasks are not rewritten.

DO $guard$
BEGIN
 IF to_regprocedure('public.neo_event_requirement_ownership_guard()') IS NOT NULL THEN
   RAISE EXCEPTION 'Event requirement ownership guard already exists; inspect installed code first.';
 END IF;
 IF to_regclass('public.event_department_requirements') IS NULL
 OR to_regclass('public.event_bookings') IS NULL OR to_regclass('public.departments') IS NULL
 OR to_regclass('public.tasks') IS NULL THEN RAISE EXCEPTION 'Event ownership contracts are missing'; END IF;
END $guard$;

CREATE FUNCTION public.neo_event_requirement_ownership_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE booking public.event_bookings; owner public.departments; linked public.tasks;
        key text; candidates uuid[]; preferred boolean;
BEGIN
 SELECT * INTO booking FROM public.event_bookings WHERE id=NEW.booking_id FOR SHARE;
 IF booking.id IS NULL OR booking.organization_id IS DISTINCT FROM NEW.organization_id
 OR booking.organization_id IS DISTINCT FROM public.current_org_id() THEN
   RAISE EXCEPTION 'The event requirement must belong to a booking in this workspace' USING ERRCODE='42501';
 END IF;
 IF booking.branch_id IS NULL OR NOT coalesce(public.neo_branch_in_scope(booking.branch_id),false)
 OR (NEW.branch_id IS NOT NULL AND NEW.branch_id IS DISTINCT FROM booking.branch_id) THEN
   RAISE EXCEPTION 'The requirement property must match the event and your access scope' USING ERRCODE='42501';
 END IF;
 NEW.branch_id:=booking.branch_id;
 IF NEW.department_id IS NULL THEN
   key:=upper(replace(replace(btrim(coalesce(NEW.department_key,'')),'-','_'),' ','_'));
   -- Exact configured code/name, plus the existing BEO KITC -> KITC/REST/FNB rule.
   -- Prefer a property department over shared configuration; refuse ambiguous ownership.
   SELECT coalesce(bool_or(d.branch_id=booking.branch_id),false) INTO preferred
     FROM public.departments d WHERE d.organization_id=booking.organization_id AND d.active
      AND (d.branch_id=booking.branch_id OR d.branch_id IS NULL)
      AND (upper(coalesce(d.code,''))=key
       OR upper(replace(replace(d.name,'-','_'),' ','_'))=key
       OR (key='KITC' AND upper(coalesce(d.code,'')) IN ('REST','FNB')));
   SELECT array_agg(d.id ORDER BY d.id) INTO candidates
     FROM public.departments d WHERE d.organization_id=booking.organization_id AND d.active
      AND (CASE WHEN preferred THEN d.branch_id=booking.branch_id ELSE d.branch_id IS NULL END)
      AND (upper(coalesce(d.code,''))=key
       OR upper(replace(replace(d.name,'-','_'),' ','_'))=key
       OR (key='KITC' AND upper(coalesce(d.code,'')) IN ('REST','FNB')));
   IF coalesce(array_length(candidates,1),0)<>1 THEN
     RAISE EXCEPTION 'Choose one active configured department for this event requirement; automatic ownership is missing or ambiguous' USING ERRCODE='23514';
   END IF;
   NEW.department_id:=candidates[1];
 END IF;
 SELECT * INTO owner FROM public.departments WHERE id=NEW.department_id FOR SHARE;
 IF owner.id IS NULL OR owner.organization_id IS DISTINCT FROM booking.organization_id
 OR NOT coalesce(owner.active,false)
 OR (owner.branch_id IS NOT NULL AND owner.branch_id IS DISTINCT FROM booking.branch_id) THEN
   RAISE EXCEPTION 'Choose an active department belonging to this event property or shared workspace configuration' USING ERRCODE='23514';
 END IF;
 IF NEW.task_id IS NOT NULL THEN
   SELECT * INTO linked FROM public.tasks WHERE id=NEW.task_id FOR SHARE;
   IF linked.id IS NULL OR linked.organization_id IS DISTINCT FROM booking.organization_id
    OR linked.branch_id IS DISTINCT FROM booking.branch_id
    OR linked.department_id IS DISTINCT FROM NEW.department_id THEN
     RAISE EXCEPTION 'The linked event task must have the same workspace, property and department' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.neo_event_requirement_ownership_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER neo_event_requirement_ownership
 BEFORE INSERT OR UPDATE OF organization_id,branch_id,booking_id,department_id,department_key,task_id
 ON public.event_department_requirements FOR EACH ROW EXECUTE FUNCTION public.neo_event_requirement_ownership_guard();


-- 89_APPLY_RESERVATION_FOLIO_STATUS.sql
-- Savannah code-only repair. No historical reservation or financial balance is rewritten.

SET LOCAL search_path=public;
DO $guard$ BEGIN
 IF to_regprocedure('public.tg_folio_sync_reservation_payment_status()') IS NULL
 OR md5(pg_get_functiondef(to_regprocedure('public.tg_folio_sync_reservation_payment_status()'))) IS DISTINCT FROM '5f3323eab5b546028384e20ebbac35b6'
 THEN RAISE EXCEPTION 'Reservation folio status definition differs; inspect installed code first'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.folios')
  AND tgfoid=to_regprocedure('public.tg_folio_sync_reservation_payment_status()') AND tgenabled IN ('O','A')
  AND (tgtype & 1)=1 AND (tgtype & 2)=0 AND (tgtype & 16)=16
  AND tgname='folio_sync_reservation_payment_status' AND md5(pg_get_triggerdef(oid))='94c00281bde8d340443ecd2345cbb5cc')
 THEN RAISE EXCEPTION 'Expected active row-level AFTER UPDATE folio status trigger is missing'; END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.tg_folio_sync_reservation_payment_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE reservation public.reservations; paid numeric; outstanding numeric; next_status text; before_arrival boolean;
BEGIN
 IF NEW.reservation_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO reservation FROM public.reservations r
  WHERE r.id=NEW.reservation_id AND r.organization_id=NEW.organization_id
   AND r.branch_id IS NOT DISTINCT FROM NEW.branch_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 -- Preserve valid installed behavior for protected organizations outside this repair.
 IF reservation.organization_id IS DISTINCT FROM 'aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
  next_status:=CASE WHEN coalesce(NEW.total_payments,0)<=0 THEN 'unpaid'
   WHEN coalesce(NEW.balance,0)<=0 THEN 'paid' ELSE 'part-paid' END;
  UPDATE public.reservations r SET payment_status=next_status,updated_at=now()
   WHERE r.id=reservation.id AND r.organization_id=reservation.organization_id AND r.payment_status IS DISTINCT FROM next_status;
  RETURN NEW;
 END IF;
 IF EXISTS(SELECT 1 FROM public.folios f WHERE f.reservation_id=reservation.id
   AND f.organization_id=reservation.organization_id AND f.branch_id IS NOT DISTINCT FROM reservation.branch_id
   AND coalesce(f.status,'open') NOT IN ('void','voided')
   AND coalesce(f.currency,'KES') IS DISTINCT FROM coalesce(reservation.currency,'KES')) THEN
  RAISE EXCEPTION 'Reservation folio currencies differ; reconcile the currency evidence before updating payment status' USING ERRCODE='23514';
 END IF;
 IF EXISTS(SELECT 1 FROM public.folios f WHERE f.reservation_id=reservation.id
   AND f.organization_id=reservation.organization_id AND f.branch_id IS NOT DISTINCT FROM reservation.branch_id
   AND coalesce(f.status,'open') NOT IN ('void','voided') AND (f.total_payments IS NULL OR f.balance IS NULL)) THEN
  RAISE EXCEPTION 'Reservation folio amounts are incomplete' USING ERRCODE='23514';
 END IF;
 SELECT coalesce(sum(f.total_payments),0),coalesce(sum(f.balance),0) INTO paid,outstanding
  FROM public.folios f WHERE f.reservation_id=reservation.id AND f.organization_id=reservation.organization_id
   AND f.branch_id IS NOT DISTINCT FROM reservation.branch_id AND coalesce(f.status,'open') NOT IN ('void','voided');
 IF paid::text IN ('NaN','Infinity','-Infinity') OR outstanding::text IN ('NaN','Infinity','-Infinity') THEN
  RAISE EXCEPTION 'Reservation folio amounts are not finite' USING ERRCODE='23514';
 END IF;
 before_arrival:=reservation.status IN ('enquiry','on-hold','waitlisted','tentative','pending-deposit','confirmed','guaranteed','provisional-hold','awaiting-deposit');
 IF before_arrival AND coalesce(reservation.total_amount,0)::text IN ('NaN','Infinity','-Infinity') THEN
  RAISE EXCEPTION 'Reservation quote is not finite' USING ERRCODE='23514';
 END IF;
 next_status:=CASE
  WHEN paid<=0 THEN 'unpaid'
  WHEN outstanding>0 THEN 'part-paid'
  WHEN before_arrival AND (coalesce(reservation.total_amount,0)<=0 OR paid<reservation.total_amount) THEN 'part-paid'
  ELSE 'paid' END;
 UPDATE public.reservations r SET payment_status=next_status,updated_at=now()
  WHERE r.id=reservation.id AND r.organization_id=reservation.organization_id AND r.payment_status IS DISTINCT FROM next_status;
 RETURN NEW;
END;
$function$;

DROP TRIGGER folio_sync_reservation_payment_status ON public.folios;
CREATE TRIGGER folio_sync_reservation_payment_status AFTER UPDATE OF total_payments,balance,status,currency
 ON public.folios FOR EACH ROW EXECUTE FUNCTION public.tg_folio_sync_reservation_payment_status();


-- 91_APPLY_ROOM_READINESS.sql
-- Code-only Savannah room read models. No room, stay, task or reservation rows are updated.
-- Preserve existing function privileges and public return contracts. Do not run a historical backfill.

SET LOCAL search_path=public;
DO $guard$ BEGIN
 IF to_regprocedure('public.ops_room_state(uuid)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.ops_room_state(uuid)'))) IS DISTINCT FROM '2b90918a331868e431e51dc297ddfd34' THEN RAISE EXCEPTION 'Room readiness source differs: ops_room_state(uuid); inspect installed definitions before applying'; END IF;
 IF to_regprocedure('public.ops_room_availability(uuid,date,date)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.ops_room_availability(uuid,date,date)'))) IS DISTINCT FROM '2a429e73d1bb74169bcc32ccdf56e6d4' THEN RAISE EXCEPTION 'Room readiness source differs: ops_room_availability(uuid,date,date); inspect installed definitions before applying'; END IF;
 IF to_regprocedure('public.pms_available_rooms(uuid,date,date,uuid,integer,integer,uuid)') IS NULL OR md5(pg_get_functiondef(to_regprocedure('public.pms_available_rooms(uuid,date,date,uuid,integer,integer,uuid)'))) IS DISTINCT FROM '6c7728b31765a22a36d4d1c69f76fc28' THEN RAISE EXCEPTION 'Room readiness source differs: pms_available_rooms(uuid,date,date,uuid,integer,integer,uuid); inspect installed definitions before applying'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.ops_room_state(_branch uuid DEFAULT NULL::uuid)
 RETURNS TABLE(room_id uuid, room_number text, room_type_id uuid, room_type_name text, organization_id uuid, property_id uuid, floor text, building text, inventory_status text, occupancy_status text, housekeeping_status text, housekeeping_state text, readiness_state text, room_condition text, inspection_status text, maintenance_status text, out_of_order_reason text, sellable boolean, sellable_now boolean, sellability_reason text, exclusion_reasons text[], current_reservation_id uuid, current_confirmation_number text, arrival_today boolean, departure_today boolean, current_job_id uuid, current_task_id uuid, current_job_status text, assignee_id uuid, assignee_name text, pending_inspection boolean, last_cleaned_at timestamp with time zone, last_inspected_at timestamp with time zone, last_status_change timestamp with time zone, data_version timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT r.*, public.hk_canonical_condition(r.housekeeping_status) AS hk, rt.name AS rt_name,
      CASE WHEN r.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN (now() AT TIME ZONE coalesce(nullif(br.timezone,''),'Africa/Nairobi'))::date ELSE current_date END AS room_today
    FROM public.rooms r
    LEFT JOIN public.room_types rt ON rt.id = r.room_type_id
    LEFT JOIN public.branches br ON br.id=r.branch_id AND br.organization_id=r.organization_id
    WHERE r.organization_id=public.current_org_id() AND public.neo_branch_in_scope(r.branch_id)
      AND (_branch IS NULL OR r.branch_id = _branch)
  ),
  stay AS (
    SELECT DISTINCT ON (res.organization_id,res.room_id)
      res.organization_id, res.room_id, res.id, res.confirmation_number, res.arrival_date, res.departure_date, res.status
    FROM public.reservations res JOIN base b ON b.id=res.room_id AND b.organization_id=res.organization_id AND b.branch_id IS NOT DISTINCT FROM res.branch_id
    WHERE res.room_id IS NOT NULL
      AND CASE WHEN res.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
        res.status IN ('checked-in','in-house','checked_in','in_house') OR
        (res.status IN ('confirmed','on-hold','guaranteed') AND res.arrival_date<=b.room_today AND res.departure_date>=b.room_today)
      ELSE res.status IN ('confirmed','checked-in','in-house','on-hold','guaranteed') AND res.departure_date>=current_date END
    ORDER BY res.organization_id,res.room_id,
      CASE WHEN res.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND res.status IN ('checked-in','in-house','checked_in','in_house') THEN 0 ELSE 1 END,
      res.arrival_date,res.id
  ),
  job AS (
    SELECT DISTINCT ON (j.organization_id,j.room_id)
      j.organization_id,j.room_id, j.id, j.task_id, j.status, j.assignee_id
    FROM public.housekeeping_jobs j JOIN base b ON b.id=j.room_id AND b.organization_id=j.organization_id AND b.branch_id IS NOT DISTINCT FROM j.branch_id
    WHERE j.room_id IS NOT NULL AND public.hk_job_is_open(j.status, j.superseded_by)
    ORDER BY j.organization_id,j.room_id, j.created_at DESC,j.id DESC
  ),
  derived AS (
    SELECT b.*, s.id AS res_id, s.confirmation_number AS res_no,
      s.arrival_date, s.departure_date,
      job.id AS job_id, job.task_id, job.status AS job_status, job.assignee_id,
      coalesce(b.inspection_status,'not-required') AS insp,
      coalesce(b.maintenance_status,'operational') AS mt,
      CASE WHEN b.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND s.status IN ('checked-in','in-house','checked_in','in_house') THEN 'occupied' ELSE coalesce(b.occupancy_status,'vacant') END AS occ,
      coalesce(b.status,'active') AS inv,
      CASE
        WHEN b.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND job.status='rework' THEN 'rework_required'
        WHEN b.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND job.status='awaiting-inspection' THEN 'awaiting_inspection'
        WHEN b.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND job.id IS NOT NULL THEN
          CASE WHEN job.status IN ('in-progress','in_progress','cleaning') THEN 'cleaning_in_progress' ELSE 'cleaning_queued' END
        WHEN b.hk = 'rework' OR coalesce(b.inspection_status,'not-required') = 'failed' THEN 'rework_required'
        WHEN b.hk = 'awaiting_inspection' OR (b.hk IN ('clean','inspected') AND coalesce(b.inspection_status,'not-required') = 'pending')
          THEN 'awaiting_inspection'
        WHEN b.hk = 'cleaning_in_progress' THEN 'cleaning_in_progress'
        WHEN b.hk = 'cleaning_queued' THEN 'cleaning_queued'
        WHEN b.hk = 'dirty' THEN 'dirty'
        WHEN b.hk IN ('clean','inspected') THEN 'ready'
        ELSE b.hk
      END AS hk_state,
      job.status IS NOT NULL AS has_open_job
    FROM base b
    LEFT JOIN stay s ON s.room_id = b.id AND s.organization_id=b.organization_id
    LEFT JOIN job ON job.room_id = b.id AND job.organization_id=b.organization_id
  )
  SELECT
    d.id, d.room_number, d.room_type_id, d.rt_name, d.organization_id, d.branch_id,
    d.floor, d.building,
    d.inv, d.occ, d.hk, d.hk_state,
    CASE WHEN d.hk_state='ready' AND d.mt='operational' AND d.occ='vacant' AND d.inv='active'
         THEN 'ready' ELSE 'not_ready' END,
    d.room_condition, d.insp, d.mt, d.out_of_order_reason,
    (d.inv='active' AND d.occ='vacant' AND d.mt='operational' AND d.hk_state='ready'),
    (d.inv='active' AND d.occ='vacant' AND d.mt='operational' AND d.hk_state='ready' AND d.res_id IS NULL),
    CASE
      WHEN d.inv <> 'active' THEN 'Room inventory is not active'
      WHEN d.mt = 'out-of-order' THEN coalesce('Out of order: '||d.out_of_order_reason,'Out of order')
      WHEN d.mt = 'out-of-service' THEN coalesce('Out of service: '||d.out_of_order_reason,'Out of service')
      WHEN d.mt = 'under-maintenance' THEN 'Maintenance block in place'
      WHEN d.occ = 'occupied' THEN 'Currently occupied'
      WHEN d.occ = 'house-use' THEN 'Reserved for house use'
      WHEN d.hk_state <> 'ready' THEN 'Housekeeping: '||replace(d.hk_state,'_',' ')
      WHEN d.res_id IS NOT NULL THEN 'Held by reservation '||coalesce(d.res_no,'')
      ELSE 'Sellable'
    END,
    (SELECT array_remove(ARRAY[
        CASE WHEN d.inv <> 'active' THEN 'inventory-inactive' END,
        CASE WHEN d.mt <> 'operational' THEN 'maintenance-'||d.mt END,
        CASE WHEN d.occ <> 'vacant' THEN 'occupancy-'||d.occ END,
        CASE WHEN d.hk_state <> 'ready' THEN 'housekeeping-'||d.hk_state END,
        CASE WHEN d.res_id IS NOT NULL THEN 'reservation-hold' END
      ], NULL)),
    d.res_id, d.res_no,
    (d.arrival_date = d.room_today), (d.departure_date = d.room_today),
    d.job_id, d.task_id, d.job_status, d.assignee_id, p.full_name,
    (d.insp = 'pending'),
    d.last_cleaned_at, d.last_inspected_at, d.updated_at, d.updated_at
  FROM derived d
  LEFT JOIN public.profiles p ON p.id = d.assignee_id
  ORDER BY d.room_number;
$function$;

CREATE OR REPLACE FUNCTION public.ops_room_availability(_branch uuid, _from date, _to date)
RETURNS TABLE(
  room_id uuid, room_number text, room_type_id uuid, room_type_name text,
  housekeeping_state text, maintenance_status text, occupancy_status text,
  sellable_now boolean, available_for_requested_dates boolean,
  exclusion_reasons text[], data_version timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  WITH s AS (
    SELECT rs.*,CASE WHEN rs.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN (now() AT TIME ZONE coalesce(nullif(br.timezone,''),'Africa/Nairobi'))::date ELSE current_date END AS room_today
    FROM public.ops_room_state(_branch) rs LEFT JOIN public.branches br ON br.id=rs.property_id AND br.organization_id=rs.organization_id
    WHERE rs.organization_id = public.current_org_id() AND public.neo_branch_in_scope(rs.property_id)
      AND _from IS NOT NULL AND _to IS NOT NULL AND _from<_to
  ), overlap AS (
    SELECT s.room_id,
      array_remove(ARRAY[
        CASE WHEN EXISTS (
          SELECT 1 FROM public.reservations r
          WHERE r.room_id = s.room_id
            AND r.organization_id=s.organization_id AND ((r.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND r.status IN ('checked-in','in-house','checked_in','in_house') AND r.departure_date<s.room_today) OR
              ((r.status IN ('confirmed','guaranteed','checked-in','in-house') OR (r.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND r.status IN ('checked_in','in_house')))
               AND daterange(r.arrival_date, r.departure_date, '[)') && daterange(_from, _to, '[)')))
        ) THEN 'reservation-overlap' END,
        CASE WHEN EXISTS (
          SELECT 1 FROM public.room_assignments a
          WHERE a.room_id = s.room_id AND a.status='active'
            AND daterange(a.start_date, a.end_date, '[)') && daterange(_from, _to, '[)')
        ) THEN 'assignment-overlap' END,
        CASE WHEN EXISTS (
          SELECT 1 FROM public.room_blocks b
          WHERE b.room_id = s.room_id AND b.status='active'
            AND daterange(b.start_date, b.end_date, '[]') && daterange(_from, _to, '[)')
        ) THEN 'room-block' END,
        CASE WHEN EXISTS (
          SELECT 1 FROM public.reservation_holds h
          WHERE h.room_id = s.room_id AND h.status='active' AND h.hold_expires_at > now()
            AND daterange(h.arrival_date, h.departure_date, '[)') && daterange(_from, _to, '[)')
        ) THEN 'active-hold' END
      ], NULL) AS reasons
    FROM s
  ), ooo AS (
    SELECT r.id AS room_id,
      (r.out_of_order_from IS NOT NULL
        AND daterange(r.out_of_order_from, coalesce(r.out_of_order_to, 'infinity'::date), '[]')
            && daterange(_from, _to, '[)')) AS blocked
    FROM public.rooms r
  )
  SELECT s.room_id, s.room_number, s.room_type_id, s.room_type_name,
    s.housekeeping_state, s.maintenance_status, s.occupancy_status,
    s.sellable_now,
    (s.maintenance_status = 'operational'
      AND s.inventory_status = 'active'
      AND coalesce(array_length(o.reasons,1),0) = 0
      AND NOT coalesce(x.blocked,false)
      AND (_from > s.room_today OR (s.housekeeping_state = 'ready' AND (s.organization_id<>'aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid OR s.occupancy_status='vacant')))),
    (o.reasons
      || CASE WHEN s.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND _from<=s.room_today AND s.occupancy_status<>'vacant' THEN ARRAY['occupancy-'||s.occupancy_status] ELSE ARRAY[]::text[] END
      || CASE WHEN coalesce(x.blocked,false) THEN ARRAY['out-of-order-period'] ELSE ARRAY[]::text[] END
      || CASE WHEN s.maintenance_status <> 'operational' THEN ARRAY['maintenance-'||s.maintenance_status] ELSE ARRAY[]::text[] END
      || CASE WHEN _from <= s.room_today AND s.housekeeping_state <> 'ready'
              THEN ARRAY['housekeeping-'||s.housekeeping_state] ELSE ARRAY[]::text[] END),
    s.data_version
  FROM s
  JOIN overlap o ON o.room_id = s.room_id
  JOIN ooo x ON x.room_id = s.room_id
  ORDER BY s.room_number;
$function$;

CREATE OR REPLACE FUNCTION public.pms_available_rooms(
  _branch uuid,
  _arrival date,
  _departure date,
  _room_type uuid DEFAULT NULL::uuid,
  _adults integer DEFAULT 1,
  _children integer DEFAULT 0,
  _for_group uuid DEFAULT NULL::uuid
)
RETURNS TABLE(
  room_id uuid,
  room_number text,
  room_type_id uuid,
  room_type_name text,
  floor text,
  branch_id uuid,
  branch_name text,
  max_occupancy integer,
  readiness text,
  maintenance_status text,
  occupancy_status text,
  nights integer,
  qualification text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH bounds AS (
    SELECT _arrival AS a, _departure AS d,
           GREATEST(_departure - _arrival, 0)::int AS n
  ), candidates AS (
    SELECT r.id, r.room_number, r.room_type_id AS rt_id, rt.name AS rtname, r.floor,
           r.branch_id, b.name AS bname,
           COALESCE(rt.max_occupancy, 0)::int AS cap,
           CASE
             WHEN r.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN rs.housekeeping_state
             WHEN public.hk_canonical_condition(r.housekeeping_status) IN ('clean','inspected')
                  AND coalesce(r.inspection_status,'not-required') IN ('not-required','passed')
               THEN 'ready'
             ELSE public.hk_canonical_condition(r.housekeeping_status)
           END AS readiness,
           r.maintenance_status,
           CASE WHEN r.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN rs.occupancy_status ELSE coalesce(r.occupancy_status,'vacant') END AS occupancy_status,
           row_number() OVER (PARTITION BY r.room_type_id ORDER BY r.room_number DESC) AS rn
    FROM public.rooms r
    LEFT JOIN public.room_types rt ON rt.id = r.room_type_id
    LEFT JOIN public.branches b ON b.id = r.branch_id
    JOIN public.ops_room_state(_branch) rs ON rs.room_id=r.id AND rs.organization_id=r.organization_id
    CROSS JOIN bounds
    CROSS JOIN LATERAL (SELECT CASE WHEN r.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN (now() AT TIME ZONE coalesce(nullif(b.timezone,''),'Africa/Nairobi'))::date ELSE current_date END AS room_today) clock
    WHERE public.neo_branch_in_scope(r.branch_id) AND r.organization_id = public.current_org_id()
      AND (_branch IS NULL OR r.branch_id = _branch)
      AND r.status = 'active'
      AND r.maintenance_status = 'operational'
      AND (_room_type IS NULL OR r.room_type_id = _room_type)
      AND (rt.id IS NULL OR rt.max_occupancy >= (COALESCE(_adults,1) + COALESCE(_children,0)))
      AND bounds.n > 0 AND coalesce(_adults,1)>=1 AND coalesce(_children,0)>=0
      -- Same-day and in-progress stays must also be physically ready.
      AND (bounds.a > clock.room_today
           OR (r.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND rs.sellable)
           OR (r.organization_id<>'aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND public.hk_canonical_condition(r.housekeeping_status) IN ('clean','inspected')
               AND coalesce(r.inspection_status,'not-required') IN ('not-required','passed')
               AND coalesce(r.occupancy_status,'vacant') = 'vacant'))
      AND NOT (r.out_of_order_from IS NOT NULL
               AND daterange(r.out_of_order_from, coalesce(r.out_of_order_to,'infinity'::date), '[]')
                   && daterange(bounds.a, bounds.d, '[)'))
      AND NOT EXISTS (
        SELECT 1 FROM public.reservations res
        WHERE res.room_id = r.id
          AND res.organization_id=r.organization_id AND ((res.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND res.status IN ('checked-in','in-house','checked_in','in_house') AND res.departure_date<clock.room_today) OR
            ((res.status IN ('confirmed','guaranteed','checked-in','in-house') OR (res.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND res.status IN ('checked_in','in_house')))
             AND daterange(res.arrival_date, res.departure_date, '[)') && daterange(bounds.a, bounds.d, '[)'))))
      AND NOT EXISTS (
        SELECT 1 FROM public.room_assignments a
        WHERE a.room_id = r.id AND a.status = 'active'
          AND daterange(a.start_date, a.end_date, '[)') && daterange(bounds.a, bounds.d, '[)'))
      AND NOT EXISTS (
        SELECT 1 FROM public.room_blocks bl
        WHERE bl.room_id = r.id AND bl.status = 'active'
          AND daterange(bl.start_date, bl.end_date, '[]') && daterange(bounds.a, bounds.d, '[)'))
      AND NOT EXISTS (
        SELECT 1 FROM public.reservation_holds h
        WHERE h.room_id = r.id AND h.status = 'active' AND h.hold_expires_at > now()
          AND daterange(h.arrival_date, h.departure_date, '[)') && daterange(bounds.a, bounds.d, '[)'))
  ), held AS (
    SELECT gb.room_type_id AS rt_id,
           COALESCE(sum(GREATEST(gb.rooms_blocked - gb.rooms_picked_up - gb.rooms_released,0)),0)::int AS qty
    FROM public.group_room_blocks gb
    JOIN public.group_bookings g ON g.id = gb.group_booking_id
    CROSS JOIN bounds
    WHERE gb.status = 'active' AND g.organization_id = public.current_org_id()
      AND g.status NOT IN ('cancelled','closed')
      AND (_branch IS NULL OR g.branch_id = _branch)
      AND (_for_group IS NULL OR gb.group_booking_id <> _for_group)
      AND daterange(gb.start_date, gb.end_date, '[]') && daterange(bounds.a, bounds.d, '[)')
    GROUP BY gb.room_type_id
  ), demand AS (
    -- Confirmed/guaranteed stays that have no room yet still consume inventory
    -- of their room type; otherwise the same room type is sold twice.
    SELECT res.room_type_id AS rt_id, count(*)::int AS qty
    FROM public.reservations res
    CROSS JOIN bounds
    WHERE res.organization_id = public.current_org_id()
      AND res.room_id IS NULL
      AND res.room_type_id IS NOT NULL
      AND res.status IN ('confirmed','guaranteed')
      AND (_branch IS NULL OR res.branch_id = _branch)
      AND (_for_group IS NULL OR res.group_booking_id IS DISTINCT FROM _for_group)
      AND daterange(res.arrival_date, res.departure_date, '[)') && daterange(bounds.a, bounds.d, '[)')
    GROUP BY res.room_type_id
  )
  SELECT c.id, c.room_number, c.rt_id, c.rtname, c.floor, c.branch_id, c.bname,
         c.cap, c.readiness, c.maintenance_status, c.occupancy_status,
         (SELECT n FROM bounds),
         'Sellable, no overlapping stay, assignment, block, hold or group inventory for '
           || to_char((SELECT a FROM bounds),'YYYY-MM-DD') || ' → '
           || to_char((SELECT d FROM bounds),'YYYY-MM-DD')
  FROM candidates c
  LEFT JOIN held h ON h.rt_id = c.rt_id
  LEFT JOIN demand dm ON dm.rt_id = c.rt_id
  WHERE c.rn > COALESCE(h.qty, 0) + COALESCE(dm.qty, 0)
  ORDER BY c.bname NULLS LAST, c.room_number;
$function$;


COMMIT;
BEGIN READ ONLY;
SELECT jsonb_build_object(
'diagnostic_version','workflow-code-bundle-live-v1',
'read_only',current_setting('transaction_read_only'),
'draft',(WITH expected(signature, fingerprint) AS (VALUES
 ('public.neo_pos_remove_draft(uuid,text)', 'e64d35e24c1c836e4f3af308102c82ee'),
 ('public.neo_pos_removed_draft_write_guard()', 'c44cb8d9f0684bac8acf3eb1fb8b3da5')
), definitions AS (
 SELECT signature, to_regprocedure(signature) IS NOT NULL
   AND md5(pg_get_functiondef(to_regprocedure(signature))) = fingerprint AS matches
 FROM expected
)
SELECT jsonb_build_object(
 'diagnostic_version','draft-removal-install-v1',
 'read_only',current_setting('transaction_read_only'),
 'code', (SELECT jsonb_agg(to_jsonb(d)) FROM definitions d),
 'definitions_match', (SELECT bool_and(matches) FROM definitions),
 'scope','Code installation only; no order removal or full workflow certification.'
) AS diagnostic),
'events',(SELECT jsonb_build_object(
 'diagnostic_version','event-requirement-ownership-install-v1',
 'read_only',current_setting('transaction_read_only'),
 'definition_matches',coalesce(md5(pg_get_functiondef(to_regprocedure('public.neo_event_requirement_ownership_guard()')))='f4370deb89cf9c129a0c8c804c60ed42',false),
 'trigger_enabled',EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.event_department_requirements') AND tgname='neo_event_requirement_ownership' AND tgenabled='O'),
 'helper_private',CASE WHEN to_regprocedure('public.neo_event_requirement_ownership_guard()') IS NULL THEN false ELSE
  NOT has_function_privilege('anon','public.neo_event_requirement_ownership_guard()','execute')
  AND NOT has_function_privilege('authenticated','public.neo_event_requirement_ownership_guard()','execute') END,
 'scope','Code installation only. Existing requirements/tasks are not rewritten; historical null ownership requires explicit review. Full BEO handoffs remain separate.'
) AS diagnostic),
'folio',(SELECT jsonb_build_object(
 'diagnostic_version','reservation-folio-status-install-v1',
 'read_only',current_setting('transaction_read_only'),
 'definition_matches',coalesce(md5(pg_get_functiondef(to_regprocedure('public.tg_folio_sync_reservation_payment_status()')))='ce2c9bbed195311a903704ecc2f6a5ff',false),
 'trigger_matches',EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.folios') AND tgname='folio_sync_reservation_payment_status'
   AND tgenabled IN ('O','A') AND md5(pg_get_triggerdef(oid))='10f8dc9c5804c831bdf68731aede8505'),
 'scope','Installed Savannah status code only. No historical status reconciliation, deposit, payment, balance or journal is created or rewritten. Valid other-organization behavior is preserved.'
) AS diagnostic),
'rooms',(WITH expected(signature,definition_md5) AS (VALUES ('ops_room_state(uuid)','5fdd347962dfacb2fc93ebaedf42a348'),
('ops_room_availability(uuid,date,date)','0613e5026b13e25a75960c240fce7293'),
('pms_available_rooms(uuid,date,date,uuid,integer,integer,uuid)','9e36e6b7f47c1f87cda18d9724896f56')), code AS (
 SELECT signature,coalesce(md5(pg_get_functiondef(to_regprocedure('public.'||signature)))=definition_md5,false) AS matches FROM expected
)
SELECT jsonb_build_object('diagnostic_version','room-readiness-code-postcheck-v1','read_only',current_setting('transaction_read_only'),
 'definitions_match',(SELECT bool_and(matches) FROM code),'code',(SELECT jsonb_agg(to_jsonb(code)) FROM code),
 'scope','Code definitions only; no physical room release, stay checkout, task completion or full department acceptance is certified.') AS diagnostic)
) AS diagnostic;
COMMIT;
