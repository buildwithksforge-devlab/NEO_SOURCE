BEGIN;
DO $related_guards$ DECLARE r record; BEGIN
 FOR r IN SELECT * FROM (VALUES ('public.neo_pos_lifecycle_guard()','e6b9988870d2955341f77da0dd199bf8','10019359c67d41f67b14e13e3cc91df3'),
('public.neo_mpesa_complete_pos_order(uuid,uuid)','8e38aa888d518070a34ea1cc27d41669','0a1091a8fc47ddab0b722cd2ce60bf07'),
('public.neo_pos_menu_availability(uuid)','876f2e8ed961b1df63db13a325817387','09181ef6c169d4c58825cae93590f48c')) x(signature,old_hash,new_hash) LOOP
  IF coalesce(md5(pg_get_functiondef(to_regprocedure(r.signature))),'missing') NOT IN (r.old_hash,r.new_hash) THEN
   RAISE EXCEPTION 'Installed routine differs: %. Stop before applying the package.',r.signature;
  END IF;
 END LOOP;
END; $related_guards$;
CREATE TEMP TABLE mpesa_date_repair_owner ON COMMIT DROP AS
 SELECT pg_get_userbyid(p.proowner) AS owner_name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='neo_mpesa_apply_result';
DO $guard$
BEGIN
 IF (SELECT count(*) FROM mpesa_date_repair_owner)<>1 THEN RAISE EXCEPTION 'Expected exactly one result RPC; stop before changing overloads'; END IF;
 IF to_regprocedure('public.neo_mpesa_apply_result(uuid,integer,text,text,timestamptz,jsonb,text)') IS NOT NULL THEN
  IF md5(pg_get_functiondef('public.neo_mpesa_apply_result(uuid,integer,text,text,timestamptz,jsonb,text)'::regprocedure))<>'2923df814d7a1689d48df2b49cfa8e7b' THEN
   RAISE EXCEPTION 'Result routine differs from reviewed installed code; no change made';
  END IF;
  DROP FUNCTION public.neo_mpesa_apply_result(uuid,integer,text,text,timestamptz,jsonb,text) RESTRICT;
 ELSIF to_regprocedure('public.neo_mpesa_apply_result(uuid,integer,text,text,text,jsonb,text)') IS NULL OR
  md5(pg_get_functiondef('public.neo_mpesa_apply_result(uuid,integer,text,text,text,jsonb,text)'::regprocedure))<>'f97e834bf1cc78138fb258bce2c72195' THEN
  RAISE EXCEPTION 'Result routine differs from reviewed date correction; no change made';
 END IF;
END;
$guard$;
CREATE OR REPLACE FUNCTION public.neo_mpesa_apply_result(_transaction uuid, _result_code integer, _result_desc text, _receipt text, _transaction_date text, _payload jsonb, _source text DEFAULT 'callback'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _t public.mpesa_transactions; _status text; _p public.pos_payments; _pay public.payments; _res public.reservations;
        _completion jsonb := NULL; _normalized_date timestamptz; _date_value public.mpesa_transactions.transaction_date%TYPE; _stored_callback jsonb; _callback_receipt text; _callback_date text;
BEGIN
  SELECT * INTO _t FROM public.mpesa_transactions WHERE id = _transaction FOR UPDATE;
  IF _t.id IS NULL THEN RETURN jsonb_build_object('applied', false, 'reason', 'Transaction not found'); END IF;

  -- A fresh successful provider status query may recover metadata from a callback
  -- that already passed tenant/provider/amount checks but failed atomic posting.
  IF _result_code=0 AND _source='status-query' AND nullif(btrim(_receipt),'') IS NULL THEN
    SELECT e.payload,meta.receipt,meta.clock INTO _stored_callback,_callback_receipt,_callback_date
    FROM public.mpesa_callback_events e
    CROSS JOIN LATERAL (
      SELECT max(x->>'Value') FILTER(WHERE x->>'Name'='MpesaReceiptNumber') AS receipt,
             max(x->>'Value') FILTER(WHERE x->>'Name'='TransactionDate') AS clock,
             max(x->>'Value') FILTER(WHERE x->>'Name'='Amount') AS amount,
             count(*) FILTER(WHERE x->>'Name'='Amount') AS amount_count,
             count(*) FILTER(WHERE x->>'Name'='MpesaReceiptNumber') AS receipt_count,
             count(*) FILTER(WHERE x->>'Name'='TransactionDate') AS clock_count
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload#>'{Body,stkCallback,CallbackMetadata,Item}')='array'
        THEN e.payload#>'{Body,stkCallback,CallbackMetadata,Item}' ELSE '[]'::jsonb END) x
    ) meta
    WHERE e.organization_id=_t.organization_id AND e.accepted=false AND e.source='callback'
      AND e.detail LIKE 'Could not apply result:%'
      AND (e.transaction_id=_t.id OR e.checkout_request_id=_t.checkout_request_id)
      AND e.payload#>>'{Body,stkCallback,ResultCode}'='0'
      AND e.payload#>>'{Body,stkCallback,CheckoutRequestID}'=_t.checkout_request_id
      AND (_t.merchant_request_id IS NULL OR e.payload#>>'{Body,stkCallback,MerchantRequestID}'=_t.merchant_request_id)
      AND CASE WHEN meta.amount ~ '^[0-9]+([.][0-9]+)?$' THEN meta.amount::numeric ELSE NULL END=_t.amount
      AND meta.amount_count=1 AND meta.receipt_count=1 AND meta.clock_count=1
      AND nullif(btrim(meta.receipt),'') IS NOT NULL
    ORDER BY e.received_at DESC LIMIT 1;
    IF _stored_callback IS NOT NULL THEN
      _receipt:=_callback_receipt;
      _transaction_date:=coalesce(nullif(btrim(_transaction_date),''),_callback_date);
      _payload:=jsonb_build_object('verification',_payload,'callback',_stored_callback);
    END IF;
  END IF;

  -- The existing HTTP RPC accepts a JSON string. Safaricom sends YYYYMMDDHH24MISS
  -- in Kenyan time; normalize it before assigning the timestamptz column.
  IF nullif(btrim(_transaction_date),'') IS NOT NULL THEN
    IF btrim(_transaction_date) ~ '^[0-9]{14}$' THEN
      IF substr(btrim(_transaction_date),1,4)::int<1970
         OR substr(btrim(_transaction_date),9,2)::int>23
         OR substr(btrim(_transaction_date),11,2)::int>59
         OR substr(btrim(_transaction_date),13,2)::int>59 THEN
        RAISE EXCEPTION 'Invalid provider transaction clock' USING ERRCODE='22007';
      END IF;
      _normalized_date:=make_timestamptz(substr(btrim(_transaction_date),1,4)::int,
        substr(btrim(_transaction_date),5,2)::int,substr(btrim(_transaction_date),7,2)::int,
        substr(btrim(_transaction_date),9,2)::int,substr(btrim(_transaction_date),11,2)::int,
        substr(btrim(_transaction_date),13,2)::int,'Africa/Nairobi');
    ELSIF btrim(_transaction_date) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
      _normalized_date:=btrim(_transaction_date)::timestamptz;
    ELSE
      RAISE EXCEPTION 'Invalid provider transaction date format' USING ERRCODE='22007';
    END IF;
  END IF;

  IF _normalized_date IS NOT NULL THEN
    _date_value:=to_char(_normalized_date AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  END IF;


  INSERT INTO public.mpesa_callback_events (organization_id, transaction_id, checkout_request_id, source, payload, detail)
  VALUES (_t.organization_id, _t.id, _t.checkout_request_id, _source, COALESCE(_payload, '{}'::jsonb), _result_desc);

  IF _t.applied_at IS NOT NULL THEN
    RETURN jsonb_build_object('applied', false, 'duplicate', true, 'status', _t.status);
  END IF;

  _status := CASE
    WHEN _result_code = 0 THEN 'success'
    WHEN _result_code = 1032 THEN 'cancelled'
    WHEN _result_code IN (1037, 1019) THEN 'timeout'
    ELSE 'failed' END;

  UPDATE public.mpesa_transactions
     SET status = _status,
         result_code = _result_code,
         result_desc = _result_desc,
         mpesa_receipt_number = COALESCE(NULLIF(btrim(COALESCE(_receipt, '')), ''), mpesa_receipt_number),
         transaction_date = COALESCE(_date_value, transaction_date),
         raw_result = COALESCE(_payload, raw_result),
         reconciled_at = now(),
         applied_at = now(),
         failure_detail = CASE WHEN _result_code = 0 THEN NULL ELSE _result_desc END,
         updated_at = now()
   WHERE id = _t.id;

  IF _status <> 'success' THEN
    IF _t.payment_table = 'pos_payments' AND _t.payment_id IS NOT NULL THEN
      UPDATE public.pos_payments SET status = 'failed', provider_status = COALESCE(_result_desc, 'provider-declined')
       WHERE id = _t.payment_id AND status IN ('initiated', 'pending')
       RETURNING order_id INTO _p.order_id;
      IF _p.order_id IS NOT NULL THEN PERFORM public.pos_reconcile_settlement_internal(_p.order_id); END IF;
      PERFORM public.neo_mpesa_delivery_sync(_p.order_id, false);
    ELSIF _t.payment_table = 'payments' AND _t.payment_id IS NOT NULL THEN
      UPDATE public.payments SET status = 'failed' WHERE id = _t.payment_id AND status = 'pending';
    END IF;
    RETURN jsonb_build_object('applied', true, 'status', _status);
  END IF;

  IF _t.payment_table = 'pos_payments' AND _t.payment_id IS NOT NULL THEN
    SELECT * INTO _p FROM public.pos_payments WHERE id = _t.payment_id FOR UPDATE;
    IF _p.id IS NOT NULL AND _p.status IN ('initiated', 'pending') THEN
      UPDATE public.pos_payments
         SET status = 'confirmed', provider_status = 'provider-confirmed', paid_at = now(),
             external_reference = COALESCE(NULLIF(btrim(COALESCE(_receipt, '')), ''), external_reference)
       WHERE id = _p.id;
      PERFORM public.pos_reconcile_settlement_internal(_p.order_id);
      PERFORM public.neo_mpesa_delivery_sync(_p.order_id, true);
      _completion := public.neo_mpesa_complete_pos_order(_p.order_id, _t.organization_id);
    END IF;
  ELSIF _t.payment_table = 'payments' AND _t.payment_id IS NOT NULL THEN
    SELECT * INTO _pay FROM public.payments WHERE id = _t.payment_id FOR UPDATE;
    IF _pay.id IS NOT NULL AND _pay.status = 'pending' THEN
      UPDATE public.payments
         SET status = 'confirmed',
             external_reference = COALESCE(NULLIF(btrim(COALESCE(_receipt, '')), ''), external_reference)
       WHERE id = _pay.id;
      IF _pay.folio_id IS NOT NULL THEN
        INSERT INTO public.payment_allocations (organization_id, payment_id, folio_id, amount, created_by)
        VALUES (_pay.organization_id, _pay.id, _pay.folio_id, _pay.amount, _pay.received_by);
        UPDATE public.folios
           SET total_payments = total_payments + _pay.amount,
               balance = balance - _pay.amount,
               updated_at = now()
         WHERE id = _pay.folio_id;
      END IF;
    END IF;
  ELSIF _t.source_module = 'reservation_deposit' AND _t.source_record_id IS NOT NULL THEN
    SELECT * INTO _res FROM public.reservations WHERE id = _t.source_record_id;
    IF _res.id IS NOT NULL THEN
      INSERT INTO public.reservation_deposits (
        organization_id, branch_id, reservation_id, customer_id, amount, currency, method,
        reference, status, idempotency_key, notes)
      VALUES (_t.organization_id, COALESCE(_t.branch_id, _res.branch_id), _res.id, _res.customer_id,
              _t.amount, 'KES', 'mpesa',
              COALESCE(NULLIF(btrim(COALESCE(_receipt, '')), ''), _t.id::text), 'held',
              'mpesa-deposit:' || _t.id::text, 'Guest app booking deposit')
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_t.organization_id, _t.branch_id, _t.created_by, 'integration.mpesa.confirmed', 'finance', _t.id::text,
          jsonb_build_object('receipt', _receipt, 'amount', _t.amount, 'source', _source,
                             'sourceModule', _t.source_module, 'sourceRecord', _t.source_record_id,
                             'completion', _completion));

  RETURN jsonb_build_object('applied', true, 'status', _status, 'completion', _completion);
END $function$
;
DO $owner$
DECLARE who text;
BEGIN
 SELECT owner_name INTO STRICT who FROM mpesa_date_repair_owner;
 EXECUTE format('ALTER FUNCTION public.neo_mpesa_apply_result(uuid,integer,text,text,text,jsonb,text) OWNER TO %I',who);
END;
$owner$;
REVOKE ALL ON FUNCTION public.neo_mpesa_apply_result(uuid,integer,text,text,text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.neo_mpesa_apply_result(uuid,integer,text,text,text,jsonb,text) TO service_role;
CREATE OR REPLACE FUNCTION public.neo_pos_lifecycle_guard()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE _provider_prepaid boolean:=false; _actual numeric; _expected text;
BEGIN
  -- Payment and service are separate facts. Only a matching, actually applied
  -- provider collection can justify prepayment on a still-unserved order.
  IF NEW.status NOT IN ('cancelled','voided','void','closed','completed','settled')
     AND coalesce(NEW.paid_total,0)>0 THEN
    SELECT coalesce(sum(p.amount),0) INTO _actual FROM public.pos_payments p
     WHERE p.order_id=NEW.id AND p.organization_id=NEW.organization_id
       AND p.branch_id IS NOT DISTINCT FROM NEW.branch_id AND p.status='confirmed';
    _expected:=CASE WHEN _actual<=0 THEN 'unpaid'
      WHEN coalesce(NEW.grand_total,0)>0 AND _actual>=NEW.grand_total-0.005 THEN 'paid' ELSE 'partial' END;
    _provider_prepaid:=_actual::text NOT IN ('NaN','Infinity','-Infinity')
      AND NEW.paid_total IS NOT DISTINCT FROM _actual AND NEW.payment_status IS NOT DISTINCT FROM _expected
      AND EXISTS(SELECT 1 FROM public.mpesa_transactions t JOIN public.pos_payments p
        ON p.id=t.payment_id AND p.organization_id=t.organization_id
        WHERE p.order_id=NEW.id AND p.organization_id=NEW.organization_id
          AND p.branch_id IS NOT DISTINCT FROM NEW.branch_id AND p.status='confirmed' AND p.method='mpesa'
          AND t.payment_table='pos_payments' AND t.source_module='pos_order' AND t.source_record_id=NEW.id
          AND t.branch_id IS NOT DISTINCT FROM p.branch_id AND t.amount=p.amount
          AND t.status='success' AND t.result_code=0 AND t.applied_at IS NOT NULL);
  END IF;
  IF current_setting('neo.payment_maintenance', true) = 'on' THEN RETURN NEW; END IF;

  IF NEW.status IN ('draft','cancelled','voided','void')
     AND coalesce(NEW.payment_status,'unpaid') IN ('paid','partial','partially_paid')
     AND NOT (NEW.status='draft' AND _provider_prepaid) THEN
    RAISE EXCEPTION 'A % order cannot be marked as %. Settle the order from the POS instead.',
      NEW.status, NEW.payment_status USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('draft','cancelled','voided','void')
     AND coalesce(NEW.paid_total,0) > 0
     AND NOT (NEW.status='draft' AND _provider_prepaid) THEN
    RAISE EXCEPTION 'A % order cannot carry a paid amount. Reverse the payment first.', NEW.status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('closed','completed','settled')
     AND coalesce(NEW.payment_status,'unpaid') NOT IN ('paid','settled','complimentary','transferred','charged_to_room')
     AND coalesce(NEW.grand_total,0) > 0 THEN
    RAISE EXCEPTION 'This order cannot be closed while its payment is %.', NEW.payment_status
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IN ('sent','confirmed','preparing','ready','served','partially-served')
     AND coalesce(NEW.payment_status,'unpaid') IN ('paid','settled')
     AND coalesce(NEW.grand_total,0) > 0
     AND coalesce(NEW.paid_total,0) >= coalesce(NEW.grand_total,0)
     AND NOT _provider_prepaid THEN
    RAISE EXCEPTION 'This order is fully paid and cannot remain %. Close the order to complete settlement.', NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $function$;;
CREATE OR REPLACE FUNCTION public.neo_mpesa_complete_pos_order(_pos_order uuid, _org uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _o public.pos_orders;
  _pay record;
  _receipts int := 0;
  _kitchen text := 'not-required';
  _finance text := 'not-attempted';
  _prior_org text;
  _prior_posting text;
  _res jsonb;
BEGIN
  IF _pos_order IS NULL OR _org IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_arguments');
  END IF;
  SELECT * INTO _o FROM public.pos_orders WHERE id = _pos_order AND organization_id = _org;
  IF _o.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;

  _prior_org := coalesce(current_setting('neo.system_org', true), '');
  _prior_posting := coalesce(current_setting('neo.system_posting', true), 'off');
  PERFORM set_config('neo.system_org', _org::text, true);
  PERFORM set_config('neo.system_posting', 'on', true);

  -- 1. A numbered receipt for every confirmed payment that does not have one.
  FOR _pay IN
    SELECT id FROM public.pos_payments
     WHERE order_id = _pos_order AND organization_id = _org
       AND status = 'confirmed' AND coalesce(btrim(coalesce(receipt_number, '')), '') = ''
  LOOP
    BEGIN
      UPDATE public.pos_payments
         SET receipt_number = public.next_document_number('receipt', 'RCP', _o.branch_id)
       WHERE id = _pay.id;
      _receipts := _receipts + 1;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- a numbering failure must not undo a confirmed payment
    END;
  END LOOP;

  -- 2. Send to the kitchen when the order has sendable lines and no tickets yet.
  IF _o.status IN ('draft','held') AND _o.sent_at IS NULL
     AND coalesce(_o.order_source,'waiter-pos')<>'guest-app'
     AND NOT EXISTS(SELECT 1 FROM public.delivery_orders d WHERE d.pos_order_id=_pos_order AND d.organization_id=_org)
     AND EXISTS(SELECT 1 FROM public.pos_order_items i WHERE i.order_id=_pos_order AND i.organization_id=_org AND i.status='draft') THEN
    _kitchen:='awaiting-explicit-send';
  ELSIF public.neo_pos_order_is_kitchen_bound(_pos_order, _org)
     AND NOT EXISTS (SELECT 1 FROM public.station_tickets WHERE order_id = _pos_order) THEN
    BEGIN
      PERFORM public.neo_pos_route_tickets_internal(_pos_order, _org);
      _kitchen := 'sent';
    EXCEPTION WHEN OTHERS THEN
      _kitchen := 'failed: ' || SQLERRM;
    END;
  ELSIF EXISTS (SELECT 1 FROM public.station_tickets WHERE order_id = _pos_order) THEN
    _kitchen := 'already-sent';
  END IF;

  IF _kitchen='awaiting-explicit-send' THEN
    _finance:='awaiting-service';
  ELSE
  -- 3. Post the sale to Finance.
  BEGIN
    _res := public.neo_finance_post_source('pos', _pos_order, true);
    _finance := CASE WHEN coalesce((_res->>'ok')::boolean, false)
                     THEN coalesce(_res->>'reason', 'posted')
                     ELSE 'blocked: ' || coalesce(_res->>'reason', 'unknown') END;
  EXCEPTION WHEN OTHERS THEN
    _finance := 'failed: ' || SQLERRM;
  END;
  END IF;

  PERFORM set_config('neo.system_posting', _prior_posting, true);
  PERFORM set_config('neo.system_org', _prior_org, true);

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_org, _o.branch_id, NULL, 'pos.payment.completed', 'pos', _pos_order::text,
          jsonb_build_object('receipts_issued', _receipts, 'kitchen', _kitchen, 'finance', _finance));

  RETURN jsonb_build_object('ok', true, 'receipts_issued', _receipts,
                            'kitchen', _kitchen, 'finance', _finance);
END $function$
;
CREATE OR REPLACE FUNCTION public.neo_pos_menu_availability(_branch uuid)
RETURNS TABLE(menu_item_id uuid, available boolean, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_org uuid := public.current_org_id(); m record; s record;
BEGIN
  IF v_org IS NULL OR NOT EXISTS (SELECT 1 FROM branches WHERE id = _branch AND organization_id = v_org) THEN
    RETURN;
  END IF;
  IF NOT (_branch = ANY(COALESCE(public.current_branch_ids(), '{}'::uuid[])) OR public.is_org_admin_for(v_org)) THEN
    RETURN;
  END IF;
  IF public.neo_inventory_allows_negative(v_org, _branch) THEN RETURN; END IF;
  FOR m IN SELECT mi.id FROM menu_items mi
            WHERE mi.organization_id = v_org AND (mi.branch_id = _branch OR mi.branch_id IS NULL)
  LOOP
    BEGIN
      SELECT * INTO s FROM public.neo_pos_stock_shortfalls(v_org, _branch, m.id, NULL, 1, NULL) LIMIT 1;
    EXCEPTION WHEN data_exception THEN
      menu_item_id:=m.id; available:=false;
      reason:='Stock cannot be verified for this item. Check its ingredient quantities and unit conversions before ordering.';
      RETURN NEXT; CONTINUE;
    END;
    IF s IS NOT NULL THEN
      menu_item_id := m.id; available := false;
      reason := CASE WHEN s.location_id IS NULL THEN 'No department store set up'
                     ELSE format('Out of stock: %s. Needs %s %s; %s available in %s.',
                       s.item_name,s.required::text,coalesce(s.unit,''),
                       greatest(coalesce(s.on_hand,0)-coalesce(s.committed,0),0)::text,
                       coalesce(s.store_name,'station store')) END;
      RETURN NEXT;
    END IF;
  END LOOP;
END $$;;
SELECT jsonb_build_object('diagnostic_version','mpesa-confirmation-paid-service-stock-v1',
 'routine_checks',(SELECT jsonb_agg(jsonb_build_object('signature',signature,'matches',md5(pg_get_functiondef(to_regprocedure(signature)))=hash)) FROM (VALUES ('public.neo_pos_lifecycle_guard()','10019359c67d41f67b14e13e3cc91df3'),('public.neo_mpesa_complete_pos_order(uuid,uuid)','0a1091a8fc47ddab0b722cd2ce60bf07'),('public.neo_pos_menu_availability(uuid)','09181ef6c169d4c58825cae93590f48c')) x(signature,hash)),
 'date_contract_installed',md5(pg_get_functiondef('public.neo_mpesa_apply_result(uuid,integer,text,text,text,jsonb,text)'::regprocedure))='f97e834bf1cc78138fb258bce2c72195',
 'one_result_rpc',(SELECT count(*)=1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='neo_mpesa_apply_result'),
 'date_column_type',(SELECT format_type(a.atttypid,a.atttypmod) FROM pg_attribute a WHERE a.attrelid='public.mpesa_transactions'::regclass AND a.attname='transaction_date' AND NOT a.attisdropped),
 'privileged_boundary_closed',NOT has_function_privilege('anon','public.neo_mpesa_apply_result(uuid,integer,text,text,text,jsonb,text)','EXECUTE') AND NOT has_function_privilege('authenticated','public.neo_mpesa_apply_result(uuid,integer,text,text,text,jsonb,text)','EXECUTE'),
 'scope','Restores the existing result RPC string contract and normalizes compact Kenyan provider dates. Verified provider prepayments stay financially recorded without silently sending staff draft items. Stock explanations include exact shortfalls. Installation applies no payment, sends no order, moves no stock and changes no history.') AS result;
NOTIFY pgrst,'reload schema';
COMMIT;
