-- NEØ scoped POS room-charge evidence and event-catering repair, 7 November 2026.
-- Submit this whole transaction once in the SAME SQL Editor project.
-- Creates no charge/payment/journal; preserves posted money and all other organisations' mappings.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $guard$
DECLARE expected record;
BEGIN
 IF to_regprocedure('public.neo_pos_room_charge_evidence(uuid,uuid,uuid,uuid,uuid)') IS NOT NULL
 OR to_regprocedure('public.neo_pos_folio_journal_receipts()') IS NOT NULL THEN
  RAISE EXCEPTION 'This repair already exists. Inspect the postcheck; do not replay it.';
 END IF;
 FOR expected IN SELECT * FROM (VALUES
('public.fin_post_journal(uuid)','4162e3e7a44d05a75389087945abe2b2'),
('public.neo_finance_canonical_mark_posted(uuid,uuid,uuid,uuid)','0c201a4949d3228a990950efbe388e62'),
('public.neo_finance_exception_register(uuid,date,date)','94f136c7374520a1c33259f73f55c380'),
('public.neo_finance_post_family(text,uuid,boolean)','4271fba359558e4e58e0a66adfe36bce'),
('public.neo_finance_post_txn(text,uuid,boolean)','dd038308a32b104e8dbfde392ff330af'),
('public.neo_finance_posting_queue(uuid,date,date)','06e9f84092e8c40e6dcc1e159b503d08'),
('public.neo_financial_state_from_receipt()','0af12c33c52a94ce889ba412f1e44369'),
('public.neo_financial_state_set(uuid,uuid,text,uuid,text,text,text,text,numeric,text,date,uuid,uuid,text,uuid,jsonb)','fb751a53d66f8490e90fd679b34f67ac'),
('public.neo_gl_post(uuid,uuid,text,text,uuid,text,date,text,text,jsonb,uuid,uuid)','7dfd4e4a4589661155fb5d7bcd02adfa'),
('public.neo_gl_revenue_code_scoped(uuid,text,text)','5261acae7633d86c8042c72dbe9a23e0'),
('public.neo_gl_revenue_code(text)','356b539623f311fa89019b39f862361e'),
('public.neo_journal_canonical_sync()','ae9012f7d7c272dbe4cc3ea6590f74c1'),
('public.neo_post_pos_order(uuid)','a0c1778b099d91a0c39d3fb7ab3667ce'),
('public.neo_receipt_resolve_journal()','39999fffc3b0b523b0486036161fd8d4'),
('public.neo_record_posting_receipt(uuid,uuid,text,uuid,text,text,numeric,text,uuid,text,text,date)','b6572ae73812155d3ae2eb08d71878b6')
 ) v(signature,definition_md5) LOOP
  IF md5(pg_get_functiondef(to_regprocedure(expected.signature))) IS DISTINCT FROM expected.definition_md5 THEN
   RAISE EXCEPTION 'Reviewed posting definition changed or is missing: %. Stop and reconcile preflight.',expected.signature;
  END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.finance_posting_receipts'::regclass AND NOT tgisinternal)<>5 THEN
  RAISE EXCEPTION 'Receipt trigger set differs from reviewed preflight';
 END IF;
 FOR expected IN SELECT * FROM (VALUES
('finance_posting_receipts_touch','CREATE TRIGGER finance_posting_receipts_touch BEFORE UPDATE ON public.finance_posting_receipts FOR EACH ROW EXECUTE FUNCTION fin_touch_updated_at()','O','d1a9917bb6dd63a3498f7557c6b82b31'),
('financial_state_from_receipt','CREATE TRIGGER financial_state_from_receipt AFTER INSERT OR UPDATE ON public.finance_posting_receipts FOR EACH ROW EXECUTE FUNCTION neo_financial_state_from_receipt()','O','0af12c33c52a94ce889ba412f1e44369'),
('posting_receipt_history','CREATE TRIGGER posting_receipt_history AFTER INSERT OR UPDATE ON public.finance_posting_receipts FOR EACH ROW EXECUTE FUNCTION neo_posting_receipt_history()','O','94ed67aa0dbe75b1f38a333f4e97271a'),
('receipt_resolve_journal','CREATE TRIGGER receipt_resolve_journal BEFORE INSERT OR UPDATE ON public.finance_posting_receipts FOR EACH ROW EXECUTE FUNCTION neo_receipt_resolve_journal()','O','39999fffc3b0b523b0486036161fd8d4'),
('trg_receipt_canonical_sync','CREATE TRIGGER trg_receipt_canonical_sync AFTER INSERT OR UPDATE OF status ON public.finance_posting_receipts FOR EACH ROW EXECUTE FUNCTION neo_receipt_canonical_sync()','O','3d75b41b05565691e486d02152a3fc06')
 ) v(trigger_name,definition,enabled,function_md5) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.finance_posting_receipts'::regclass
    AND t.tgname=expected.trigger_name AND pg_get_triggerdef(t.oid)=expected.definition
    AND t.tgenabled::text=expected.enabled AND md5(pg_get_functiondef(t.tgfoid))=expected.function_md5) THEN
   RAISE EXCEPTION 'Reviewed receipt trigger changed: %',expected.trigger_name;
  END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.chart_of_accounts WHERE organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND code='4050')<>1
 OR NOT EXISTS(SELECT 1 FROM public.chart_of_accounts WHERE id='48e27509-a66c-5520-bf4b-d5873e91d9c1'::uuid
  AND organization_id='aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid AND code='4050' AND category='revenue' AND active AND postable AND NOT is_header) THEN
  RAISE EXCEPTION 'The reviewed Savannah Events Revenue account must remain active and postable.';
 END IF;
END $guard$;

CREATE FUNCTION public.neo_pos_room_charge_evidence(_org uuid,_branch uuid,_order uuid,
 _line uuid DEFAULT NULL,_journal uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $fn$
DECLARE o public.pos_orders; f public.folio_lines; j public.journal_entries;
 n integer; d numeric; c numeric;
BEGIN
 SELECT * INTO o FROM public.pos_orders WHERE id=_order AND organization_id=_org
  AND branch_id IS NOT DISTINCT FROM _branch;
 IF o.id IS NULL OR o.folio_id IS NULL OR o.status NOT IN ('closed','paid','settled','completed','charged-to-room') THEN
  RETURN jsonb_build_object('ok',false,'reason','room_charge_order_not_finalised');
 END IF;
 IF EXISTS(SELECT 1 FROM public.journal_entries x WHERE x.organization_id=_org
  AND x.branch_id IS NOT DISTINCT FROM _branch AND x.source_document_id=o.id
  AND x.source_document_type LIKE 'pos_order:%' AND x.status='posted'
  AND x.reversed_by_journal_id IS NULL AND x.journal_type<>'reversal') THEN
  RETURN jsonb_build_object('ok',false,'reason','room_charge_has_direct_pos_journal');
 END IF;
 SELECT count(*) INTO n FROM public.folio_lines x WHERE x.organization_id=_org
  AND x.branch_id IS NOT DISTINCT FROM _branch AND x.folio_id=o.folio_id
  AND x.source_module='pos' AND x.source_record_uuid=o.id AND x.line_type='charge' AND x.status='posted';
 IF n<>1 THEN RETURN jsonb_build_object('ok',false,'reason','room_charge_line_missing_or_ambiguous'); END IF;
 SELECT * INTO f FROM public.folio_lines x WHERE x.organization_id=_org
  AND x.branch_id IS NOT DISTINCT FROM _branch AND x.folio_id=o.folio_id
  AND x.source_module='pos' AND x.source_record_uuid=o.id AND x.line_type='charge' AND x.status='posted';
 IF (_line IS NOT NULL AND _line IS DISTINCT FROM f.id)
  OR o.grand_total IS NULL OR o.grand_total<=0
  OR round(f.gross_amount-f.discount_amount+f.tax_amount+f.service_charge_amount,2) IS DISTINCT FROM round(o.grand_total,2) THEN
  RETURN jsonb_build_object('ok',false,'reason','room_charge_amount_or_line_mismatch');
 END IF;
 SELECT count(*) INTO n FROM public.journal_entries x WHERE x.organization_id=_org
  AND x.branch_id IS NOT DISTINCT FROM _branch AND x.source_document_id=f.id
  AND x.source_document_type='folio_charge:revenue' AND x.status='posted'
  AND x.reversed_by_journal_id IS NULL AND x.journal_type<>'reversal';
 IF n<>1 THEN RETURN jsonb_build_object('ok',false,'reason','room_charge_journal_missing_or_ambiguous'); END IF;
 SELECT * INTO j FROM public.journal_entries x WHERE x.organization_id=_org
  AND x.branch_id IS NOT DISTINCT FROM _branch AND x.source_document_id=f.id
  AND x.source_document_type='folio_charge:revenue' AND x.status='posted'
  AND x.reversed_by_journal_id IS NULL AND x.journal_type<>'reversal';
 SELECT coalesce(sum(x.debit),0),coalesce(sum(x.credit),0) INTO d,c
  FROM public.journal_entry_lines x WHERE x.journal_id=j.id;
 IF (_journal IS NOT NULL AND _journal IS DISTINCT FROM j.id)
  OR j.currency IS DISTINCT FROM o.currency OR d IS DISTINCT FROM o.grand_total OR c IS DISTINCT FROM o.grand_total
  OR j.total_debit IS DISTINCT FROM d OR j.total_credit IS DISTINCT FROM c
  OR EXISTS(SELECT 1 FROM public.journal_entry_lines x WHERE x.journal_id=j.id
    AND (x.organization_id IS DISTINCT FROM _org OR x.branch_id IS DISTINCT FROM _branch)) THEN
  RETURN jsonb_build_object('ok',false,'reason','room_charge_journal_evidence_mismatch');
 END IF;
 RETURN jsonb_build_object('ok',true,'folio_line_id',f.id,'journal_id',j.id,
  'amount',o.grand_total,'currency',o.currency);
END $fn$;
REVOKE ALL ON FUNCTION public.neo_pos_room_charge_evidence(uuid,uuid,uuid,uuid,uuid)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.neo_pos_folio_journal_receipts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $fn$
DECLARE f public.folio_lines; evidence jsonb;
BEGIN
 IF NEW.status<>'posted' OR NEW.source_document_type<>'folio_charge:revenue'
  OR NEW.reversed_by_journal_id IS NOT NULL THEN RETURN NEW; END IF;
 SELECT * INTO f FROM public.folio_lines WHERE id=NEW.source_document_id
  AND organization_id=NEW.organization_id AND branch_id IS NOT DISTINCT FROM NEW.branch_id
  AND source_module='pos' AND source_record_uuid IS NOT NULL;
 IF f.id IS NULL THEN RETURN NEW; END IF;
 evidence:=public.neo_pos_room_charge_evidence(NEW.organization_id,NEW.branch_id,f.source_record_uuid,f.id,NEW.id);
 IF evidence->>'ok' IS DISTINCT FROM 'true' THEN RETURN NEW; END IF;
 UPDATE public.finance_posting_receipts r SET folio_line_id=f.id,journal_id=NEW.id,
  status='posted',last_error=NULL
 WHERE r.organization_id=NEW.organization_id AND r.branch_id IS NOT DISTINCT FROM NEW.branch_id
  AND r.source_module IN ('pos','pos_order') AND r.source_id=f.source_record_uuid
  AND r.posting_type='room_charge' AND r.status IN ('posted','blocked')
  AND r.amount=(evidence->>'amount')::numeric
  AND (r.folio_line_id IS DISTINCT FROM f.id OR r.journal_id IS DISTINCT FROM NEW.id OR r.status<>'posted');
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.neo_pos_folio_journal_receipts() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER neo_pos_folio_journal_receipts_trg AFTER INSERT OR UPDATE OF status ON public.journal_entries
FOR EACH ROW EXECUTE FUNCTION public.neo_pos_folio_journal_receipts();

CREATE OR REPLACE FUNCTION public.neo_gl_revenue_code_scoped(_org uuid, _category text, _revenue_centre text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  cat text := replace(replace(lower(btrim(coalesce(_category, 'other'))), '-', '_'), ' ', '_');
  centre text := replace(replace(lower(btrim(coalesce(_revenue_centre, ''))), '-', '_'), ' ', '_');
BEGIN
  -- All organizations other than Savannah retain the installed behavior.
  IF _org IS DISTINCT FROM 'aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid THEN
    RETURN public.neo_gl_revenue_code(_category);
  END IF;

  -- The account codes below were inspected for Savannah only.
  -- Room service is currently treated as restaurant revenue (4010):
  -- no separate room-service account is configured in Savannah.
  IF cat IN ('accommodation','room','rooms','lodging') THEN RETURN '4000'; END IF;
  IF cat IN ('food_beverage','fnb','f_b') AND centre IN ('bar','main_bar','beverage') THEN RETURN '4020'; END IF;
  IF cat IN ('food_beverage','fnb','f_b') AND centre IN ('coffee','coffee_station','cafe') THEN RETURN '4030'; END IF;
  IF cat IN ('meal_plan','restaurant','food','food_beverage','fnb','f_b','dining','kitchen',
    'dine_in','takeaway','take_away','takeout','counter','quick_service','pickup','walk_in',
    'buffet','banquet_food','room_service','in_room_dining','cafe') THEN RETURN '4010'; END IF;
  IF cat IN ('bar','beverage','beverages','drinks','minibar','poolbar','pool_bar') THEN RETURN '4020'; END IF;
  IF cat IN ('coffee','espresso','barista') THEN RETURN '4030'; END IF;
  IF cat IN ('laundry','dry_cleaning') THEN RETURN '4040'; END IF;
  IF cat IN ('event','events','banquet','conference','event_catering') THEN RETURN '4050'; END IF;
  IF cat = 'delivery' THEN RETURN '4060'; END IF;
  IF cat IN ('transfer','transfers','airport_transfer') THEN RETURN '4070'; END IF;
  IF cat = 'transport' THEN RETURN '4080'; END IF;
  IF cat IN ('other','miscellaneous','excursion') THEN RETURN '4090'; END IF;

  -- Fail closed for Savannah unrecognized categories instead of posting misclassified revenue.
  RAISE EXCEPTION 'Unmapped Savannah revenue category: %', coalesce(_category,'<NULL>')
    USING ERRCODE = '22023';
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_post_pos_order(_order uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare org uuid:=public.current_org_id(); o public.pos_orders; line uuid; prior text;
begin
  if org is null or not (public.is_org_admin() or public.has_permission('finance','view') or public.has_permission('restaurant','orders.settle') or public.neo_system_posting()) then raise exception 'insufficient_privilege' using errcode='42501'; end if;
  -- Locked so two settlements of the same bill cannot both pass the
  -- already-posted check and charge the guest folio twice.
  select * into o from public.pos_orders where id=_order and organization_id=org for update;
  if not found then return jsonb_build_object('ok',false,'reason','not_found'); end if;
  if o.status not in ('closed','paid','settled','completed','charged-to-room') then return jsonb_build_object('ok',false,'reason','not_finalised','status',o.status); end if;
  if o.folio_post_status='posted' then
    return public.neo_pos_room_charge_evidence(org,o.branch_id,o.id)
      || jsonb_build_object('already_posted',true);
  end if;
  if o.folio_id is null then return jsonb_build_object('ok',false,'reason','no_folio','detail','The order is not attached to a guest folio, so it cannot be posted as a folio charge.'); end if;
  prior:=coalesce(current_setting('neo.system_posting',true),'off');
  perform set_config('neo.system_posting','on',true);
  line:=public.folio_post_charge(o.folio_id,'food-beverage','Point of sale order '||o.order_number,1,o.subtotal,o.tax_total,o.service_charge_total,o.discount_total,'pos',o.id,'fnb','pos:'||o.id::text,null);
  perform set_config('neo.system_posting',prior,true);
  update public.pos_orders set folio_post_status='posted',updated_at=now() where id=o.id;
  return jsonb_build_object('ok',true,'folio_line_id',line);
end $function$;

CREATE OR REPLACE FUNCTION public.neo_receipt_resolve_journal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE evidence jsonb;
BEGIN
  -- A POS room transfer is backed by its folio journal, not another POS revenue posting.
  IF NEW.source_module IN ('pos','pos_order') AND lower(coalesce(NEW.status,''))='posted'
     AND EXISTS(SELECT 1 FROM public.pos_orders o WHERE o.id=NEW.source_id
       AND o.organization_id=NEW.organization_id AND o.branch_id IS NOT DISTINCT FROM NEW.branch_id
       AND o.folio_id IS NOT NULL) THEN
    evidence:=public.neo_pos_room_charge_evidence(NEW.organization_id,NEW.branch_id,NEW.source_id,
      NEW.folio_line_id,NEW.journal_id);
    IF evidence->>'ok'='true' AND NEW.amount=(evidence->>'amount')::numeric
       AND NEW.currency=evidence->>'currency' THEN
      NEW.folio_line_id:=(evidence->>'folio_line_id')::uuid;
      NEW.journal_id:=(evidence->>'journal_id')::uuid;
      NEW.last_error:=NULL;
    ELSE
      NEW.status:='blocked';
      NEW.last_error:='Room charge evidence: '||coalesce(evidence->>'reason','receipt_amount_or_currency_mismatch');
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.journal_id IS NULL AND lower(coalesce(NEW.status,'')) = 'posted' THEN
    SELECT j.id INTO NEW.journal_id
      FROM public.journal_entries j
     WHERE j.organization_id = NEW.organization_id
       AND j.source_document_id = NEW.source_id
       AND j.status = 'posted'
       AND abs(coalesce(j.total_debit,0) - coalesce(j.total_credit,0)) < 0.01
     ORDER BY j.posted_at DESC NULLS LAST, j.created_at DESC
     LIMIT 1;
  END IF;
  RETURN NEW;
END $function$;

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
  paid numeric; remainder numeric; key text;
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
END $function$;
-- Repair ONLY the three reviewed metadata links. No new charge, payment or journal.
DO $recover$
DECLARE expected record; r public.finance_posting_receipts; evidence jsonb;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
('4c18ec8f-a776-4954-bc2c-21e514129f59'::uuid,'e035efe5-d68b-401d-a3e5-e1f4ef0377ef'::uuid,'51ec120d-c87f-43f4-919b-d114a196e3c5'::uuid,'17ca6aae-055a-4b32-93b0-5d04c1dfc827'::uuid,3399::numeric,'POS-20261102-EON7D'),
('f788bbe1-d6c2-4539-bfa0-430ae33f9341'::uuid,'0ef64b68-484d-4b3b-ae68-577daa632adc'::uuid,'64ede377-856e-42fd-8204-0d990a16875a'::uuid,'5a12f544-2980-4994-a5b9-8daa5ae89695'::uuid,1081.5::numeric,'POS-20261104-09ZFT'),
('e0074db7-c506-408d-8849-5899ceb9bef5'::uuid,'113cb21c-82c0-41f4-b861-b80456b02ee8'::uuid,'9b67e3b3-a228-4bcc-adf0-1fc3dae68a40'::uuid,'293bd207-7597-4133-afc6-deed95275481'::uuid,2111.5::numeric,'POS-20261002-QGIV7')
 ) v(receipt_id,order_id,line_id,journal_id,amount,reference) ORDER BY receipt_id LOOP
  SELECT * INTO r FROM public.finance_posting_receipts WHERE id=expected.receipt_id FOR UPDATE;
  IF r.id IS NULL OR r.organization_id IS DISTINCT FROM 'aa17d427-f816-49bc-b02e-1a89e44806a2'::uuid
    OR r.branch_id IS DISTINCT FROM '2addbd01-c643-406a-bd7d-fac1aa76b23c'::uuid OR r.source_module IS DISTINCT FROM 'pos'
    OR r.source_id IS DISTINCT FROM expected.order_id OR r.source_reference IS DISTINCT FROM expected.reference
    OR r.amount IS DISTINCT FROM expected.amount OR r.currency IS DISTINCT FROM 'KES'
    OR r.posting_type IS DISTINCT FROM 'room_charge' OR r.status IS DISTINCT FROM 'posted'
    OR r.folio_line_id IS NOT NULL OR r.journal_id IS NOT NULL OR r.last_error IS NOT NULL THEN
   RAISE EXCEPTION 'Reviewed receipt changed: %. No partial recovery is allowed.',expected.reference;
  END IF;
  evidence:=public.neo_pos_room_charge_evidence(r.organization_id,r.branch_id,r.source_id,expected.line_id,expected.journal_id);
  IF evidence->>'ok' IS DISTINCT FROM 'true' OR (evidence->>'amount')::numeric IS DISTINCT FROM expected.amount THEN
   RAISE EXCEPTION 'Existing folio/journal evidence failed for %: %',expected.reference,evidence->>'reason';
  END IF;
  UPDATE public.finance_posting_receipts SET folio_line_id=expected.line_id,journal_id=expected.journal_id,
    status='posted',last_error=NULL WHERE id=r.id;
 END LOOP;
END $recover$;

NOTIFY pgrst,'reload schema';
COMMIT;
