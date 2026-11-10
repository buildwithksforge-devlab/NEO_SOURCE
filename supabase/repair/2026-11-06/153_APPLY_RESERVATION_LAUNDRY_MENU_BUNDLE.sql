-- Run the entire file. Code installation only; no operational transaction is executed.
BEGIN;
-- 148_APPLY_MENU_SALE_REMOVAL_GUARDS.sql
DO $guard$ BEGIN
 IF to_regprocedure('public.neo_pos_sellable_menu_guard()') IS NOT NULL OR to_regprocedure('public.neo_menu_remove_item(uuid,text,text)') IS NOT NULL THEN RAISE EXCEPTION 'Menu sale/removal repair already exists; use postcheck, not reinstall'; END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='menu_items' AND column_name='publish_status') THEN RAISE EXCEPTION 'Menu schema differs'; END IF;
END $guard$;
CREATE FUNCTION public.neo_pos_sellable_menu_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE item public.menu_items; sale public.pos_orders; menu public.menus; property_today date; property_time time;
BEGIN
 IF NEW.menu_item_id IS NULL OR NEW.status IN ('cancelled','voided') THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND NEW.menu_item_id IS NOT DISTINCT FROM OLD.menu_item_id AND NEW.quantity<=OLD.quantity AND NOT (OLD.status='draft' AND NEW.status='sent') THEN RETURN NEW; END IF;
 SELECT * INTO sale FROM public.pos_orders WHERE id=NEW.order_id AND organization_id=NEW.organization_id FOR UPDATE;
 IF sale.id IS NULL THEN RAISE EXCEPTION 'The order could not be verified'; END IF;
 SELECT * INTO item FROM public.menu_items WHERE id=NEW.menu_item_id AND organization_id=NEW.organization_id FOR SHARE;
 IF item.id IS NULL OR (item.branch_id IS NOT NULL AND item.branch_id IS DISTINCT FROM sale.branch_id) THEN RAISE EXCEPTION 'Menu item does not belong to this order property'; END IF;
 IF item.availability IS DISTINCT FROM 'available' OR item.publish_status IS DISTINCT FROM 'published' THEN RAISE EXCEPTION 'This menu item is disabled, unavailable or unpublished. Refresh the menu before ordering.' USING ERRCODE='23514'; END IF;
 SELECT (now() AT TIME ZONE coalesce(nullif(btrim(b.timezone),''),'Africa/Nairobi'))::date,(now() AT TIME ZONE coalesce(nullif(btrim(b.timezone),''),'Africa/Nairobi'))::time INTO property_today,property_time FROM public.branches b WHERE b.id=sale.branch_id AND b.organization_id=sale.organization_id;
 IF property_today IS NULL THEN RAISE EXCEPTION 'Order property clock could not be verified'; END IF;
 IF (item.active_from IS NOT NULL AND property_today<item.active_from) OR (item.active_to IS NOT NULL AND property_today>item.active_to) THEN RAISE EXCEPTION 'This menu item is outside its selling dates'; END IF;
 IF item.category_id IS NOT NULL THEN
  SELECT m.* INTO menu FROM public.menus m JOIN public.menu_categories c ON c.menu_id=m.id AND c.organization_id=m.organization_id WHERE c.id=item.category_id AND m.organization_id=item.organization_id FOR SHARE OF m;
  IF menu.id IS NOT NULL THEN
   IF menu.status IS DISTINCT FROM 'active' OR (menu.branch_id IS NOT NULL AND menu.branch_id IS DISTINCT FROM sale.branch_id) OR (menu.valid_from IS NOT NULL AND property_today<menu.valid_from) OR (menu.valid_to IS NOT NULL AND property_today>menu.valid_to) OR NOT (extract(dow FROM property_today)::int=ANY(menu.valid_days)) THEN RAISE EXCEPTION 'The parent menu is inactive or outside its selling schedule'; END IF;
   IF menu.valid_time_from IS NOT NULL AND menu.valid_time_to IS NOT NULL AND NOT (CASE WHEN menu.valid_time_from<=menu.valid_time_to THEN property_time BETWEEN menu.valid_time_from AND menu.valid_time_to ELSE property_time>=menu.valid_time_from OR property_time<=menu.valid_time_to END) THEN RAISE EXCEPTION 'The parent menu is outside its serving hours'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.neo_pos_sellable_menu_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER neo_pos_sellable_menu_guard_trg BEFORE INSERT OR UPDATE OF menu_item_id,quantity,status ON public.pos_order_items FOR EACH ROW EXECUTE FUNCTION public.neo_pos_sellable_menu_guard();
CREATE FUNCTION public.neo_menu_remove_item(_item uuid,_mode text DEFAULT 'archive',_reason text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE org uuid:=public.current_org_id(); item public.menu_items; ref record; used boolean;
BEGIN
 IF auth.uid() IS NULL OR org IS NULL OR NOT (public.has_permission('restaurant','menu','delete') OR public.is_org_admin()) THEN RAISE EXCEPTION 'Not permitted to remove menu items' USING ERRCODE='42501'; END IF;
 IF _mode NOT IN ('archive','delete-draft') OR nullif(btrim(_reason),'') IS NULL THEN RAISE EXCEPTION 'Select removal mode and provide a reason'; END IF;
 SELECT * INTO item FROM public.menu_items WHERE id=_item AND organization_id=org FOR UPDATE;
 IF item.id IS NULL OR NOT coalesce(public.neo_branch_in_scope(item.branch_id),false) THEN RAISE EXCEPTION 'Menu item not found in your property scope' USING ERRCODE='42501'; END IF;
 IF _mode='archive' THEN
  IF item.publish_status='archived' AND item.availability='disabled' THEN RETURN jsonb_build_object('ok',true,'item_id',_item,'mode',_mode,'idempotent',true); END IF;
  UPDATE public.menu_items SET publish_status='archived',availability='disabled',updated_at=now() WHERE id=_item AND organization_id=org;
 ELSE
  IF item.publish_status IS DISTINCT FROM 'draft' OR item.published_at IS NOT NULL THEN RAISE EXCEPTION 'Only an unused, unpublished draft can be permanently deleted. Archive this item instead.'; END IF;
  FOR ref IN SELECT c.conrelid::regclass AS target,a.attname AS column_name FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey,c.confkey) AS keys(child,parent) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=keys.child JOIN pg_attribute p ON p.attrelid=c.confrelid AND p.attnum=keys.parent WHERE c.contype='f' AND c.confrelid='public.menu_items'::regclass AND p.attname='id' LOOP
   EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s WHERE %I=$1)',ref.target,ref.column_name) INTO used USING _item;
   IF used THEN RAISE EXCEPTION 'This item has linked sales or configuration. Archive it to preserve history.'; END IF;
  END LOOP;
  DELETE FROM public.menu_items WHERE id=_item AND organization_id=org;
 END IF;
 INSERT INTO public.audit_logs(organization_id,branch_id,user_id,user_name,action,module,record_id,previous_value,new_value,reason) VALUES(org,item.branch_id,auth.uid(),'','restaurant.menu.item_removed','restaurant',_item::text,to_jsonb(item),jsonb_build_object('mode',_mode),btrim(_reason));
 RETURN jsonb_build_object('ok',true,'item_id',_item,'mode',_mode);
END $function$;
REVOKE ALL ON FUNCTION public.neo_menu_remove_item(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_menu_remove_item(uuid,text,text) TO authenticated;
NOTIFY pgrst,'reload schema';

-- 150_APPLY_RESERVATION_COLLECTION_CHAIN.sql
DO $guard$ BEGIN
 IF to_regprocedure('public.neo_reservation_collection_facts(uuid,uuid,uuid)') IS NOT NULL THEN RAISE EXCEPTION 'Reservation collection repair exists; use postcheck'; END IF;
 IF md5(pg_get_functiondef(to_regprocedure('public.neo_reservation_financial_state_sync(uuid)'))) IS DISTINCT FROM '8f5dfad9ec7ead8e1fe445362ce513a5' OR md5(pg_get_functiondef(to_regprocedure('public.tg_folio_sync_reservation_payment_status()'))) IS DISTINCT FROM '55418aec7f0773bafaf29ad7836bad2f' THEN RAISE EXCEPTION 'Reservation state definitions differ; inspect before installation'; END IF;
END $guard$;
CREATE FUNCTION public.neo_reservation_collection_facts(_reservation uuid,_exclude_payment uuid DEFAULT NULL,_exclude_request uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
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
 IF EXISTS(SELECT 1 FROM public.payments p WHERE p.organization_id=booking.organization_id AND p.status IN ('confirmed','completed','posted','paid','settled','succeeded','captured','pending','processing','submitted','initiated') AND ((p.folio_id IS NULL AND p.reservation_id=booking.id) OR EXISTS(SELECT 1 FROM public.folios f WHERE f.id=p.folio_id AND f.reservation_id=booking.id AND f.organization_id=booking.organization_id AND f.status NOT IN ('void','voided','cancelled'))) AND (p.branch_id IS DISTINCT FROM booking.branch_id OR p.currency IS DISTINCT FROM cur OR p.amount IS NULL OR p.amount<=0 OR p.amount::text IN ('NaN','Infinity','-Infinity'))) THEN RAISE EXCEPTION 'Payment amount, property or currency evidence needs review'; END IF;
 SELECT coalesce(sum(d.amount),0) INTO deposits FROM public.reservation_deposits d WHERE d.reservation_id=booking.id AND d.organization_id=booking.organization_id AND d.branch_id IS NOT DISTINCT FROM booking.branch_id AND d.status IN ('held','applied');
 SELECT coalesce(sum(p.amount) FILTER(WHERE p.status IN ('confirmed','completed','posted','paid','settled','succeeded','captured')),0),coalesce(sum(p.amount) FILTER(WHERE p.status IN ('pending','processing','submitted','initiated')),0) INTO collected,pending FROM public.payments p WHERE p.organization_id=booking.organization_id AND p.branch_id IS NOT DISTINCT FROM booking.branch_id AND p.id IS DISTINCT FROM _exclude_payment AND ((p.folio_id IS NULL AND p.reservation_id=booking.id) OR EXISTS(SELECT 1 FROM public.folios f WHERE f.id=p.folio_id AND f.reservation_id=booking.id AND f.organization_id=booking.organization_id AND f.status NOT IN ('void','voided','cancelled'))) AND NOT EXISTS(SELECT 1 FROM public.reservation_deposits d WHERE d.payment_id=p.id AND d.organization_id=p.organization_id AND d.reservation_id=booking.id AND d.status IN ('held','applied'));
 SELECT coalesce(sum(fl.net_amount) FILTER(WHERE fl.category='accommodation'),0),coalesce(sum(fl.net_amount) FILTER(WHERE fl.category IS DISTINCT FROM 'accommodation'),0) INTO room_charges,extras FROM public.folio_lines fl JOIN public.folios f ON f.id=fl.folio_id AND f.organization_id=fl.organization_id WHERE f.reservation_id=booking.id AND f.organization_id=booking.organization_id AND f.branch_id IS NOT DISTINCT FROM booking.branch_id AND f.status NOT IN ('void','voided','cancelled') AND coalesce(fl.status,'posted') NOT IN ('void','voided','reversed','cancelled') AND coalesce(fl.line_type,'charge') NOT IN ('payment','deposit','refund');
 IF EXISTS(SELECT 1 FROM public.cash_payment_requests r JOIN public.folios f ON f.id=r.folio_id AND f.organization_id=r.organization_id WHERE f.reservation_id=booking.id AND f.organization_id=booking.organization_id AND r.status='pending' AND (r.branch_id IS DISTINCT FROM booking.branch_id OR r.currency IS DISTINCT FROM cur OR r.amount IS NULL OR r.amount<=0 OR r.amount::text IN ('NaN','Infinity','-Infinity'))) THEN RAISE EXCEPTION 'Pending cash amount, property or currency needs review'; END IF;
 SELECT coalesce(sum(r.amount),0) INTO cash_pending FROM public.cash_payment_requests r WHERE r.organization_id=booking.organization_id AND r.branch_id IS NOT DISTINCT FROM booking.branch_id AND r.status='pending' AND r.id IS DISTINCT FROM _exclude_request AND EXISTS(SELECT 1 FROM public.folios f WHERE f.id=r.folio_id AND f.reservation_id=booking.id AND f.organization_id=booking.organization_id AND f.status NOT IN ('void','voided','cancelled'));
 IF deposits::text IN ('NaN','Infinity','-Infinity') OR collected::text IN ('NaN','Infinity','-Infinity') OR pending::text IN ('NaN','Infinity','-Infinity') OR cash_pending::text IN ('NaN','Infinity','-Infinity') OR room_charges::text IN ('NaN','Infinity','-Infinity') OR extras::text IN ('NaN','Infinity','-Infinity') OR pending<0 OR cash_pending<0 THEN RAISE EXCEPTION 'Reservation collection amounts are incomplete or non-finite'; END IF;
 collected:=collected+deposits;
 obligation:=greatest(0,CASE WHEN booking.status IN ('cancelled','no-show','checked-out','checked_out','departed') THEN room_charges+extras ELSE greatest(booking.total_amount,room_charges)+extras END);
 required:=coalesce(booking.deposit_required,0);
 IF required<0 OR required::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Deposit requirement is invalid'; END IF;
 RETURN jsonb_build_object('reservation_id',booking.id,'currency',cur,'quote',booking.total_amount,'posted_room_charges',room_charges,'posted_extras',extras,'obligation',round(obligation,2),'deposit_paid',deposits,'collected',round(collected,2),'pending',round(pending+cash_pending,2),'outstanding',round(greatest(obligation-collected,0),2),'credit',round(greatest(collected-obligation,0),2),'headroom',round(greatest(obligation-collected-pending-cash_pending,0),2),'payment_status',CASE WHEN collected<=0 THEN 'unpaid' WHEN obligation>0 AND collected+0.009>=obligation THEN 'paid' ELSE 'part-paid' END,'minimum_deposit_satisfied',required>0 AND deposits+0.009>=required);
END $function$;
REVOKE ALL ON FUNCTION public.neo_reservation_collection_facts(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.neo_reservation_collection_position(_reservation uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE booking public.reservations;
BEGIN
 IF auth.uid() IS NULL OR NOT (public.has_permission('pms','reservations.view') OR public.can_read_guest_ledger() OR public.has_permission('finance','view') OR public.is_org_admin()) THEN RAISE EXCEPTION 'Not permitted to read reservation collections' USING ERRCODE='42501'; END IF;
 SELECT * INTO booking FROM public.reservations WHERE id=_reservation AND organization_id=public.current_org_id();
 IF booking.id IS NULL OR NOT coalesce(public.neo_branch_in_scope(booking.branch_id),false) THEN RAISE EXCEPTION 'Reservation is outside your workspace or property' USING ERRCODE='42501'; END IF;
 RETURN public.neo_reservation_collection_facts(_reservation);
END $function$;
REVOKE ALL ON FUNCTION public.neo_reservation_collection_position(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_reservation_collection_position(uuid) TO authenticated;
CREATE FUNCTION public.neo_pms_collection_lock(_folio uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE source public.folios;
BEGIN
 SELECT * INTO source FROM public.folios WHERE id=_folio AND organization_id=public.current_org_id();
 IF source.id IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended(source.organization_id::text||':reservation-collection:'||coalesce(source.reservation_id,source.id)::text,0)); END IF;
END $function$;
REVOKE ALL ON FUNCTION public.neo_pms_collection_lock(uuid) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.neo_pms_collection_headroom(_folio uuid,_exclude_payment uuid DEFAULT NULL,_exclude_request uuid DEFAULT NULL) RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $function$
DECLARE source public.folios; reserved numeric;
BEGIN
 SELECT * INTO source FROM public.folios WHERE id=_folio AND organization_id=public.current_org_id();
 IF source.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
 IF source.reservation_id IS NOT NULL THEN RETURN (public.neo_reservation_collection_facts(source.reservation_id,_exclude_payment,_exclude_request)->>'headroom')::numeric; END IF;
 SELECT coalesce(sum(p.amount),0) INTO reserved FROM public.payments p WHERE p.organization_id=source.organization_id AND p.folio_id=source.id AND p.id IS DISTINCT FROM _exclude_payment AND p.status IN ('pending','processing','submitted','initiated');
 SELECT reserved+coalesce(sum(r.amount),0) INTO reserved FROM public.cash_payment_requests r WHERE r.organization_id=source.organization_id AND r.folio_id=source.id AND r.id IS DISTINCT FROM _exclude_request AND r.status='pending';
 IF source.balance IS NULL OR source.balance::text IN ('NaN','Infinity','-Infinity') OR reserved::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Folio collection amounts could not be verified'; END IF;
 RETURN greatest(source.balance-reserved,0);
END $function$;
REVOKE ALL ON FUNCTION public.neo_pms_collection_headroom(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.neo_reservation_financial_state_sync(_reservation uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_paid numeric; v_required numeric; v_status text; facts jsonb;
BEGIN
  IF _reservation IS NULL THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM public.reservations r WHERE r.id=_reservation AND r.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid) THEN
    facts:=public.neo_reservation_collection_facts(_reservation);
    UPDATE public.reservations r SET deposit_paid=(facts->>'deposit_paid')::numeric,
      payment_status=facts->>'payment_status',balance=(facts->>'outstanding')::numeric,
      status=CASE WHEN r.status='pending-deposit' AND (facts->>'minimum_deposit_satisfied')::boolean THEN 'confirmed' ELSE r.status END,updated_at=now()
    WHERE r.id=_reservation AND r.organization_id=public.current_org_id() AND (r.deposit_paid IS DISTINCT FROM (facts->>'deposit_paid')::numeric OR r.payment_status IS DISTINCT FROM facts->>'payment_status' OR r.balance IS DISTINCT FROM (facts->>'outstanding')::numeric OR (r.status='pending-deposit' AND (facts->>'minimum_deposit_satisfied')::boolean));
    RETURN;
  END IF;

  SELECT coalesce(sum(d.amount), 0) INTO v_paid
    FROM public.reservation_deposits d
   WHERE d.reservation_id = _reservation
     AND d.status IN ('held', 'applied');

  SELECT coalesce(r.deposit_required, 0), r.status INTO v_required, v_status
    FROM public.reservations r WHERE r.id = _reservation;

  UPDATE public.reservations r
     SET deposit_paid = v_paid,
         payment_status = CASE
           WHEN v_paid <= 0 THEN 'unpaid'
           WHEN v_required > 0 AND v_paid + 0.009 >= v_required THEN 'paid'
           ELSE 'part-paid' END,
         -- A satisfied deposit clears the pre-arrival hold; every other
         -- lifecycle status (checked-in, checked-out, cancelled) is untouched.
         status = CASE
           WHEN r.status = 'pending-deposit'
                AND v_required > 0 AND v_paid + 0.009 >= v_required THEN 'confirmed'
           ELSE r.status END,
         updated_at = now()
   WHERE r.id = _reservation;
END; $$;
CREATE OR REPLACE FUNCTION public.tg_folio_sync_reservation_payment_status() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE booking public.reservations; next_status text;
BEGIN
 IF NEW.reservation_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO booking FROM public.reservations r WHERE r.id=NEW.reservation_id AND r.organization_id=NEW.organization_id AND r.branch_id IS NOT DISTINCT FROM NEW.branch_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF booking.organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN PERFORM public.neo_reservation_financial_state_sync(booking.id);
 ELSE
  next_status:=CASE WHEN coalesce(NEW.total_payments,0)<=0 THEN 'unpaid' WHEN coalesce(NEW.balance,0)<=0 THEN 'paid' ELSE 'part-paid' END;
  UPDATE public.reservations SET payment_status=next_status,updated_at=now() WHERE id=booking.id AND organization_id=booking.organization_id AND payment_status IS DISTINCT FROM next_status;
 END IF;
 RETURN NEW;
END $function$;
CREATE FUNCTION public.neo_reservation_collection_source_refresh() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE row_data jsonb; res uuid; previous_res uuid;
BEGIN
 row_data:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 IF (row_data->>'organization_id')::uuid IS DISTINCT FROM 'aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN RETURN NULL; END IF;
 res:=CASE WHEN TG_TABLE_NAME='reservations' THEN nullif(row_data->>'id','')::uuid ELSE nullif(row_data->>'reservation_id','')::uuid END;
 IF res IS NULL THEN SELECT f.reservation_id INTO res FROM public.folios f WHERE f.id=nullif(row_data->>'folio_id','')::uuid AND f.organization_id=(row_data->>'organization_id')::uuid; END IF;
 IF res IS NOT NULL THEN PERFORM public.neo_reservation_financial_state_sync(res); END IF;
 IF TG_OP='UPDATE' THEN
  previous_res:=nullif(to_jsonb(OLD)->>'reservation_id','')::uuid;
  IF previous_res IS NULL THEN SELECT f.reservation_id INTO previous_res FROM public.folios f WHERE f.id=nullif(to_jsonb(OLD)->>'folio_id','')::uuid AND f.organization_id=OLD.organization_id; END IF;
  IF previous_res IS NOT NULL AND previous_res IS DISTINCT FROM res THEN PERFORM public.neo_reservation_financial_state_sync(previous_res); END IF;
 END IF;
 RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION public.neo_reservation_collection_source_refresh() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER neo_reservation_payment_source_refresh AFTER INSERT OR DELETE OR UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.neo_reservation_collection_source_refresh();
CREATE TRIGGER neo_reservation_charge_source_refresh AFTER INSERT OR DELETE OR UPDATE ON public.folio_lines FOR EACH ROW EXECUTE FUNCTION public.neo_reservation_collection_source_refresh();
CREATE TRIGGER neo_reservation_quote_source_refresh AFTER UPDATE OF total_amount,deposit_required,status ON public.reservations FOR EACH ROW EXECUTE FUNCTION public.neo_reservation_collection_source_refresh();
DO $guard$ BEGIN IF md5(pg_get_functiondef(to_regprocedure('public.neo_cash_request_payment(uuid,numeric,text,text,text)'))) IS DISTINCT FROM '01698a96300e41a1d831f964763ec1ca' THEN RAISE EXCEPTION 'Collection function differs: neo_cash_request_payment(uuid,numeric,text,text,text)'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.neo_cash_request_payment(_folio uuid, _amount numeric, _reference text DEFAULT NULL::text, _notes text DEFAULT ''::text, _idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _f public.folios;
  _ctx jsonb;
  _shift uuid; _cashier uuid; _req uuid; _existing public.cash_payment_requests;
BEGIN
  IF NOT (public.has_permission('pms','payments.record') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to record payments';
  END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF _idempotency_key IS NOT NULL THEN
      IF nullif(btrim(_idempotency_key),'') IS NULL THEN RAISE EXCEPTION 'A stable collection key is required'; END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(_org::text||':pms-collection:'||_idempotency_key,0));
    END IF;
    IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN PERFORM public.neo_pms_collection_lock(_folio); END IF;
  SELECT * INTO _f FROM public.folios WHERE id=_folio AND organization_id=_org FOR UPDATE;
  ELSE
    SELECT * INTO _f FROM public.folios WHERE id=_folio AND organization_id=_org;
  END IF;
  IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF NOT coalesce(public.neo_branch_in_scope(_f.branch_id),false) THEN RAISE EXCEPTION 'Cash source is outside your property scope' USING ERRCODE='42501'; END IF;
    IF _amount::text IN ('NaN','Infinity','-Infinity') OR _amount<>round(_amount,2) THEN RAISE EXCEPTION 'Cash amount must be finite and positive' USING ERRCODE='22023'; END IF;
  END IF;
  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND _idempotency_key IS NOT NULL AND EXISTS(SELECT 1 FROM public.payments p WHERE p.organization_id=_org AND p.idempotency_key=_idempotency_key) THEN RAISE EXCEPTION 'Collection key already belongs to a recorded payment; review the saved collection' USING ERRCODE='23514'; END IF;
  IF _idempotency_key IS NOT NULL THEN
    SELECT * INTO _existing FROM public.cash_payment_requests
     WHERE organization_id=_org AND idempotency_key=_idempotency_key;
    IF _existing.id IS NOT NULL THEN
      IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND (_existing.folio_id IS DISTINCT FROM _f.id OR _existing.amount IS DISTINCT FROM _amount OR _existing.currency IS DISTINCT FROM coalesce(_f.currency,'KES') OR _existing.method IS DISTINCT FROM 'cash') THEN RAISE EXCEPTION 'Cash collection key was already used for a different amount, currency or folio' USING ERRCODE='23514'; END IF;
      IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND (_existing.source_record_id IS DISTINCT FROM _f.id OR _existing.source_module IS DISTINCT FROM 'pms' OR _existing.branch_id IS DISTINCT FROM _f.branch_id) THEN RAISE EXCEPTION 'Cash request intent belongs to a different source or property' USING ERRCODE='23514'; END IF;
      IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND _existing.status='confirmed' THEN RETURN public.neo_cash_settle_request(_existing.id); END IF;
      RETURN jsonb_build_object('status',_existing.status,'request_id',_existing.id,
        'payment_id',_existing.payment_id,'receipt_number',_existing.receipt_number,'amount',_existing.amount);
    END IF;
  END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND _f.status NOT IN ('open','under-review') THEN RAISE EXCEPTION 'Folio is % and cannot accept new cash requests',_f.status; END IF;
  _ctx := public.neo_cash_till_context(_f.branch_id);

  IF (_ctx->>'self_service')::boolean THEN
    _shift := (_ctx->>'my_shift_id')::uuid;
    _cashier := auth.uid();
  ELSE
    SELECT s.id, s.cashier_id INTO _shift, _cashier
      FROM public.pos_shifts s
     WHERE s.organization_id=_org AND s.status='open'
       AND (CASE WHEN _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN s.branch_id IS NOT DISTINCT FROM _f.branch_id AND coalesce(public.neo_branch_in_scope(s.branch_id),false) ELSE (s.branch_id IS NULL OR _f.branch_id IS NULL OR s.branch_id=_f.branch_id) END)
     ORDER BY (s.branch_id = _f.branch_id) DESC NULLS LAST, s.opened_at DESC
     LIMIT 1;
  END IF;

  IF _shift IS NULL THEN
    RETURN jsonb_build_object('status','no_till',
      'message','No active cash drawer is available for this outlet.',
      'can_open_drawer', _ctx->'can_open_drawer');
  END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND _amount>public.neo_pms_collection_headroom(_f.id)+0.005 THEN RAISE EXCEPTION 'This cash request exceeds the unpaid reservation or folio amount after pending collections'; END IF;
  INSERT INTO public.cash_payment_requests (organization_id, branch_id, source_module, source_record_id,
    folio_id, amount, currency, method, reference, notes, status, requested_by,
    assigned_shift_id, assigned_cashier_id, idempotency_key)
  VALUES (_org, _f.branch_id, 'pms', _f.id, _f.id, _amount, COALESCE(_f.currency,'KES'), 'cash',
    _reference, COALESCE(_notes,''), 'pending', auth.uid(), _shift, _cashier, _idempotency_key)
  RETURNING id INTO _req;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value)
  VALUES (_org, auth.uid(), '', 'finance.cash.request.create', 'finance', _req::text,
    jsonb_build_object('folio_id',_f.id,'amount',_amount,'assigned_shift',_shift,'assigned_cashier',_cashier));

  IF (_ctx->>'self_service')::boolean THEN
    RETURN public.neo_cash_settle_request(_req);
  END IF;

  RETURN jsonb_build_object('status','pending','request_id',_req,'assigned_shift_id',_shift,
    'assigned_cashier_id',_cashier,'amount',_amount);
END; $function$
;
DO $guard$ BEGIN IF md5(pg_get_functiondef(to_regprocedure('public.pms_record_payment(uuid,numeric,text,text,text,text,uuid)'))) IS DISTINCT FROM 'df4e708bf5532cb1640748d1674c868f' THEN RAISE EXCEPTION 'Collection function differs: pms_record_payment(uuid,numeric,text,text,text,text,uuid)'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.pms_record_payment(_folio uuid, _amount numeric, _method text, _reference text DEFAULT NULL::text, _notes text DEFAULT ''::text, _intent_key text DEFAULT NULL::text, _account uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _f public.folios; _id uuid; _receipt text; _status text; _shift uuid; _req public.cash_payment_requests; _settled jsonb; _key text; _acct uuid; _saved public.payments;
BEGIN
  IF NOT (public.has_permission('pms','payments.record') OR public.is_org_admin() OR public.neo_system_posting()) THEN RAISE EXCEPTION 'Not permitted to record payments'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;
  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
   IF nullif(btrim(_intent_key),'') IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended(_org::text||':pms-collection:'||btrim(_intent_key),0)); END IF;
   PERFORM public.neo_pms_collection_lock(_folio);
  END IF;
  SELECT * INTO _f FROM public.folios WHERE id=_folio AND organization_id=_org FOR UPDATE;
  IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF NOT coalesce(public.neo_branch_in_scope(_f.branch_id),false) THEN RAISE EXCEPTION 'Payment source is outside your property scope' USING ERRCODE='42501'; END IF;
    IF _amount::text IN ('NaN','Infinity','-Infinity') OR _amount<>round(_amount,2) THEN RAISE EXCEPTION 'Payment amount must be finite and in currency cents' USING ERRCODE='22023'; END IF;
  END IF;

  IF _account IS NOT NULL THEN
    SELECT b.id INTO _acct FROM public.bank_accounts b
     WHERE b.id = _account AND b.organization_id = _org AND b.active
       AND (b.branch_id IS NULL OR _f.branch_id IS NULL OR b.branch_id = _f.branch_id);
    IF _acct IS NULL THEN RAISE EXCEPTION 'Selected receiving account is not available for this property'; END IF;
  END IF;

  _key := NULLIF(btrim(coalesce(_intent_key,'')), '');
  IF _key IS NULL THEN
    _key := 'pms:payment:' || encode(extensions.digest(
      _folio::text || '|' || round(_amount,2)::text || '|' || _method || '|' ||
      coalesce(_reference,'') || '|' || coalesce(auth.uid()::text,'system') || '|' ||
      to_char(now() at time zone 'utc', 'YYYYMMDD"T"HH24MI'), 'sha256'), 'hex');
  END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(_org::text||':pms-collection:'||_key,0));
  END IF;
  SELECT p.* INTO _saved FROM public.payments p WHERE p.organization_id=_org AND p.idempotency_key=_key LIMIT 1;
  IF _saved.id IS NOT NULL THEN
    IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND (_saved.folio_id IS DISTINCT FROM _f.id OR _saved.branch_id IS DISTINCT FROM _f.branch_id OR _saved.amount IS DISTINCT FROM _amount OR _saved.currency IS DISTINCT FROM _f.currency OR _saved.method IS DISTINCT FROM _method OR _saved.destination_account_id IS DISTINCT FROM _acct) THEN RAISE EXCEPTION 'Payment collection key was already used for different payment details' USING ERRCODE='23514'; END IF;
    RETURN _saved.id;
  END IF;
  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND EXISTS(SELECT 1 FROM public.cash_payment_requests r WHERE r.organization_id=_org AND r.idempotency_key=_key) THEN
    SELECT * INTO _req FROM public.cash_payment_requests r WHERE r.organization_id=_org AND r.idempotency_key=_key;
    IF _method IS DISTINCT FROM 'cash' OR _req.folio_id IS DISTINCT FROM _f.id OR _req.amount IS DISTINCT FROM _amount OR _req.currency IS DISTINCT FROM _f.currency THEN RAISE EXCEPTION 'Collection key already belongs to a cash request; review the saved collection' USING ERRCODE='23514'; END IF;
    _settled:=public.neo_cash_settle_request(_req.id); RETURN (_settled->>'payment_id')::uuid;
  END IF;

  IF _f.status NOT IN ('open','under-review') THEN RAISE EXCEPTION 'Folio is % and cannot accept payments', _f.status; END IF;

  IF _method = 'cash' THEN
    SELECT * INTO _req
      FROM public.cash_payment_requests r
     WHERE r.organization_id = _org
       AND r.folio_id = _folio
       AND r.status = 'pending'
       AND r.method = _method
       AND abs(coalesce(r.amount,0) - _amount) < 0.01
     ORDER BY r.created_at ASC
     LIMIT 1;
    IF _req.id IS NOT NULL THEN
      _settled := public.neo_cash_settle_request(_req.id);
      RETURN (_settled ->> 'payment_id')::uuid;
    END IF;
  END IF;

  IF _method = 'cash' THEN
    SELECT s.id INTO _shift
      FROM public.pos_shifts s
     WHERE s.cashier_id = auth.uid()
       AND s.status = 'open'
       AND s.organization_id = _org
       AND (s.branch_id IS NULL OR _f.branch_id IS NULL OR s.branch_id = _f.branch_id)
     ORDER BY (s.branch_id = _f.branch_id) DESC NULLS LAST, s.opened_at DESC
     LIMIT 1;
    IF _shift IS NULL THEN
      RAISE EXCEPTION 'Open your cash drawer before taking cash at this desk';
    END IF;
  END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND _amount>public.neo_pms_collection_headroom(_f.id)+0.005 THEN RAISE EXCEPTION 'This payment exceeds the unpaid reservation or folio amount after pending collections'; END IF;
  _status := CASE WHEN _method IN ('cash','corporate-credit') THEN 'confirmed' ELSE 'pending' END;
  _receipt := public.next_document_number('receipt');

  BEGIN
    INSERT INTO public.payments (organization_id, branch_id, receipt_number, folio_id, reservation_id,
      customer_id, amount, currency, method, external_reference, status, received_by, notes, shift_id,
      source_module, idempotency_key, destination_account_id)
    VALUES (_org, _f.branch_id, _receipt, _folio, _f.reservation_id, _f.customer_id, _amount, _f.currency,
      _method, _reference, _status, auth.uid(), COALESCE(_notes,''), _shift, 'pms', _key, _acct)
    RETURNING id INTO _id;
  EXCEPTION WHEN unique_violation THEN
    SELECT p.* INTO _saved FROM public.payments p WHERE p.organization_id=_org AND p.idempotency_key=_key LIMIT 1;
    IF _saved.id IS NULL THEN RAISE; END IF;
    IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND (_saved.folio_id IS DISTINCT FROM _f.id OR _saved.branch_id IS DISTINCT FROM _f.branch_id OR _saved.amount IS DISTINCT FROM _amount OR _saved.currency IS DISTINCT FROM _f.currency OR _saved.method IS DISTINCT FROM _method OR _saved.destination_account_id IS DISTINCT FROM _acct) THEN RAISE EXCEPTION 'Payment collection key was already used for different payment details' USING ERRCODE='23514'; END IF;
    RETURN _saved.id;
  END;

  IF _status = 'confirmed' THEN
    INSERT INTO public.payment_allocations (organization_id, payment_id, folio_id, amount, created_by)
    VALUES (_org, _id, _folio, _amount, auth.uid());
    UPDATE public.folios SET total_payments = total_payments + _amount,
      balance = balance - _amount, updated_at = now() WHERE id=_folio;
  END IF;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'pms.payment.record', 'finance', _id::text,
    jsonb_build_object('folio_id',_folio,'amount',_amount,'method',_method,'status',_status,'shift_id',_shift,'intent_key',_key,'destination_account_id',_acct), _notes);
  RETURN _id;
END $function$
;
DO $guard$ BEGIN IF md5(pg_get_functiondef(to_regprocedure('public.neo_reservation_deposit_record(uuid,numeric,text,text,text,text)'))) IS DISTINCT FROM '26c7a1f6b03036933bc4bab3d585c5e2' THEN RAISE EXCEPTION 'Collection function differs: neo_reservation_deposit_record(uuid,numeric,text,text,text,text)'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.neo_reservation_deposit_record(
  _reservation uuid, _amount numeric, _method text DEFAULT 'cash'::text,
  _reference text DEFAULT NULL::text, _idempotency_key text DEFAULT NULL::text,
  _notes text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _res public.reservations;
  _id uuid;
  _existing uuid;
  _post jsonb; _saved public.reservation_deposits; _facts jsonb;
BEGIN
  IF NOT (public.has_permission('pms','reservations.edit') OR public.has_permission('finance','collections.record_payment')) THEN
    RAISE EXCEPTION 'Not permitted to record a reservation deposit';
  END IF;
  IF COALESCE(_amount,0) <= 0 THEN RAISE EXCEPTION 'A deposit must be greater than zero'; END IF;
  IF NULLIF(btrim(COALESCE(_idempotency_key,'')), '') IS NULL THEN RAISE EXCEPTION 'A deposit idempotency key is required'; END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
   IF _amount::text IN ('NaN','Infinity','-Infinity') OR _amount<>round(_amount,2) THEN RAISE EXCEPTION 'Deposit amount must be finite and in currency cents'; END IF;
   IF coalesce(nullif(lower(_method),''),'cash') NOT IN ('cash','card','bank-transfer','bank','bank_transfer','eft','voucher') THEN RAISE EXCEPTION 'This deposit method needs a verified collection workflow; do not record an unconfirmed provider payment as a received deposit'; END IF;
   IF coalesce(nullif(lower(_method),''),'cash')<>'cash' AND nullif(btrim(_reference),'') IS NULL THEN RAISE EXCEPTION 'A received non-cash deposit requires its bank, terminal or voucher confirmation reference'; END IF;
   PERFORM pg_advisory_xact_lock(hashtextextended(_org::text||':deposit-intent:'||_idempotency_key,0));
   PERFORM pg_advisory_xact_lock(hashtextextended(_org::text||':reservation-collection:'||_reservation::text,0));
  END IF;
  SELECT * INTO _res FROM public.reservations
   WHERE id = _reservation AND organization_id = _org FOR UPDATE;
  IF _res.id IS NULL THEN RAISE EXCEPTION 'Reservation not found'; END IF;
  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND NOT coalesce(public.neo_branch_in_scope(_res.branch_id),false) THEN RAISE EXCEPTION 'Reservation is outside your property scope' USING ERRCODE='42501'; END IF;

  SELECT id INTO _existing FROM public.reservation_deposits
   WHERE organization_id = _org AND idempotency_key = _idempotency_key;
  IF _existing IS NOT NULL THEN
    IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
      SELECT * INTO _saved FROM public.reservation_deposits WHERE id=_existing AND organization_id=_org;
      IF _saved.reservation_id IS DISTINCT FROM _res.id OR _saved.branch_id IS DISTINCT FROM _res.branch_id OR _saved.amount IS DISTINCT FROM _amount OR _saved.method IS DISTINCT FROM coalesce(nullif(lower(_method),''),'cash') OR _saved.currency IS DISTINCT FROM public.neo_fact_currency(_org,_res.branch_id) OR _saved.status NOT IN ('held','applied') THEN RAISE EXCEPTION 'Deposit collection key already belongs to different details. Review the saved collection.' USING ERRCODE='23514'; END IF;
    END IF;
    _post := public.neo_deposit_post(_existing, true);
    RETURN jsonb_build_object('deposit_id', _existing, 'idempotent', true,
      'position', public.neo_reservation_deposit_position(_reservation), 'finance', _post);
  END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF _res.status NOT IN ('enquiry','on-hold','waitlisted','tentative','pending-deposit','confirmed','guaranteed','provisional-hold','awaiting-deposit') THEN RAISE EXCEPTION 'Record further collections against the active folio after arrival; do not create another pre-arrival deposit'; END IF;
    _facts:=public.neo_reservation_collection_facts(_reservation);
    IF _amount>(_facts->>'headroom')::numeric+0.005 THEN RAISE EXCEPTION 'Deposit exceeds the unpaid booking amount after pending collections'; END IF;
  END IF;
  INSERT INTO public.reservation_deposits
    (organization_id, branch_id, reservation_id, customer_id, amount, method,
     reference, received_by, idempotency_key, notes, currency)
  VALUES
    (_org, _res.branch_id, _reservation, _res.customer_id, round(_amount,2),
     COALESCE(NULLIF(lower(_method),''),'cash'), NULLIF(btrim(COALESCE(_reference,'')),''),
     auth.uid(), _idempotency_key, _notes, CASE WHEN _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN public.neo_fact_currency(_org,_res.branch_id) ELSE 'KES' END)
  RETURNING id INTO _id;

  UPDATE public.reservations r
     SET deposit_paid = (SELECT COALESCE(sum(d.amount),0) FROM public.reservation_deposits d
                          WHERE d.reservation_id = _reservation AND d.status IN ('held','applied')),
         updated_at = now()
   WHERE r.id = _reservation;

  _post := public.neo_deposit_post(_id, true);
  RETURN jsonb_build_object('deposit_id', _id, 'idempotent', false,
    'position', public.neo_reservation_deposit_position(_reservation), 'finance', _post);
END;
$function$;;
DO $guard$ BEGIN IF md5(pg_get_functiondef(to_regprocedure('public.neo_cash_settle_request(uuid)'))) IS DISTINCT FROM '5c963a249dbfb0d1f8cfb5c0c710a3c3' THEN RAISE EXCEPTION 'Collection function differs: neo_cash_settle_request(uuid)'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.neo_cash_settle_request(_request uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _r public.cash_payment_requests;
  _f public.folios;
  _o public.pos_orders;
  _s public.pos_shifts;
  _pay uuid; _receipt text; _paid numeric; _fully boolean; _pending numeric; _headroom numeric;
BEGIN
  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN PERFORM public.neo_pms_collection_lock((SELECT folio_id FROM public.cash_payment_requests WHERE id=_request AND organization_id=_org AND source_module IS DISTINCT FROM 'pos')); END IF;
  SELECT * INTO _r FROM public.cash_payment_requests WHERE id=_request AND organization_id=_org FOR UPDATE;
  IF _r.id IS NULL THEN RAISE EXCEPTION 'Cash request not found'; END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF NOT coalesce(public.neo_branch_in_scope(_r.branch_id),false) THEN RAISE EXCEPTION 'Cash request is outside your property scope' USING ERRCODE='42501'; END IF;
    IF _r.amount IS NULL OR _r.amount<=0 OR _r.amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Cash amount must be finite and positive'; END IF;
    IF _r.status='confirmed' THEN
      IF auth.uid() IS NULL OR NOT (coalesce(_r.requested_by=auth.uid(),false) OR coalesce(_r.assigned_cashier_id=auth.uid(),false) OR public.has_permission('finance','view') OR public.has_permission('pos','payments.record') OR public.is_org_admin()) THEN RAISE EXCEPTION 'Not permitted to view this cash confirmation' USING ERRCODE='42501'; END IF;
      IF _r.payment_id IS NULL OR nullif(btrim(_r.receipt_number),'') IS NULL OR
         (_r.source_module='pos' AND NOT EXISTS(SELECT 1 FROM public.pos_payments p WHERE p.id=_r.payment_id AND p.organization_id=_org AND p.branch_id IS NOT DISTINCT FROM _r.branch_id AND p.order_id=_r.source_record_id AND p.receipt_number=_r.receipt_number AND p.amount=_r.amount AND p.currency=_r.currency)) OR
         (coalesce(_r.source_module,'')<>'pos' AND NOT EXISTS(SELECT 1 FROM public.payments p WHERE p.id=_r.payment_id AND p.organization_id=_org AND p.branch_id IS NOT DISTINCT FROM _r.branch_id AND p.folio_id=_r.folio_id AND p.receipt_number=_r.receipt_number AND p.amount=_r.amount AND p.currency=_r.currency)) THEN
        RAISE EXCEPTION 'Confirmed cash request lacks matching saved payment and receipt evidence';
      END IF;
    END IF;
  END IF;
  IF _r.status = 'confirmed' THEN
    RETURN jsonb_build_object('status','confirmed','request_id',_r.id,
      'payment_id',_r.payment_id,'receipt_number',_r.receipt_number,'amount',_r.amount);
  END IF;
  IF _r.status <> 'pending' THEN RAISE EXCEPTION 'Cash request is % and cannot be settled', _r.status; END IF;

  SELECT * INTO _s FROM public.pos_shifts WHERE id=_r.assigned_shift_id AND organization_id=_org FOR UPDATE;
  IF _s.id IS NULL OR _s.status <> 'open' THEN
    RAISE EXCEPTION 'The assigned cash drawer is no longer open';
  END IF;

  IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    IF auth.uid() IS NULL OR _s.status IS DISTINCT FROM 'open' OR _s.branch_id IS DISTINCT FROM _r.branch_id OR _s.cashier_id IS DISTINCT FROM auth.uid() OR (_r.assigned_cashier_id IS NOT NULL AND _r.assigned_cashier_id IS DISTINCT FROM _s.cashier_id) THEN RAISE EXCEPTION 'Only the assigned cashier with an open till in this property may confirm cash' USING ERRCODE='42501'; END IF;
    IF NOT (public.has_permission('finance','till.confirm_cash') OR public.has_permission('finance','till.edit') OR public.has_permission('pos','shifts.open')) THEN RAISE EXCEPTION 'Not permitted to confirm cash' USING ERRCODE='42501'; END IF;
  END IF;
  IF _r.source_module='pos' AND (coalesce(_r.tendered,_r.amount)::text IN ('NaN','Infinity','-Infinity') OR coalesce(_r.tendered,_r.amount)<_r.amount OR coalesce(_r.tendered,_r.amount)<>round(coalesce(_r.tendered,_r.amount),2) OR (_r.change_due IS NOT NULL AND _r.change_due IS DISTINCT FROM coalesce(_r.tendered,_r.amount)-_r.amount)) THEN RAISE EXCEPTION 'Saved cash tender does not agree with payment and change'; END IF;
  _receipt := public.next_document_number('receipt');

  IF _r.source_module = 'pos' THEN
    SELECT * INTO _o FROM public.pos_orders WHERE id=_r.source_record_id AND organization_id=_org FOR UPDATE;
    IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
    IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
      IF _o.branch_id IS DISTINCT FROM _r.branch_id OR _o.currency IS DISTINCT FROM _r.currency THEN RAISE EXCEPTION 'Cash source property or currency changed'; END IF;
      IF _o.status IN ('closed','cancelled','voided','charged-to-room') THEN RAISE EXCEPTION 'This order cannot accept further cash'; END IF;
      SELECT coalesce(sum(amount) FILTER(WHERE status='confirmed'),0),coalesce(sum(amount) FILTER(WHERE status IN ('initiated','pending')),0) INTO _paid,_pending FROM public.pos_payments WHERE organization_id=_org AND order_id=_o.id;
      IF _o.grand_total IS NULL OR _o.grand_total::text IN ('NaN','Infinity','-Infinity') OR _paid::text IN ('NaN','Infinity','-Infinity') OR _pending::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Order payment amounts are incomplete or non-finite'; END IF;
      _headroom:=round(_o.grand_total-_paid-_pending,2);
      IF _r.amount>_headroom+0.005 THEN RAISE EXCEPTION 'Cash request exceeds the current payment headroom'; END IF;
    END IF;

    INSERT INTO public.pos_payments (organization_id, branch_id, order_id, receipt_number, customer_id,
      amount, tendered, change_due, currency, method, external_reference, status, paid_at, cashier_id, shift_id,
      created_by, idempotency_key)
    VALUES (_org, _o.branch_id, _o.id, _receipt, _o.customer_id, _r.amount, coalesce(_r.tendered,_r.amount), coalesce(_r.tendered,_r.amount)-_r.amount,
      COALESCE(_o.currency,_r.currency), _r.method, CASE WHEN _r.method='cash' THEN NULL ELSE _r.reference END, 'confirmed', now(), _s.cashier_id, _s.id,
      auth.uid(), 'cash-request:' || _r.id::text)
    RETURNING id INTO _pay;

    _paid := CASE WHEN _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN _paid+_r.amount ELSE COALESCE(_o.paid_total,0)+_r.amount END;
    _fully := _paid >= COALESCE(_o.grand_total,0);

    -- Move out of the service state BEFORE marking the bill paid: the lifecycle
    -- guard refuses a fully paid order that is still sent/preparing.
    IF _fully AND _o.status NOT IN ('awaiting-payment','paid','closed','charged-to-room','credit','cancelled','voided') THEN
      UPDATE public.pos_orders SET status='awaiting-payment', updated_at=now() WHERE id=_o.id;
    END IF;

    UPDATE public.pos_orders
       SET paid_total = _paid,
           payment_status = CASE WHEN _fully THEN 'paid' ELSE 'partial' END,
           updated_at = now()
     WHERE id = _o.id;

    IF _fully THEN
      UPDATE public.pos_orders SET status='paid', updated_at=now()
       WHERE id=_o.id AND status='awaiting-payment';
    END IF;
  ELSE
    SELECT * INTO _f FROM public.folios WHERE id=_r.folio_id AND organization_id=_org FOR UPDATE;
    IF _f.id IS NULL THEN RAISE EXCEPTION 'Folio not found'; END IF;
    IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND (_r.amount<>round(_r.amount,2) OR _r.amount>public.neo_pms_collection_headroom(_f.id,NULL,_r.id)+0.005) THEN RAISE EXCEPTION 'Cash exceeds current unpaid amount after other pending collections'; END IF;
    IF _org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND (_f.branch_id IS DISTINCT FROM _r.branch_id OR _f.currency IS DISTINCT FROM _r.currency) THEN RAISE EXCEPTION 'Cash folio property or currency changed'; END IF;
    IF _f.status NOT IN ('open','under-review') THEN
      RAISE EXCEPTION 'Folio is % and cannot accept payments', _f.status;
    END IF;

    INSERT INTO public.payments (organization_id, branch_id, receipt_number, folio_id, reservation_id,
      customer_id, amount, currency, method, external_reference, status, received_by, notes, shift_id,
      station_id, source_module, source_record_id, idempotency_key)
    VALUES (_org, _f.branch_id, _receipt, _f.id, _f.reservation_id, _f.customer_id, _r.amount,
      COALESCE(_f.currency,_r.currency), _r.method, CASE WHEN _r.method='cash' THEN NULL ELSE _r.reference END, 'confirmed', _s.cashier_id,
      COALESCE(_r.notes,''), _s.id, _s.station_id, _r.source_module, _r.source_record_id,
      'cash-request:' || _r.id::text)
    RETURNING id INTO _pay;

    INSERT INTO public.payment_allocations (organization_id, payment_id, folio_id, amount, created_by)
    VALUES (_org, _pay, _f.id, _r.amount, _s.cashier_id);

    UPDATE public.folios SET total_payments = COALESCE(total_payments,0) + _r.amount,
      balance = COALESCE(balance,0) - _r.amount, updated_at = now() WHERE id=_f.id;
  END IF;

  UPDATE public.cash_payment_requests
     SET status='confirmed', payment_id=_pay, receipt_number=_receipt,
         assigned_cashier_id=COALESCE(assigned_cashier_id,_s.cashier_id), confirmed_at=now(), updated_at=now()
   WHERE id=_r.id;

  INSERT INTO public.audit_logs (organization_id, user_id, user_name, action, module, record_id, new_value, reason)
  VALUES (_org, auth.uid(), '', 'finance.cash.receipt.confirm', 'finance', _pay::text,
    jsonb_build_object('request_id',_r.id,'folio_id',_r.folio_id,'source_module',_r.source_module,
      'source_record_id',_r.source_record_id,'amount',_r.amount,'method',_r.method,
      'shift_id',_s.id,'collected_by',_s.cashier_id,'initiated_by',_r.requested_by,
      'receipt_number',_receipt), _r.notes);

  RETURN jsonb_build_object('status','confirmed','request_id',_r.id,'payment_id',_pay,
    'receipt_number',_receipt,'amount',_r.amount,'shift_id',_s.id,'collected_by',_s.cashier_id);
END; $function$
;
DO $guard$ BEGIN IF md5(pg_get_functiondef(to_regprocedure('public.pms_confirm_payment(uuid,text,text)'))) IS DISTINCT FROM '761f6ed7271659db2517f69b2c2316e3' THEN RAISE EXCEPTION 'Collection function differs: pms_confirm_payment(uuid,text,text)'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.pms_confirm_payment(_payment uuid,_reference text DEFAULT NULL,_note text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE org uuid:=public.current_org_id(); p public.payments; f public.folios; allocated numeric; allocation_count integer;
BEGIN
 IF org IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','no_organisation'); END IF;
 IF NOT (public.has_permission('pms','payments.confirm') OR public.has_permission('finance','approve') OR public.is_org_admin() OR public.neo_system_posting()) THEN RAISE EXCEPTION 'Not permitted to confirm payments' USING ERRCODE='42501'; END IF;
 IF org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN PERFORM public.neo_pms_collection_lock((SELECT folio_id FROM public.payments WHERE id=_payment AND organization_id=org)); END IF;
 SELECT * INTO p FROM public.payments WHERE id=_payment AND organization_id=org FOR UPDATE;
 IF p.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
 IF NOT coalesce(public.neo_branch_in_scope(p.branch_id),false) THEN RAISE EXCEPTION 'Payment is outside your property scope' USING ERRCODE='42501'; END IF;
 IF p.status='confirmed' THEN RETURN jsonb_build_object('ok',true,'reason','already_confirmed','payment_id',p.id); END IF;
 IF p.status NOT IN ('pending','processing','submitted') THEN RETURN jsonb_build_object('ok',false,'reason','invalid_status','status',p.status); END IF;
 IF org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND p.method NOT IN ('cash','corporate-credit','card','bank-transfer','bank','bank_transfer','eft','voucher','ota-prepaid','debit-card','credit-card') THEN RETURN jsonb_build_object('ok',false,'reason','provider_confirmation_required','detail','This provider-backed payment requires its verified provider confirmation.'); END IF;
 IF p.amount IS NULL OR p.amount<=0 OR p.amount::text IN ('NaN','Infinity','-Infinity') OR p.amount<>round(p.amount,2) THEN RAISE EXCEPTION 'Payment amount is invalid'; END IF;
 IF p.method NOT IN ('cash','corporate-credit') AND nullif(btrim(coalesce(_reference,p.external_reference,'')),'') IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','reference_required','detail','External payments require a confirmation reference.'); END IF;
 SELECT * INTO f FROM public.folios WHERE id=p.folio_id AND organization_id=org FOR UPDATE;
 IF f.id IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','folio_not_found'); END IF;
 IF f.status NOT IN ('open','under-review') THEN RETURN jsonb_build_object('ok',false,'reason','folio_not_open','status',f.status); END IF;
 IF p.branch_id IS DISTINCT FROM f.branch_id OR p.currency IS DISTINCT FROM f.currency THEN RAISE EXCEPTION 'Payment property or currency differs from the folio'; END IF;
 IF org='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND p.amount>public.neo_pms_collection_headroom(f.id,p.id,NULL)+0.005 THEN RAISE EXCEPTION 'Payment exceeds the current unpaid amount after other pending collections'; END IF;
 SELECT count(*),coalesce(sum(a.amount),0) INTO allocation_count,allocated FROM public.payment_allocations a WHERE a.payment_id=p.id AND a.organization_id=org;
 IF allocation_count>0 AND (allocation_count<>1 OR allocated IS DISTINCT FROM p.amount OR NOT EXISTS(SELECT 1 FROM public.payment_allocations a WHERE a.payment_id=p.id AND a.folio_id=f.id AND a.organization_id=org AND a.amount=p.amount)) THEN RAISE EXCEPTION 'Existing payment allocations need review before confirmation'; END IF;
 IF allocation_count=0 THEN
  INSERT INTO public.payment_allocations(organization_id,payment_id,folio_id,amount,created_by) VALUES(org,p.id,f.id,p.amount,auth.uid());
  UPDATE public.folios SET total_payments=total_payments+p.amount,balance=balance-p.amount,updated_at=now() WHERE id=f.id AND organization_id=org;
 END IF;
 UPDATE public.payments SET status='confirmed',external_reference=coalesce(nullif(btrim(_reference),''),external_reference),notes=concat_ws(' · ',nullif(notes,''),nullif(_note,'')),paid_at=now(),updated_at=now() WHERE id=p.id AND organization_id=org;
 INSERT INTO public.audit_logs(organization_id,user_id,user_name,action,module,record_id,new_value,reason) VALUES(org,auth.uid(),'','pms.payment.confirm','finance',p.id::text,jsonb_build_object('folio_id',f.id,'amount',p.amount,'method',p.method,'reference',coalesce(nullif(btrim(_reference),''),p.external_reference)),_note);
 RETURN jsonb_build_object('ok',true,'payment_id',p.id,'folio_id',f.id,'amount',p.amount,'balance',(SELECT balance FROM public.folios WHERE id=f.id AND organization_id=org));
END $function$;
NOTIFY pgrst,'reload schema';

-- 151_APPLY_LAUNDRY_INTAKE_PRICING.sql
DO $guard$ BEGIN
 IF to_regprocedure('public.neo_laundry_order_create(uuid,uuid,jsonb,text,boolean,text)') IS NOT NULL OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='guest_laundry_orders' AND column_name IN ('intake_idempotency_key','intake_request_hash','intake_price_mode')) THEN RAISE EXCEPTION 'Laundry intake code/columns already differ; inspect before installation'; END IF;
 IF md5(pg_get_functiondef(to_regprocedure('public.laundry_rollup_order()'))) IS DISTINCT FROM 'fca6e65db8e26194d1933bb78321ce24' OR md5(pg_get_functiondef(to_regprocedure('public.laundry_item_amounts()'))) IS DISTINCT FROM '208d86bff6d774d7a40a32d3c8f28baf' THEN RAISE EXCEPTION 'Laundry pricing trigger definitions differ'; END IF;
END $guard$;
ALTER TABLE public.guest_laundry_orders ADD COLUMN intake_idempotency_key text,ADD COLUMN intake_request_hash text,ADD COLUMN intake_price_mode text CHECK(intake_price_mode IS NULL OR intake_price_mode='configured-unit');
CREATE UNIQUE INDEX neo_laundry_intake_identity ON public.guest_laundry_orders(organization_id,branch_id,intake_idempotency_key) WHERE intake_idempotency_key IS NOT NULL;
CREATE OR REPLACE FUNCTION public.neo_laundry_order_create(
  _branch uuid,_room uuid,_items jsonb,_idempotency_key text,
  _express boolean DEFAULT false,_instructions text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
AS $function$
DECLARE
  v_org uuid:=public.current_org_id(); v_actor uuid:=auth.uid();
  v_key text:=nullif(btrim(_idempotency_key),''); v_hash text;
  v_existing public.guest_laundry_orders; v_stay public.stays; v_res public.reservations;
  v_folio uuid; v_currency text; v_customer uuid; v_count integer; v_order uuid; v_number text; v_audit uuid;
  v_item jsonb; v_price public.laundry_price_items; v_qty numeric; v_unit numeric; v_tax_rate numeric;
  v_line numeric; v_subtotal numeric:=0; v_tax numeric:=0;
BEGIN
  IF v_org IS NULL OR v_actor IS NULL THEN RAISE EXCEPTION 'Authenticated organisation context required' USING ERRCODE='42501'; END IF;
  IF NOT (public.has_permission('laundry','orders','create') OR public.has_permission('laundry','create')
          OR public.has_permission('laundry','edit') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to create guest laundry orders' USING ERRCODE='42501';
  END IF;
  IF _branch IS NULL OR NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION 'The selected property is outside your access scope' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.rooms WHERE id=_room AND organization_id=v_org AND branch_id=_branch;
  IF NOT FOUND THEN RAISE EXCEPTION 'Select a room in the authorised property'; END IF;
  IF v_key IS NULL OR length(v_key)>200 THEN RAISE EXCEPTION 'A laundry intake identity of 1 to 200 characters is required'; END IF;
  IF _items IS NULL OR jsonb_typeof(_items)<>'array' OR jsonb_array_length(_items)=0 THEN
    RAISE EXCEPTION 'Select at least one configured laundry item';
  END IF;
  v_hash:=md5(jsonb_build_object('room',_room,'items',_items,'express',coalesce(_express,false),'instructions',_instructions)::text);
  PERFORM pg_advisory_xact_lock(hashtextextended('laundry-intake:'||v_org::text||':'||_branch::text||':'||v_key,0));
  SELECT * INTO v_existing FROM public.guest_laundry_orders
    WHERE organization_id=v_org AND branch_id=_branch AND intake_idempotency_key=v_key;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.intake_request_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'This intake identity already belongs to different laundry. Open the saved order before starting another.';
    END IF;
    RETURN jsonb_build_object('ok',true,'idempotent',true,'order_id',v_existing.id,
      'laundry_number',v_existing.laundry_number,'folio_id',v_existing.folio_id,'reservation_id',v_existing.reservation_id,'total',v_existing.total);
  END IF;

  SELECT count(*) INTO v_count FROM public.stays
    WHERE organization_id=v_org AND branch_id=_branch AND room_id=_room AND checked_out_at IS NULL
      AND status IN ('in-house','checked-in');
  IF v_count<>1 THEN RAISE EXCEPTION 'The room must have exactly one active guest stay before laundry intake'; END IF;
  SELECT * INTO v_stay FROM public.stays
    WHERE organization_id=v_org AND branch_id=_branch AND room_id=_room AND checked_out_at IS NULL
      AND status IN ('in-house','checked-in') FOR SHARE;
  SELECT * INTO v_res FROM public.reservations
    WHERE id=v_stay.reservation_id AND organization_id=v_org AND branch_id=_branch FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'The active stay has no matching reservation in this property'; END IF;
  IF v_stay.customer_id IS NOT NULL AND v_res.customer_id IS NOT NULL AND v_stay.customer_id<>v_res.customer_id THEN
    RAISE EXCEPTION 'The stay and reservation guest links disagree; reconcile them before intake';
  END IF;
  v_customer:=coalesce(v_stay.customer_id,v_res.customer_id);
  IF v_customer IS NULL THEN RAISE EXCEPTION 'The active stay has no linked guest'; END IF;
  SELECT count(*) INTO v_count FROM public.folios
    WHERE organization_id=v_org AND branch_id=_branch AND reservation_id=v_stay.reservation_id
      AND (stay_id=v_stay.id OR stay_id IS NULL) AND folio_type='guest' AND status='open'
      AND (customer_id=v_customer OR customer_id IS NULL);
  IF v_count<>1 THEN RAISE EXCEPTION 'The active stay must have exactly one open guest folio'; END IF;
  SELECT id,currency INTO v_folio,v_currency FROM public.folios
    WHERE organization_id=v_org AND branch_id=_branch AND reservation_id=v_stay.reservation_id
      AND (stay_id=v_stay.id OR stay_id IS NULL) AND folio_type='guest' AND status='open'
      AND (customer_id=v_customer OR customer_id IS NULL) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'The guest folio changed during intake; reload and retry'; END IF;
  IF v_currency IS DISTINCT FROM public.neo_fact_currency(v_org,_branch) THEN
    RAISE EXCEPTION 'The guest folio currency differs from the property laundry price currency';
  END IF;

  v_number:=public.next_document_number('laundry',NULL,_branch);
  INSERT INTO public.guest_laundry_orders(
    organization_id,branch_id,laundry_number,customer_id,reservation_id,folio_id,room_id,
    service_type,express,express_charge,special_instructions,status,created_by,intake_idempotency_key,intake_request_hash,resident,payment_intent,intake_price_mode,requested_by_user
  ) VALUES(v_org,_branch,v_number,v_customer,v_stay.reservation_id,v_folio,_room,
    'normal',coalesce(_express,false),0,nullif(btrim(_instructions),''),'requested',v_actor,v_key,v_hash,true,'charge_to_room','configured-unit',v_actor)
  RETURNING id INTO v_order;
  FOR v_item IN SELECT * FROM jsonb_array_elements(_items) LOOP
    SELECT * INTO v_price FROM public.laundry_price_items
      WHERE id=nullif(v_item->>'price_item_id','')::uuid AND organization_id=v_org
        AND (branch_id=_branch OR branch_id IS NULL) AND active FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Every garment must use an active price from this property''s laundry catalogue'; END IF;
    v_qty:=(v_item->>'quantity')::numeric;
    IF v_qty IS NULL OR v_qty::text IN ('NaN','Infinity','-Infinity') OR v_qty<=0 THEN RAISE EXCEPTION 'Every laundry quantity must be positive and finite'; END IF;
    v_unit:=CASE WHEN coalesce(_express,false) THEN v_price.express_price ELSE v_price.normal_price END;
    IF v_unit IS NULL OR v_unit::text IN ('NaN','Infinity','-Infinity') OR v_unit<=0 THEN RAISE EXCEPTION 'Configure a positive normal or express price for every selected garment'; END IF;
    v_tax_rate:=coalesce(v_price.tax_rate,0);
    IF v_unit IS NULL OR v_unit::text IN ('NaN','Infinity','-Infinity') OR v_unit<0
       OR v_tax_rate::text IN ('NaN','Infinity','-Infinity') OR v_tax_rate<0 THEN
      RAISE EXCEPTION 'Correct the configured laundry price or tax before intake';
    END IF;
    v_line:=round(v_qty*v_unit,2);
    v_subtotal:=v_subtotal+v_line; v_tax:=v_tax+round(v_line*v_tax_rate/100,2);
    INSERT INTO public.guest_laundry_items(organization_id,order_id,price_item_id,description,service_type,quantity,unit_price,tax_rate,line_total)
    VALUES(v_org,v_order,v_price.id,v_price.name,v_price.service_type,v_qty,v_unit,v_tax_rate,v_line);
  END LOOP;
  IF v_subtotal<=0 THEN RAISE EXCEPTION 'The selected laundry must have a configured positive price'; END IF;
  UPDATE public.guest_laundry_orders SET subtotal=v_subtotal,tax_amount=v_tax,total=v_subtotal+v_tax,updated_at=now() WHERE id=v_order;
  v_audit:=public.log_audit_event('laundry.order.created','laundry',v_order::text,NULL,
    jsonb_build_object('order_id',v_order,'laundry_number',v_number,'room_id',_room,'reservation_id',v_stay.reservation_id,
      'folio_id',v_folio,'total',v_subtotal+v_tax,'items',jsonb_array_length(_items)),
    'Guest laundry intake','laundry.orders.create',_branch,NULL,NULL,v_key,NULL,NULL);
  IF v_audit IS NULL THEN RAISE EXCEPTION 'Laundry intake could not save its audit record'; END IF;
  RETURN jsonb_build_object('ok',true,'idempotent',false,'order_id',v_order,'laundry_number',v_number,
    'folio_id',v_folio,'reservation_id',v_stay.reservation_id,'total',v_subtotal+v_tax,'audit_id',v_audit);
END
$function$;

REVOKE ALL ON FUNCTION public.neo_laundry_order_create(uuid,uuid,jsonb,text,boolean,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.neo_laundry_order_create(uuid,uuid,jsonb,text,boolean,text) TO authenticated;
CREATE OR REPLACE FUNCTION public.laundry_rollup_order() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE order_key uuid:=coalesce(NEW.order_id,OLD.order_id); v_subtotal numeric:=0; taxes numeric:=0; express boolean; mode text;
BEGIN
 SELECT coalesce(sum(line_total),0),coalesce(sum(round(line_total*coalesce(tax_rate,0)/100,2)),0) INTO v_subtotal,taxes FROM public.guest_laundry_items WHERE order_id=order_key;
 SELECT o.express,o.intake_price_mode INTO express,mode FROM public.guest_laundry_orders o WHERE o.id=order_key;
 IF coalesce(express,false) AND mode IS DISTINCT FROM 'configured-unit' THEN v_subtotal:=round(v_subtotal*1.5,2); END IF;
 IF v_subtotal::text IN ('NaN','Infinity','-Infinity') OR taxes::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Laundry totals are not finite'; END IF;
 UPDATE public.guest_laundry_orders SET subtotal=v_subtotal, tax_amount=taxes,total=v_subtotal+taxes,updated_at=now() WHERE id=order_key AND posting_status IS DISTINCT FROM 'posted';
 RETURN NULL;
END $function$;
CREATE FUNCTION public.neo_laundry_intake_item_price_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE parent public.guest_laundry_orders;
BEGIN
 IF TG_OP='UPDATE' AND NEW.order_id IS DISTINCT FROM OLD.order_id AND EXISTS(SELECT 1 FROM public.guest_laundry_orders o WHERE o.id=OLD.order_id AND o.intake_price_mode='configured-unit') THEN RAISE EXCEPTION 'A captured laundry item cannot be moved to a different order'; END IF;
 SELECT * INTO parent FROM public.guest_laundry_orders WHERE id=coalesce(NEW.order_id,OLD.order_id) AND organization_id=coalesce(NEW.organization_id,OLD.organization_id) FOR UPDATE;
 IF parent.intake_price_mode IS DISTINCT FROM 'configured-unit' THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 IF TG_OP='UPDATE' AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN RAISE EXCEPTION 'A captured laundry item cannot be moved to a different order'; END IF;
 IF parent.posting_status='posted' OR parent.status IN ('delivered','completed','closed','cancelled') THEN RAISE EXCEPTION 'Billed or completed laundry items cannot be edited; use the correction workflow'; END IF;
 IF TG_OP<>'DELETE' AND (NEW.quantity IS NULL OR NEW.quantity<=0 OR NEW.quantity::text IN ('NaN','Infinity','-Infinity') OR (NEW.counted_quantity IS NOT NULL AND (NEW.counted_quantity<0 OR NEW.counted_quantity::text IN ('NaN','Infinity','-Infinity'))) OR NEW.unit_price IS NULL OR NEW.unit_price<=0 OR NEW.unit_price::text IN ('NaN','Infinity','-Infinity') OR NEW.tax_rate IS NULL OR NEW.tax_rate<0 OR NEW.tax_rate::text IN ('NaN','Infinity','-Infinity')) THEN RAISE EXCEPTION 'Laundry quantity, counted quantity, price and tax must be valid finite amounts'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $function$;
REVOKE ALL ON FUNCTION public.neo_laundry_intake_item_price_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER neo_laundry_intake_item_price_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON public.guest_laundry_items FOR EACH ROW EXECUTE FUNCTION public.neo_laundry_intake_item_price_guard();
CREATE FUNCTION public.neo_laundry_intake_order_price_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $function$
BEGIN
 IF OLD.intake_price_mode='configured-unit' AND (NEW.express IS DISTINCT FROM OLD.express OR NEW.intake_price_mode IS DISTINCT FROM OLD.intake_price_mode) THEN RAISE EXCEPTION 'Captured laundry pricing cannot be changed; correct the order through a reviewed replacement'; END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.neo_laundry_intake_order_price_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER neo_laundry_intake_order_price_guard_trg BEFORE UPDATE ON public.guest_laundry_orders FOR EACH ROW EXECUTE FUNCTION public.neo_laundry_intake_order_price_guard();
NOTIFY pgrst,'reload schema';

COMMIT;
BEGIN READ ONLY;
WITH expected(signature,hash) AS (VALUES
('public.neo_cash_request_payment(uuid,numeric,text,text,text)','025359bfb6c3d6d6ad7464bfcd235df2'),
('public.neo_cash_settle_request(uuid)','d4805592caf414dac4ff438d4da11038'),
('public.neo_pms_collection_headroom(uuid,uuid,uuid)','9fb30a000786d48620c7ce5308d9d7ae'),
('public.neo_pms_collection_lock(uuid)','f7aaca8d7c4d4e2ab13f254784b668d1'),
('public.neo_reservation_collection_facts(uuid,uuid,uuid)','a13333be00fef8e23a31d7cfef2a2d46'),
('public.neo_reservation_collection_position(uuid)','0be2e52d818a5aa61516de603329ecb4'),
('public.neo_reservation_collection_source_refresh()','e0fd6fc005deb3a46e96ca32256e8dcc'),
('public.neo_reservation_deposit_record(uuid,numeric,text,text,text,text)','121422758038ec7edda8bc6f0c9bfbcf'),
('public.neo_reservation_financial_state_sync(uuid)','106d6863e37f1ac73425b99d364ee7a5'),
('public.pms_confirm_payment(uuid,text,text)','987e80e45018a7bb3fc26383f24d46bb'),
('public.pms_record_payment(uuid,numeric,text,text,text,text,uuid)','7f167375d93e63fbd9489e96cbd933da'),
('public.tg_folio_sync_reservation_payment_status()','cba45520d3c2c6bb299155d0d484d11e'),
('public.laundry_rollup_order()','25789d1b48d4f016aabb6dedcee1f08a'),
('public.neo_laundry_intake_item_price_guard()','08fee2a92896cfd2a589c5a51ccbed54'),
('public.neo_laundry_intake_order_price_guard()','8fad6aa2d2c425e795ff011725d1e80f'),
('public.neo_laundry_order_create(uuid,uuid,jsonb,text,boolean,text)','2c3f6fba7f2db303e9d092e49b4641c6'),
('public.neo_pos_sellable_menu_guard()','737b581fc6e7c37249557d9fb24ffda1'),
('public.neo_menu_remove_item(uuid,text,text)','82dec18a18077f6e4c58c502488e7fd3')
), checked AS (SELECT signature,md5(pg_get_functiondef(to_regprocedure(signature)))=hash AS matches FROM expected)
SELECT jsonb_build_object('diagnostic_version','reservation-laundry-menu-install-v1','definitions_match',(SELECT bool_and(matches) FROM checked),'definition_checks',(SELECT jsonb_agg(to_jsonb(checked)) FROM checked),'sale_guard_enabled',EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.pos_order_items'::regclass AND tgname='neo_pos_sellable_menu_guard_trg' AND tgenabled IN ('O','A')),'intake_columns_present',(SELECT count(*)=3 FROM information_schema.columns WHERE table_schema='public' AND table_name='guest_laundry_orders' AND column_name IN ('intake_idempotency_key','intake_request_hash','intake_price_mode')),'checkin_unchanged',md5(pg_get_functiondef(to_regprocedure('public.pms_check_in(uuid,integer,text)')))='e1b9f2a87464b3389ac5a146bdd7b459','payment_register_unchanged',md5(pg_get_functiondef(to_regprocedure('public.neo_payment_register(uuid,date,date,text,integer)')))='e256478061449b9e1247073a8a46c444','laundry_item_amounts_unchanged',md5(pg_get_functiondef(to_regprocedure('public.laundry_item_amounts()')))='208d86bff6d774d7a40a32d3c8f28baf','scope','Installs guarded routines, triggers and nullable laundry intake fields only. No collection, check-in, stock movement, product removal or historical balance rewrite is executed by installation. Wider Finance, procurement, receiving, stores and cashier acceptance remain open.') AS result;
COMMIT;
