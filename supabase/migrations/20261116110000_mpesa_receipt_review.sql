BEGIN;
CREATE TEMP TABLE neo_receipt_review_originals (
  signature text PRIMARY KEY, owner_oid oid, acl aclitem[], expected text
) ON COMMIT DROP;
INSERT INTO neo_receipt_review_originals
SELECT 'public.neo_approval_standard_types()', p.proowner, p.proacl, 'CREATE OR REPLACE FUNCTION public.neo_approval_standard_types()
 RETURNS TABLE(key text, name text)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''public''
AS $function$
  SELECT * FROM (VALUES
    (''discount'', ''Discount''),
    (''bill-void'', ''Bill void request''),
    (''bill-adjustment'', ''Bill adjustment''),
    (''complimentary-meal'', ''Complimentary meal''),
    (''complimentary-room'', ''Complimentary room''),
    (''refund'', ''Refund approval''),
    (''payment-reversal'', ''Payment reversal''),
    (''write-off'', ''Write-off approval''),
    (''cash-variance'', ''Cash variance review''),
    (''rate-override'', ''Rate override''),
    (''price-change'', ''Manual price change''),
    (''credit-account'', ''Credit account approval''),
    (''purchase-request'', ''Purchase requisition''),
    (''purchase-order'', ''Purchase order / LPO''),
    (''procurement-variance'', ''Procurement variance / exception''),
    (''supplier-invoice'', ''Supplier invoice''),
    (''procurement-approval'', ''Procurement approval''),
    (''stock-adjustment'', ''Stock adjustment''),
    (''stock-write-off'', ''Stock write-off''),
    (''expense'', ''Expense approval''),
    (''till-reopen'', ''Till reopening''),
    (''event-quotation'', ''Event quotation''),
    (''event-pricing-exception'', ''Event pricing exception'')
  ) AS v(key, name);
$function$'
FROM pg_proc p WHERE p.oid=to_regprocedure('public.neo_approval_standard_types()');
INSERT INTO neo_receipt_review_originals
SELECT 'public.neo_approval_route(text,numeric,numeric,uuid,uuid,uuid)', p.proowner, p.proacl, 'CREATE OR REPLACE FUNCTION public.neo_approval_route(_type text, _amount numeric DEFAULT NULL::numeric, _percent numeric DEFAULT NULL::numeric, _branch uuid DEFAULT NULL::uuid, _department uuid DEFAULT NULL::uuid, _requester uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''public''
AS $function$
DECLARE
  o uuid := public.current_org_id();
  q uuid := coalesce(_requester, auth.uid());
  x record; ops uuid; own uuid;
  pol record;
  unstaffed boolean := false;
  self_only boolean := false;
  reserved boolean;
  exception_active boolean;
BEGIN
  IF o IS NULL THEN RETURN jsonb_build_object(''status'',''unconfigured'',''message'',''No workspace context''); END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.self_approval_exceptions e
    WHERE e.organization_id = o AND e.workflow_key = _type AND e.active
      AND e.effective_from <= current_date
      AND (e.effective_to IS NULL OR e.effective_to >= current_date)
  ) INTO exception_active;

  SELECT * INTO pol FROM public.approval_routing_policies p
   WHERE p.organization_id = o AND p.workflow_key = _type AND p.active
   LIMIT 1;

  IF pol.id IS NOT NULL THEN
    reserved := pol.reserved_role_id IS NOT NULL;
  ELSE
    reserved := lower(coalesce(_type,'''')) = ANY(ARRAY[''void'',''cancel'',''cancellation'',''discount'',''refund'',''complimentary'',''rate-override'',''write-off'',''payment-reversal'',''till-reopen'',''period-reopen'']);
  END IF;

  IF reserved THEN
    IF pol.id IS NOT NULL THEN
      SELECT id INTO own FROM public.roles
       WHERE id = pol.reserved_role_id AND organization_id = o AND coalesce(active,true)
         AND public.neo_role_is_staffed(id,_branch)
       LIMIT 1;
    ELSE
      SELECT id INTO own FROM public.roles
       WHERE organization_id=o AND coalesce(active,true)
         AND public.neo_resolve_role_template_key(normalized_role_key,name)=''owner''
         AND public.neo_role_is_staffed(id,_branch)
       LIMIT 1;
    END IF;
    IF own IS NULL THEN
      RETURN jsonb_build_object(''status'',''owner_unstaffed'',''message'',''This reserved action has no staffed approver in the configured reserved role.'');
    END IF;
    IF NOT exception_active AND q IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.role_id = own AND ur.organization_id = o AND ur.user_id <> q) THEN
      RETURN jsonb_build_object(''status'',''self_only'',''level'',1,''approver_role_id'',own,''approver_user_id'',NULL,
        ''required_approvers'',1,
        ''message'',''You raised this reserved request and you are the only holder of the reserved approval role. It is held for an independent approver.'');
    END IF;
    RETURN jsonb_build_object(''status'',''owner_reserved'',''level'',1,''approver_role_id'',own,''approver_user_id'',NULL,''required_approvers'',1,''message'',''Routed to the configured reserved approver under restricted-action policy.'');
  END IF;

  FOR x IN
    SELECT * FROM public.approval_rules r
     WHERE r.organization_id=o AND r.active AND r.approval_type=_type
       AND (r.branch_id IS NULL OR r.branch_id=_branch)
       AND (r.department_id IS NULL OR r.department_id=_department)
       AND (r.effective_from IS NULL OR r.effective_from <= current_date)
       AND (r.effective_to IS NULL OR r.effective_to >= current_date)
     ORDER BY (r.branch_id IS NOT NULL) DESC, (r.department_id IS NOT NULL) DESC, r.level
  LOOP
    IF (x.min_amount IS NOT NULL AND _amount IS NOT NULL AND _amount < x.min_amount) THEN
      CONTINUE;
    END IF;

    IF (x.max_amount IS NOT NULL AND _amount IS NOT NULL AND _amount > x.max_amount)
       OR (x.max_percent IS NOT NULL AND _percent IS NOT NULL AND _percent > x.max_percent) THEN
      CONTINUE;
    END IF;

    IF x.approver_user_id = q AND NOT (x.allow_self_approval AND exception_active) THEN
      self_only := true; CONTINUE;
    END IF;

    IF x.approver_user_id IS NULL AND x.approver_role_id IS NOT NULL THEN
      IF NOT public.neo_role_is_staffed(x.approver_role_id,_branch) THEN
        unstaffed := true; CONTINUE;
      END IF;
      IF q IS NOT NULL AND NOT (x.allow_self_approval AND exception_active)
         AND NOT EXISTS (
           SELECT 1 FROM public.user_roles ur
            WHERE ur.role_id = x.approver_role_id AND ur.organization_id = o AND ur.user_id <> q)
         AND EXISTS (
           SELECT 1 FROM public.user_roles ur
            WHERE ur.role_id = x.approver_role_id AND ur.organization_id = o AND ur.user_id = q) THEN
        self_only := true; CONTINUE;
      END IF;
    END IF;

    RETURN jsonb_build_object(''status'',''ok'',''rule_id'',x.id,''level'',x.level,''approver_role_id'',x.approver_role_id,
      ''approver_user_id'',x.approver_user_id,''required_approvers'',x.required_approvers,
      ''currency'',x.currency,
      ''require_rejection_reason'',x.require_rejection_reason,
      ''require_override_reason'',x.require_override_reason,
      ''message'',''Routed to the configured approver.'');
  END LOOP;

  IF unstaffed OR self_only THEN
    IF pol.id IS NOT NULL THEN
      IF pol.fallback_enabled AND pol.fallback_role_id IS NOT NULL THEN
        SELECT id INTO ops FROM public.roles
         WHERE id = pol.fallback_role_id AND organization_id = o AND coalesce(active,true)
           AND public.neo_role_is_staffed(id,_branch)
         LIMIT 1;
      ELSE
        ops := NULL;
      END IF;
    ELSE
      SELECT id INTO ops FROM public.roles
       WHERE organization_id=o AND coalesce(active,true)
         AND public.neo_resolve_role_template_key(normalized_role_key,name)=''operations-manager''
         AND public.neo_role_is_staffed(id,_branch)
       LIMIT 1;
    END IF;

    IF ops IS NOT NULL THEN
      RETURN jsonb_build_object(''status'',''delegated'',''level'',99,''approver_role_id'',ops,''approver_user_id'',NULL,''required_approvers'',1,
        ''message'',''The configured approver is unavailable or raised this request, so it is routed to the configured fallback approver.'');
    END IF;

    IF self_only THEN
      RETURN jsonb_build_object(''status'',''self_only'',
        ''message'',''You raised this request and you are the only configured approver. It is held for an independent approver.'');
    END IF;

    RETURN jsonb_build_object(''status'',''unstaffed'',
      ''message'',''No configured approver for this amount is currently staffed at this property.'');
  END IF;

  RETURN jsonb_build_object(''status'',''unconfigured'',
    ''message'',''No approval authority is configured for this transaction type and amount.'');
END;
$function$'
FROM pg_proc p WHERE p.oid=to_regprocedure('public.neo_approval_route(text,numeric,numeric,uuid,uuid,uuid)');
INSERT INTO neo_receipt_review_originals
SELECT 'public.neo_approval_execute(uuid)', p.proowner, p.proacl, 'CREATE OR REPLACE FUNCTION public.neo_approval_execute(_request uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''public''
AS $function$
DECLARE r public.approval_requests; _err text; _did boolean := false; _refund uuid;
BEGIN
  SELECT * INTO r FROM public.approval_requests WHERE id = _request FOR UPDATE;
  IF r.id IS NULL THEN RETURN jsonb_build_object(''ok'', false, ''error'', ''not found''); END IF;
  IF r.execution_status = ''succeeded'' THEN
    RETURN jsonb_build_object(''ok'', true, ''idempotent'', true);
  END IF;
  IF r.status NOT IN (''approved_pending_execution'',''execution_failed'',''executing'') THEN
    RETURN jsonb_build_object(''ok'', false, ''error'', ''request is not awaiting execution'');
  END IF;

  UPDATE public.approval_requests SET status = ''executing'', execution_status = ''running'' WHERE id = r.id;

  BEGIN
    UPDATE public.purchase_requests
       SET status = ''approved'', approved_by = r.approver_id, approved_at = now()
     WHERE approval_request_id = r.id AND status <> ''approved'';
    IF FOUND THEN _did := true; END IF;

    IF r.source_module = ''pos'' AND r.source_record_id IS NOT NULL AND r.approval_type = ''void'' THEN
      UPDATE public.pos_orders SET status = ''voided'' WHERE id = r.source_record_id AND status <> ''voided'';
      IF FOUND THEN _did := true; END IF;
    END IF;

    FOR _refund IN
      SELECT id FROM public.refunds
       WHERE approval_request_id = r.id AND status NOT IN (''processed'',''rejected'')
    LOOP
      UPDATE public.refunds
         SET status = ''processed'', approved_by = r.approver_id, processed_at = now(), updated_at = now()
       WHERE id = _refund;
      PERFORM public.neo_finance_post_refund(''folio_refund'', _refund, true);
      _did := true;
    END LOOP;

    IF r.source_module = ''pos'' AND r.approval_type = ''refund'' AND r.source_record_id IS NOT NULL THEN
      IF EXISTS (SELECT 1 FROM public.pos_refund_requests WHERE id = r.source_record_id AND status = ''pending'') THEN
        PERFORM public.neo_pos_refund_decide(r.source_record_id, true, ''Approved via approval request'');
        _did := true;
      END IF;
    END IF;


    -- neo_cash_variance_execution_v1
    IF r.approval_type = ''cash-variance'' THEN
      IF r.approver_id IS NULL
         OR r.approver_id = r.requester_id THEN
        RAISE EXCEPTION
          ''Cash variance requires an independent recorded approver'';
      END IF;

      IF (
        SELECT count(*)
        FROM public.pos_shifts s
        WHERE s.review_approval_request_id = r.id
          AND s.organization_id = r.organization_id
          AND s.branch_id IS NOT DISTINCT FROM r.branch_id
      ) <> 1 THEN
        RAISE EXCEPTION
          ''Cash variance approval must link to exactly one property till'';
      END IF;

      UPDATE public.pos_shifts s
      SET status = ''closed'',
          reviewed_by = r.approver_id,
          reviewed_at = now(),
          updated_at = now()
      WHERE s.review_approval_request_id = r.id
        AND s.organization_id = r.organization_id
        AND s.branch_id IS NOT DISTINCT FROM r.branch_id
        AND s.cashier_id = r.requester_id
        AND s.status = ''variance-review''
        AND abs(s.variance) = r.amount
        AND nullif(btrim(s.variance_reason), '''') IS NOT NULL;

      IF NOT FOUND THEN
        RAISE EXCEPTION
          ''Till is not awaiting this variance decision, or its amount or maker differs'';
      END IF;

      _did := true;
    END IF;

    UPDATE public.approval_requests
       SET status = ''completed'',
           execution_status = CASE WHEN _did THEN ''succeeded'' ELSE ''not_required'' END,
           execution_error = '''', executed_at = now(), completed_at = now()
     WHERE id = r.id;
    RETURN jsonb_build_object(''ok'', true, ''executed'', _did);
  EXCEPTION WHEN OTHERS THEN
    _err := SQLERRM;
    UPDATE public.approval_requests
       SET status = ''execution_failed'', execution_status = ''failed'', execution_error = _err
     WHERE id = r.id;
    INSERT INTO public.approval_execution_failures (organization_id, request_id, source_module,
      source_record_id, error_message)
    VALUES (r.organization_id, r.id, r.source_module, r.source_record_id, _err);
    RETURN jsonb_build_object(''ok'', false, ''error'', _err);
  END;
END $function$'
FROM pg_proc p WHERE p.oid=to_regprocedure('public.neo_approval_execute(uuid)');
INSERT INTO neo_receipt_review_originals
SELECT 'public.pos_confirm_manual_payment(uuid,text)', p.proowner, p.proacl, 'CREATE OR REPLACE FUNCTION public.pos_confirm_manual_payment(_payment_id uuid, _note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''public''
AS $function$
DECLARE _org uuid := public.current_org_id(); _p public.pos_payments; _bal numeric;
BEGIN
  IF NOT public.has_permission(''pos'',''payments'',''manual-confirm'') THEN
    RAISE EXCEPTION ''Not permitted to confirm payments manually'';
  END IF;
  IF coalesce(btrim(_note),'''') = '''' THEN
    RAISE EXCEPTION ''A verification note is required for a manually confirmed payment'';
  END IF;

  SELECT * INTO _p FROM public.pos_payments
   WHERE id = _payment_id AND organization_id = _org FOR UPDATE;
  IF _p.id IS NULL THEN RAISE EXCEPTION ''Payment not found''; END IF;
  IF NOT public.neo_branch_in_scope(_p.branch_id) THEN
    RAISE EXCEPTION ''That payment belongs to a property outside your access'';
  END IF;
  IF _p.status = ''confirmed'' THEN
    RETURN jsonb_build_object(''payment_id'', _p.id, ''status'', ''confirmed'', ''duplicate'', true)
        || public.pos_reconcile_settlement_internal(_p.order_id);
  END IF;
  IF _p.status NOT IN (''initiated'',''pending'') THEN
    RAISE EXCEPTION ''Payment is % and cannot be confirmed'', _p.status;
  END IF;
  IF coalesce(btrim(_p.external_reference),'''') = '''' THEN
    RAISE EXCEPTION ''This attempt has no provider reference, so it cannot be confirmed manually'';
  END IF;

  SELECT round(coalesce(o.grand_total,0)
              - coalesce((SELECT sum(amount) FROM public.pos_payments x
                           WHERE x.order_id = _p.order_id AND x.status=''confirmed''),0), 2)
    INTO _bal FROM public.pos_orders o WHERE o.id = _p.order_id;
  IF _p.amount > _bal + 0.005 THEN
    RAISE EXCEPTION ''Confirming % would exceed the outstanding balance of %'', _p.amount, greatest(_bal,0);
  END IF;

  UPDATE public.pos_payments
     SET status = ''confirmed'', provider_status = ''manual-confirmed'', paid_at = now(),
         verified_by = auth.uid(), verification_note = btrim(_note)
   WHERE id = _payment_id;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_org, _p.branch_id, auth.uid(), ''pos.payment.manual_confirm'', ''pos'', _p.order_id,
          jsonb_build_object(''paymentId'', _p.id, ''amount'', _p.amount, ''method'', _p.method,
                             ''reference'', _p.external_reference, ''note'', btrim(_note)));

  RETURN jsonb_build_object(''payment_id'', _p.id, ''status'', ''confirmed'', ''duplicate'', false)
      || public.pos_reconcile_settlement_internal(_p.order_id);
END $function$'
FROM pg_proc p WHERE p.oid=to_regprocedure('public.pos_confirm_manual_payment(uuid,text)');
INSERT INTO neo_receipt_review_originals
SELECT 'public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid)', p.proowner, p.proacl, 'CREATE OR REPLACE FUNCTION public.pos_record_payment_attempt(_order_id uuid, _amount numeric, _method text, _tendered numeric DEFAULT NULL::numeric, _reference text DEFAULT NULL::text, _shift_id uuid DEFAULT NULL::uuid, _idempotency_key text DEFAULT NULL::text, _manual_confirm boolean DEFAULT false, _note text DEFAULT NULL::text, _account uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''public''
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _o public.pos_orders;
  _existing public.pos_payments;
  _confirmed numeric := 0;
  _active numeric := 0;
  _balance numeric;
  _headroom numeric;
  _status text;
  _provider boolean;
  _needs_reference boolean;
  _change numeric := 0;
  _payment uuid;
  _shift public.pos_shifts;
  _receipt text;
  _settle jsonb;
  _acct uuid;
  _finance jsonb := jsonb_build_object(''ok'', true, ''reason'', ''not_due'');
  _key text := coalesce(nullif(_idempotency_key,''''), ''pos-pay:'' || _order_id::text || '':'' || gen_random_uuid()::text);
BEGIN
  IF NOT public.neo_pos_can_take_payment() THEN
    RAISE EXCEPTION ''Not permitted to take payments'';
  END IF;

  SELECT * INTO _existing FROM public.pos_payments
   WHERE organization_id = _org AND idempotency_key = _key;
  IF _existing.id IS NOT NULL THEN
      IF _existing.order_id IS DISTINCT FROM _order_id THEN RAISE EXCEPTION ''Payment intent belongs to a different order'' USING ERRCODE=''23514''; END IF;
      SELECT * INTO _o FROM public.pos_orders WHERE id=_existing.order_id AND organization_id=_org FOR UPDATE;
      IF _o.id IS NULL OR NOT coalesce(public.neo_branch_in_scope(_o.branch_id),false) THEN RAISE EXCEPTION ''Payment intent belongs to a property outside your access'' USING ERRCODE=''42501''; END IF;
      IF _existing.branch_id IS DISTINCT FROM _o.branch_id THEN RAISE EXCEPTION ''Payment intent has inconsistent property links'' USING ERRCODE=''23514''; END IF;
    RETURN jsonb_build_object(''payment_id'', _existing.id, ''status'', _existing.status, ''duplicate'', true,
                              ''receipt_number'', _existing.receipt_number)
        || public.pos_reconcile_settlement_internal(_existing.order_id);
  END IF;

  SELECT * INTO _o FROM public.pos_orders WHERE id = _order_id AND organization_id = _org FOR UPDATE;
  IF _o.id IS NULL THEN RAISE EXCEPTION ''Order not found''; END IF;
  IF NOT public.neo_branch_in_scope(_o.branch_id) THEN
    RAISE EXCEPTION ''That bill belongs to a property outside your access'';
  END IF;
  IF _o.status IN (''closed'',''cancelled'',''voided'',''charged-to-room'') THEN
    RAISE EXCEPTION ''Bill is % and cannot take further payment'', _o.status;
  END IF;

  _acct := public.neo_assert_financial_account(_org, _o.branch_id, _account);

  IF _method = ''cash'' THEN
    _shift_id := coalesce(_shift_id, public.pos_resolve_open_shift(_o.branch_id));
    IF _shift_id IS NULL THEN
      RAISE EXCEPTION ''No cash drawer is open for this property. Open your till before taking cash.'';
    END IF;
    SELECT * INTO _shift FROM public.pos_shifts WHERE id = _shift_id AND organization_id = _org FOR UPDATE;
    IF _shift.id IS NULL THEN RAISE EXCEPTION ''Cash drawer not found for this property''; END IF;
    IF _shift.status <> ''open'' THEN
      RAISE EXCEPTION ''That cash drawer is % and cannot take cash. Open a till first.'', _shift.status;
    END IF;
  END IF;

  IF _shift_id IS NOT NULL THEN
    SELECT * INTO _shift FROM public.pos_shifts WHERE id=_shift_id AND organization_id=_org FOR UPDATE;
    IF auth.uid() IS NULL OR _shift.id IS NULL OR _shift.status IS DISTINCT FROM ''open'' OR _shift.branch_id IS DISTINCT FROM _o.branch_id OR _shift.cashier_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION ''Use your own open till for this property; route cash to its assigned cashier otherwise'' USING ERRCODE=''42501'';
    END IF;
  END IF;
  SELECT coalesce(sum(amount) FILTER (WHERE status = ''confirmed''), 0),
         coalesce(sum(amount) FILTER (WHERE status IN (''initiated'',''pending'')), 0)
    INTO _confirmed, _active
    FROM public.pos_payments WHERE order_id = _order_id;

  _balance := round(coalesce(_o.grand_total,0) - _confirmed, 2);
  _headroom := round(_balance - _active, 2);

  IF coalesce(_amount,0) <= 0 THEN RAISE EXCEPTION ''Payment amount must be greater than zero''; END IF;
  IF _amount > _headroom + 0.005 THEN
    RAISE EXCEPTION ''Payment of % exceeds the settleable balance of % (outstanding %, awaiting provider %)'',
      _amount, greatest(_headroom,0), greatest(_balance,0), _active;
  END IF;

  _provider := _method IN (''mpesa'',''card-terminal'',''qr'');
  _needs_reference := _method <> ''cash'' AND _method <> ''complimentary'';

  IF _needs_reference AND coalesce(btrim(coalesce(_reference,'''')),'''') = '''' THEN
    RAISE EXCEPTION ''A reference is required for a % payment'', _method;
  END IF;

  IF _manual_confirm THEN
    IF NOT public.has_permission(''pos'',''payments'',''manual-confirm'') THEN
      RAISE EXCEPTION ''Not permitted to confirm payments manually'';
    END IF;
    IF NOT _provider THEN
      RAISE EXCEPTION ''Manual confirmation applies to provider-backed payments only'';
    END IF;
    IF coalesce(btrim(coalesce(_note,'''')),'''') = '''' THEN
      RAISE EXCEPTION ''A verification note is required for a manually confirmed payment'';
    END IF;
    _status := ''confirmed'';
  ELSE
    _status := CASE WHEN _provider THEN ''pending'' ELSE ''confirmed'' END;
  END IF;

  IF _method = ''cash'' AND _tendered IS NOT NULL THEN
    _change := greatest(0, _tendered - _amount);
  END IF;

  IF _status = ''confirmed'' THEN
    _receipt := public.next_document_number(''receipt'');
  END IF;

  INSERT INTO public.pos_payments (
    organization_id, branch_id, order_id, amount, tendered, change_due, currency, method,
    external_reference, receipt_number, status, provider_status, paid_at, cashier_id, shift_id, customer_id,
    created_by, verified_by, verification_note, idempotency_key, destination_account_id
  ) VALUES (
    _org, _o.branch_id, _order_id, round(_amount,2), _tendered, _change, _o.currency, _method,
    nullif(btrim(coalesce(_reference,'''')),''''), _receipt, _status,
    CASE WHEN _manual_confirm THEN ''manual-confirmed''
         WHEN _provider THEN ''awaiting-provider''
         WHEN _method = ''cash'' THEN NULL
         ELSE ''recorded-unverified'' END,
    CASE WHEN _status = ''confirmed'' THEN now() ELSE NULL END,
    auth.uid(), _shift_id, _o.customer_id, auth.uid(),
    CASE WHEN _manual_confirm THEN auth.uid() ELSE NULL END,
    nullif(btrim(coalesce(_note,'''')),''''), _key, _acct
  ) RETURNING id INTO _payment;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_org, _o.branch_id, auth.uid(), ''pos.payment.record'', ''pos'', _order_id,
          jsonb_build_object(''paymentId'', _payment, ''amount'', round(_amount,2), ''method'', _method,
                             ''status'', _status, ''manualConfirm'', _manual_confirm,
                             ''providerBacked'', _provider, ''receiptNumber'', _receipt,
                             ''shiftId'', _shift_id, ''destinationAccountId'', _acct,
                             ''reference'', nullif(btrim(coalesce(_reference,'''')),'''')));

  _settle := public.pos_reconcile_settlement_internal(_order_id);

  IF coalesce((_settle->>''payment_status''), '''') = ''paid'' THEN
    _finance := public.neo_finance_post_source(''pos'', _order_id, true);
  END IF;

  RETURN jsonb_build_object(''payment_id'', _payment, ''status'', _status, ''duplicate'', false,
                            ''provider_backed'', _provider, ''receipt_number'', _receipt,
                            ''shift_id'', _shift_id, ''destination_account_id'', _acct, ''finance'', _finance)
      || _settle;
END $function$'
FROM pg_proc p WHERE p.oid=to_regprocedure('public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid)');
INSERT INTO neo_receipt_review_originals
SELECT 'public.neo_mpesa_apply_result(uuid,integer,text,text,text,jsonb,text)', p.proowner, p.proacl, 'CREATE OR REPLACE FUNCTION public.neo_mpesa_apply_result(_transaction uuid, _result_code integer, _result_desc text, _receipt text, _transaction_date text, _payload jsonb, _source text DEFAULT ''callback''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''public''
AS $function$
DECLARE _t public.mpesa_transactions; _status text; _p public.pos_payments; _pay public.payments; _res public.reservations;
        _completion jsonb := NULL; _normalized_date timestamptz; _date_value public.mpesa_transactions.transaction_date%TYPE; _stored_callback jsonb; _callback_receipt text; _callback_date text;
BEGIN
  SELECT * INTO _t FROM public.mpesa_transactions WHERE id = _transaction FOR UPDATE;
  IF _t.id IS NULL THEN RETURN jsonb_build_object(''applied'', false, ''reason'', ''Transaction not found''); END IF;

  -- A fresh successful provider status query may recover metadata from a callback
  -- that already passed tenant/provider/amount checks but failed atomic posting.
  IF _result_code=0 AND _source=''status-query'' AND nullif(btrim(_receipt),'''') IS NULL THEN
    SELECT e.payload,meta.receipt,meta.clock INTO _stored_callback,_callback_receipt,_callback_date
    FROM public.mpesa_callback_events e
    CROSS JOIN LATERAL (
      SELECT max(x->>''Value'') FILTER(WHERE x->>''Name''=''MpesaReceiptNumber'') AS receipt,
             max(x->>''Value'') FILTER(WHERE x->>''Name''=''TransactionDate'') AS clock,
             max(x->>''Value'') FILTER(WHERE x->>''Name''=''Amount'') AS amount,
             count(*) FILTER(WHERE x->>''Name''=''Amount'') AS amount_count,
             count(*) FILTER(WHERE x->>''Name''=''MpesaReceiptNumber'') AS receipt_count,
             count(*) FILTER(WHERE x->>''Name''=''TransactionDate'') AS clock_count
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload#>''{Body,stkCallback,CallbackMetadata,Item}'')=''array''
        THEN e.payload#>''{Body,stkCallback,CallbackMetadata,Item}'' ELSE ''[]''::jsonb END) x
    ) meta
    WHERE e.organization_id=_t.organization_id AND e.accepted=false AND e.source=''callback''
      AND e.detail LIKE ''Could not apply result:%''
      AND (e.transaction_id=_t.id OR e.checkout_request_id=_t.checkout_request_id)
      AND e.payload#>>''{Body,stkCallback,ResultCode}''=''0''
      AND e.payload#>>''{Body,stkCallback,CheckoutRequestID}''=_t.checkout_request_id
      AND (_t.merchant_request_id IS NULL OR e.payload#>>''{Body,stkCallback,MerchantRequestID}''=_t.merchant_request_id)
      AND CASE WHEN meta.amount ~ ''^[0-9]+([.][0-9]+)?$'' THEN meta.amount::numeric ELSE NULL END=_t.amount
      AND meta.amount_count=1 AND meta.receipt_count=1 AND meta.clock_count=1
      AND nullif(btrim(meta.receipt),'''') IS NOT NULL
    ORDER BY e.received_at DESC LIMIT 1;
    IF _stored_callback IS NOT NULL THEN
      _receipt:=_callback_receipt;
      _transaction_date:=coalesce(nullif(btrim(_transaction_date),''''),_callback_date);
      _payload:=jsonb_build_object(''verification'',_payload,''callback'',_stored_callback);
    END IF;
  END IF;

  -- The existing HTTP RPC accepts a JSON string. Safaricom sends YYYYMMDDHH24MISS
  -- in Kenyan time; normalize it before assigning the timestamptz column.
  IF nullif(btrim(_transaction_date),'''') IS NOT NULL THEN
    IF btrim(_transaction_date) ~ ''^[0-9]{14}$'' THEN
      IF substr(btrim(_transaction_date),1,4)::int<1970
         OR substr(btrim(_transaction_date),9,2)::int>23
         OR substr(btrim(_transaction_date),11,2)::int>59
         OR substr(btrim(_transaction_date),13,2)::int>59 THEN
        RAISE EXCEPTION ''Invalid provider transaction clock'' USING ERRCODE=''22007'';
      END IF;
      _normalized_date:=make_timestamptz(substr(btrim(_transaction_date),1,4)::int,
        substr(btrim(_transaction_date),5,2)::int,substr(btrim(_transaction_date),7,2)::int,
        substr(btrim(_transaction_date),9,2)::int,substr(btrim(_transaction_date),11,2)::int,
        substr(btrim(_transaction_date),13,2)::int,''Africa/Nairobi'');
    ELSIF btrim(_transaction_date) ~ ''^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'' THEN
      _normalized_date:=btrim(_transaction_date)::timestamptz;
    ELSE
      RAISE EXCEPTION ''Invalid provider transaction date format'' USING ERRCODE=''22007'';
    END IF;
  END IF;

  IF _normalized_date IS NOT NULL THEN
    _date_value:=to_char(_normalized_date AT TIME ZONE ''UTC'',''YYYY-MM-DD"T"HH24:MI:SS.US"Z"'');
  END IF;


  INSERT INTO public.mpesa_callback_events (organization_id, transaction_id, checkout_request_id, source, payload, detail)
  VALUES (_t.organization_id, _t.id, _t.checkout_request_id, _source, COALESCE(_payload, ''{}''::jsonb), _result_desc);

  -- A status query can report success without returning the receipt. Preserve
  -- the attempt and its evidence; never invent a receipt or release it for retry.
  IF _result_code=0 AND nullif(btrim(_receipt),'''') IS NULL THEN
    IF _t.status=''success'' AND _t.applied_at IS NOT NULL THEN
      RETURN jsonb_build_object(''applied'',false,''duplicate'',true,''status'',_t.status);
    END IF;
    UPDATE public.mpesa_transactions SET status=''pending'',result_code=0,
      result_desc=''Provider reports success; awaiting its verified receipt metadata'',
      raw_result=coalesce(_payload,raw_result),applied_at=NULL,last_query_at=now(),updated_at=now()
      WHERE id=_t.id;
    RETURN jsonb_build_object(''applied'',false,''status'',''pending'',''reason'',''receipt_pending'',''provider_success'',true);
  END IF;
  IF _result_code=0 THEN
    IF _source NOT IN (''callback'',''status-query'') THEN RAISE EXCEPTION ''M-Pesa success requires the verified provider-result workflow''; END IF;
    IF _t.status=''success'' AND _t.applied_at IS NOT NULL AND nullif(btrim(_t.mpesa_receipt_number),'''') IS DISTINCT FROM nullif(btrim(_receipt),'''') THEN
      RAISE EXCEPTION ''Provider receipt conflicts with the already applied receipt; review the saved evidence'';
    END IF;
    IF _t.amount IS NULL OR _t.amount<=0 OR _t.amount::text IN (''NaN'',''Infinity'',''-Infinity'') THEN RAISE EXCEPTION ''Invalid saved M-Pesa amount''; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(''mpesa-receipt:''||_t.organization_id::text||'':''||upper(btrim(_receipt)),0));
    IF EXISTS(SELECT 1 FROM public.mpesa_transactions other WHERE other.id<>_t.id
       AND other.organization_id=_t.organization_id AND upper(btrim(other.mpesa_receipt_number))=upper(btrim(_receipt))
       AND other.status=''success'' AND other.applied_at IS NOT NULL) THEN
      RAISE EXCEPTION ''This provider receipt is already applied to another saved attempt'';
    END IF;
  END IF;
  -- A late verified successful callback may supersede an earlier non-success.
  -- Success itself is immutable, and a later failure never reverses received money.
  IF _t.applied_at IS NOT NULL AND NOT (_result_code=0 AND _t.status IN (''failed'',''cancelled'',''timeout'')) THEN
    RETURN jsonb_build_object(''applied'', false, ''duplicate'', true, ''status'', _t.status);
  END IF;

  _status := CASE
    WHEN _result_code = 0 THEN ''success''
    WHEN _result_code = 1032 THEN ''cancelled''
    WHEN _result_code IN (1037, 1019) THEN ''timeout''
    ELSE ''failed'' END;

  UPDATE public.mpesa_transactions
     SET status = _status,
         result_code = _result_code,
         result_desc = _result_desc,
         mpesa_receipt_number = COALESCE(NULLIF(btrim(COALESCE(_receipt, '''')), ''''), mpesa_receipt_number),
         transaction_date = COALESCE(_date_value, transaction_date),
         raw_result = COALESCE(_payload, raw_result),
         reconciled_at = now(),
         applied_at = now(),
         failure_detail = CASE WHEN _result_code = 0 THEN NULL ELSE _result_desc END,
         updated_at = now()
   WHERE id = _t.id;

  IF _status <> ''success'' THEN
    IF _t.payment_table = ''pos_payments'' AND _t.payment_id IS NOT NULL THEN
      UPDATE public.pos_payments SET status = ''failed'', provider_status = COALESCE(_result_desc, ''provider-declined'')
       WHERE id = _t.payment_id AND status IN (''initiated'', ''pending'')
       RETURNING order_id INTO _p.order_id;
      IF _p.order_id IS NOT NULL THEN PERFORM public.pos_reconcile_settlement_internal(_p.order_id); END IF;
      PERFORM public.neo_mpesa_delivery_sync(_p.order_id, false);
    ELSIF _t.payment_table = ''payments'' AND _t.payment_id IS NOT NULL THEN
      UPDATE public.payments SET status = ''failed'' WHERE id = _t.payment_id AND status = ''pending'';
    END IF;
    RETURN jsonb_build_object(''applied'', true, ''status'', _status);
  END IF;

  IF _t.payment_table = ''pos_payments'' AND _t.payment_id IS NOT NULL THEN
    SELECT * INTO _p FROM public.pos_payments WHERE id = _t.payment_id FOR UPDATE;
    IF _p.id IS NULL OR _p.organization_id IS DISTINCT FROM _t.organization_id OR _p.branch_id IS DISTINCT FROM _t.branch_id
       OR _p.amount IS DISTINCT FROM _t.amount OR _p.method IS DISTINCT FROM ''mpesa'' OR _p.currency IS DISTINCT FROM ''KES'' THEN
      RAISE EXCEPTION ''Verified M-Pesa attempt and saved POS payment do not agree'';
    END IF;
    IF _p.status IN (''initiated'', ''pending'',''failed'') THEN
      UPDATE public.pos_payments
         SET status = ''confirmed'', provider_status = ''provider-confirmed'', paid_at = now(),
             external_reference = COALESCE(NULLIF(btrim(COALESCE(_receipt, '''')), ''''), external_reference)
       WHERE id = _p.id;
      PERFORM public.pos_reconcile_settlement_internal(_p.order_id);
      PERFORM public.neo_mpesa_delivery_sync(_p.order_id, true);
      _completion := public.neo_mpesa_complete_pos_order(_p.order_id, _t.organization_id);
    END IF;
  ELSIF _t.payment_table = ''payments'' AND _t.payment_id IS NOT NULL THEN
    SELECT * INTO _pay FROM public.payments WHERE id = _t.payment_id FOR UPDATE;
    IF _pay.id IS NULL OR _pay.organization_id IS DISTINCT FROM _t.organization_id OR _pay.branch_id IS DISTINCT FROM _t.branch_id
       OR _pay.amount IS DISTINCT FROM _t.amount OR _pay.method IS DISTINCT FROM ''mpesa'' OR _pay.currency IS DISTINCT FROM ''KES'' THEN
      RAISE EXCEPTION ''Verified M-Pesa attempt and saved folio payment do not agree'';
    END IF;
    IF _pay.status IN (''pending'',''failed'') THEN
      UPDATE public.payments
         SET status = ''confirmed'',
             external_reference = COALESCE(NULLIF(btrim(COALESCE(_receipt, '''')), ''''), external_reference)
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
  ELSIF _t.source_module = ''reservation_deposit'' AND _t.source_record_id IS NOT NULL THEN
    SELECT * INTO _res FROM public.reservations WHERE id = _t.source_record_id;
    IF _res.id IS NOT NULL THEN
      INSERT INTO public.reservation_deposits (
        organization_id, branch_id, reservation_id, customer_id, amount, currency, method,
        reference, status, idempotency_key, notes)
      VALUES (_t.organization_id, COALESCE(_t.branch_id, _res.branch_id), _res.id, _res.customer_id,
              _t.amount, ''KES'', ''mpesa'',
              COALESCE(NULLIF(btrim(COALESCE(_receipt, '''')), ''''), _t.id::text), ''held'',
              ''mpesa-deposit:'' || _t.id::text, ''Guest app booking deposit'')
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_t.organization_id, _t.branch_id, _t.created_by, ''integration.mpesa.confirmed'', ''finance'', _t.id::text,
          jsonb_build_object(''receipt'', _receipt, ''amount'', _t.amount, ''source'', _source,
                             ''sourceModule'', _t.source_module, ''sourceRecord'', _t.source_record_id,
                             ''completion'', _completion));

  RETURN jsonb_build_object(''applied'', true, ''status'', _status, ''completion'', _completion);
END $function$'
FROM pg_proc p WHERE p.oid=to_regprocedure('public.neo_mpesa_apply_result(uuid,integer,text,text,text,jsonb,text)');
DO $check$
DECLARE x record;
BEGIN
  IF (SELECT count(*) FROM neo_receipt_review_originals)<>6 THEN
    RAISE EXCEPTION 'A required installed routine is missing; nothing installed';
  END IF;
  FOR x IN SELECT * FROM neo_receipt_review_originals LOOP
    IF regexp_replace(
      pg_get_functiondef(to_regprocedure(x.signature)),
      '[[:space:]]','','g'
    ) IS DISTINCT FROM regexp_replace(x.expected,'[[:space:]]','','g') THEN
      RAISE EXCEPTION 'Installed code differs for %; nothing installed',x.signature;
    END IF;
  END LOOP;
END $check$;
-- Receipt approval is a financial capability, not a waiter submission capability.
CREATE OR REPLACE FUNCTION public.neo_mpesa_receipt_can_approve(
  _org uuid, _branch uuid
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
  SELECT auth.uid() IS NOT NULL
    AND _org IS NOT DISTINCT FROM public.current_org_id()
    AND public.neo_branch_in_scope(_branch) IS TRUE
    AND (
      coalesce(public.has_permission('finance','collections','verify_bill'),false)
      OR coalesce(public.has_permission('finance','till','confirm_cash'),false)
      OR coalesce(public.has_permission('finance','approve'),false)
      OR coalesce(public.is_org_admin(),false)
    );
$function$;
REVOKE ALL ON FUNCTION public.neo_mpesa_receipt_can_approve(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS receipt_review_payload jsonb;

-- Receipt proposals are immutable after creation. Approval comments/status
-- retain their existing workflow; correcting a proposal requires a new request.
CREATE OR REPLACE FUNCTION public.neo_mpesa_receipt_proposal_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $function$
BEGIN
  IF OLD.approval_type='mpesa-receipt-review'
     OR (TG_OP='UPDATE' AND NEW.approval_type='mpesa-receipt-review') THEN
    IF TG_OP='DELETE' THEN
      RAISE EXCEPTION 'Receipt-review evidence must be retained';
    END IF;
    IF NEW.approval_type IS DISTINCT FROM OLD.approval_type
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
       OR NEW.requester_id IS DISTINCT FROM OLD.requester_id
       OR NEW.source_module IS DISTINCT FROM OLD.source_module
       OR NEW.source_record_id IS DISTINCT FROM OLD.source_record_id
       OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.receipt_review_payload IS DISTINCT FROM OLD.receipt_review_payload
       OR NEW.emergency_override IS TRUE
       OR (
         NEW.self_approved IS TRUE AND (
           NEW.requester_id IS DISTINCT FROM auth.uid()
           OR NEW.approver_id IS DISTINCT FROM auth.uid()
           OR public.neo_mpesa_receipt_can_approve(
             NEW.organization_id,NEW.branch_id
           ) IS NOT TRUE
         )
       ) THEN
      RAISE EXCEPTION 'Receipt-review evidence cannot be changed; self-confirmation requires cashier authority';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_mpesa_receipt_proposal_guard()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS neo_mpesa_receipt_proposal_guard
  ON public.approval_requests;
CREATE TRIGGER neo_mpesa_receipt_proposal_guard
BEFORE UPDATE OR DELETE ON public.approval_requests
FOR EACH ROW EXECUTE FUNCTION public.neo_mpesa_receipt_proposal_guard();

-- This checks saved money evidence. Receipt syntax alone proves nothing.
CREATE OR REPLACE FUNCTION public.neo_mpesa_receipt_available(
  _org uuid, _payment_table text, _payment uuid,
  _receipt text, _transaction uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
BEGIN
  IF nullif(btrim(_receipt),'') IS NULL THEN
    RAISE EXCEPTION 'An actual M-Pesa receipt code is required';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.pos_payments p
    WHERE p.organization_id=_org AND p.method='mpesa'
      AND p.status='confirmed'
      AND upper(btrim(p.external_reference))=upper(btrim(_receipt))
      AND NOT (_payment_table='pos_payments' AND p.id IS NOT DISTINCT FROM _payment)
  ) OR EXISTS (
    SELECT 1 FROM public.payments p
    WHERE p.organization_id=_org AND p.method='mpesa'
      AND p.status IN ('confirmed','posted','completed')
      AND upper(btrim(p.external_reference))=upper(btrim(_receipt))
      AND NOT (_payment_table='payments' AND p.id IS NOT DISTINCT FROM _payment)
  ) OR EXISTS (
    SELECT 1 FROM public.mpesa_transactions t
    WHERE t.organization_id=_org AND t.status='success'
      AND t.applied_at IS NOT NULL
      AND upper(btrim(t.mpesa_receipt_number))=upper(btrim(_receipt))
      AND t.id IS DISTINCT FROM _transaction
  ) OR EXISTS (
    SELECT 1 FROM public.reservation_deposits d
    WHERE d.organization_id=_org AND d.method='mpesa'
      AND d.status IN ('held','applied')
      AND upper(btrim(d.reference))=upper(btrim(_receipt))
      AND NOT (_payment_table='payments' AND d.payment_id IS NOT DISTINCT FROM _payment
               AND _payment IS NOT NULL)
      AND (_transaction IS NULL OR d.idempotency_key IS DISTINCT FROM
           'mpesa-deposit:'||_transaction::text)
  ) THEN
    RAISE EXCEPTION 'This M-Pesa receipt is already recorded against another collection';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_mpesa_receipt_available(uuid,text,uuid,text,uuid)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.neo_mpesa_receipt_review_request(
  _payment uuid, _receipt text, _evidence text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  p public.pos_payments;
  a public.approval_requests;
  route jsonb;
  code text := upper(btrim(coalesce(_receipt,'')));
  evidence text := btrim(coalesce(_evidence,''));
  org uuid := public.current_org_id();
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL OR org IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501';
  END IF;
  IF code !~ '^[A-Z0-9]{8,16}$'
     OR length(evidence)<10 OR length(evidence)>1500 THEN
    RAISE EXCEPTION 'Enter the actual receipt code and a clear description of the independent money evidence';
  END IF;

  -- Serialize with any callback for this same saved payment.
  PERFORM 1 FROM public.mpesa_transactions t
   WHERE t.organization_id=org AND t.payment_table='pos_payments'
     AND t.payment_id=_payment
   ORDER BY t.id FOR UPDATE;

  SELECT * INTO p FROM public.pos_payments
   WHERE id=_payment AND organization_id=org FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF public.neo_branch_in_scope(p.branch_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'Payment is outside your property scope' USING ERRCODE='42501';
  END IF;
  IF NOT (
    coalesce(public.has_permission('pos','payments','process'),false)
    OR coalesce(public.has_permission('pos','payments','manual-confirm'),false)
    OR public.neo_mpesa_receipt_can_approve(org,p.branch_id) IS TRUE
  ) THEN
    RAISE EXCEPTION 'Not permitted to submit receipt evidence' USING ERRCODE='42501';
  END IF;
  IF p.method IS DISTINCT FROM 'mpesa' OR p.currency IS DISTINCT FROM 'KES'
     OR p.amount IS NULL OR p.amount<=0
     OR p.amount::text IN ('NaN','Infinity','-Infinity')
     OR p.amount<>round(p.amount,2) THEN
    RAISE EXCEPTION 'The saved payment is not a valid KES M-Pesa collection';
  END IF;
  IF p.status='confirmed' THEN
    RETURN jsonb_build_object(
      'status','confirmed','payment_id',p.id,'already_confirmed',true
    );
  END IF;
  IF p.status NOT IN ('pending','initiated','failed') THEN
    RAISE EXCEPTION 'Payment cannot enter receipt review from status %',p.status;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'mpesa-receipt:'||org::text||':'||code,0
  ));
  PERFORM public.neo_mpesa_receipt_available(org,'pos_payments',p.id,code,NULL);

  SELECT * INTO a FROM public.approval_requests r
   WHERE r.organization_id=org AND r.approval_type='mpesa-receipt-review'
     AND r.source_record_id=p.id
     AND r.status IN ('pending_approval','approved_pending_execution','executing','execution_failed')
   ORDER BY r.created_at DESC LIMIT 1;
  IF a.id IS NOT NULL THEN
    IF a.receipt_review_payload->>'receipt' IS DISTINCT FROM code THEN
      RAISE EXCEPTION 'This payment already has a different receipt under review';
    END IF;
    RETURN jsonb_build_object(
      'status',a.status,'request_id',a.id,'payment_id',p.id,'reused',true
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.approval_requests r
    WHERE r.organization_id=org AND r.approval_type='mpesa-receipt-review'
      AND r.source_record_id IS DISTINCT FROM p.id
      AND r.receipt_review_payload->>'receipt'=code
      AND r.status IN ('pending_approval','approved_pending_execution','executing','execution_failed')
  ) THEN
    RAISE EXCEPTION 'This receipt is already under review for another payment';
  END IF;

  route:=public.neo_approval_route(
    'mpesa-receipt-review',p.amount,NULL,p.branch_id,NULL,uid
  );
  IF coalesce(route->>'status','') NOT IN ('ok','delegated','owner_reserved') THEN
    RAISE EXCEPTION '%',coalesce(route->>'message','Configure an independent receipt-review approver');
  END IF;

  INSERT INTO public.approval_requests (
    organization_id,branch_id,reference,approval_type,requester_id,
    reason,notes,amount,level,max_level,status,source_module,source_record_id,
    execution_status,self_approved,emergency_override,receipt_review_payload
  ) VALUES (
    org,p.branch_id,public.next_document_number('approval-request'),
    'mpesa-receipt-review',uid,
    format(
      'M-Pesa receipt %s | KES %s | Payment %s | Evidence: %s. Independently check that this money reached the property. A submitted code is not provider confirmation.',
      code,p.amount,p.id,evidence
    ),
    '',p.amount,1,1,'pending_approval','pos',p.id,
    'not_started',false,false,jsonb_build_object(
      'version',1,'payment_id',p.id,'order_id',p.order_id,
      'amount',p.amount,'currency',p.currency,'receipt',code,
      'evidence',evidence,'payment_created_by',p.created_by
    )
  ) RETURNING * INTO a;

  INSERT INTO public.audit_logs (
    organization_id,branch_id,user_id,action,module,record_id,new_value
  ) VALUES (
    org,p.branch_id,uid,'mpesa.receipt_review.requested','finance',p.id::text,
    jsonb_build_object('request_id',a.id,'receipt',code,'amount',p.amount)
  );

  RETURN jsonb_build_object(
    'status','pending_approval','request_id',a.id,'payment_id',p.id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_mpesa_receipt_review_request(uuid,text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_mpesa_receipt_review_request(uuid,text,text)
  TO authenticated;

-- Called privately by the existing approval executor.
CREATE OR REPLACE FUNCTION public.neo_mpesa_receipt_review_execute(_request uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  a public.approval_requests;
  p public.pos_payments;
  o public.pos_orders;
  code text;
  reserved numeric;
  completion jsonb;
  uid uuid := auth.uid();
BEGIN
  SELECT * INTO a FROM public.approval_requests WHERE id=_request FOR UPDATE;
  IF a.id IS NULL OR a.approval_type IS DISTINCT FROM 'mpesa-receipt-review'
     OR a.source_module IS DISTINCT FROM 'pos'
     OR a.organization_id IS DISTINCT FROM public.current_org_id()
     OR a.status NOT IN ('approved_pending_execution','executing','execution_failed')
     OR uid IS NULL OR a.approver_id IS DISTINCT FROM uid

     OR a.emergency_override IS TRUE
     OR public.neo_branch_in_scope(a.branch_id) IS NOT TRUE
     OR nullif(btrim(a.notes),'') IS NULL THEN
    RAISE EXCEPTION 'Receipt review requires an authorized in-scope cashier or supervisor and a written decision';
  END IF;

  IF public.neo_mpesa_receipt_can_approve(
    a.organization_id,a.branch_id
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'The receipt reviewer lacks payment confirmation authority'
      USING ERRCODE='42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.approval_steps s
    WHERE s.request_id=a.id AND s.organization_id=a.organization_id
      AND s.status='approved' AND s.decided_by=uid

  ) THEN
    RAISE EXCEPTION 'Receipt review has no matching independent approval decision';
  END IF;

  -- Match the callback lock order before locking its linked payment.
  PERFORM 1 FROM public.mpesa_transactions t
   WHERE t.organization_id=a.organization_id
     AND t.payment_table='pos_payments' AND t.payment_id=a.source_record_id
   ORDER BY t.id FOR UPDATE;

  SELECT * INTO p FROM public.pos_payments
   WHERE id=a.source_record_id AND organization_id=a.organization_id FOR UPDATE;
  code:=a.receipt_review_payload->>'receipt';

  IF p.id IS NULL OR p.method IS DISTINCT FROM 'mpesa'
     OR p.currency IS DISTINCT FROM 'KES'
     OR p.branch_id IS DISTINCT FROM a.branch_id
     OR p.amount IS DISTINCT FROM a.amount
     OR p.amount IS DISTINCT FROM (a.receipt_review_payload->>'amount')::numeric
     OR p.order_id IS DISTINCT FROM (a.receipt_review_payload->>'order_id')::uuid
     OR p.id IS DISTINCT FROM (a.receipt_review_payload->>'payment_id')::uuid
     OR a.receipt_review_payload->>'currency' IS DISTINCT FROM 'KES'

     OR p.created_by IS DISTINCT FROM
        nullif(a.receipt_review_payload->>'payment_created_by','')::uuid
     OR p.amount IS NULL OR p.amount<=0
     OR p.amount::text IN ('NaN','Infinity','-Infinity')
     OR p.amount<>round(p.amount,2)
     OR code IS NULL OR code !~ '^[A-Z0-9]{8,16}$'
     OR length(coalesce(a.receipt_review_payload->>'evidence',''))<10 THEN
    RAISE EXCEPTION 'Receipt-review evidence differs from the saved payment, or the reviewer created that payment';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'mpesa-receipt:'||a.organization_id::text||':'||code,0
  ));

  IF p.status='confirmed' THEN
    IF upper(btrim(coalesce(p.external_reference,''))) IS DISTINCT FROM code THEN
      RAISE EXCEPTION 'A different receipt already confirmed this payment; reconcile the evidence';
    END IF;
    -- The provider won the race. Do not collect or apply the amount again.
    RETURN;
  END IF;
  IF p.status NOT IN ('pending','initiated','failed') THEN
    RAISE EXCEPTION 'Payment cannot be confirmed from status %',p.status;
  END IF;
  PERFORM public.neo_mpesa_receipt_available(
    a.organization_id,'pos_payments',p.id,code,NULL
  );

  SELECT * INTO o FROM public.pos_orders
   WHERE id=p.order_id AND organization_id=p.organization_id FOR UPDATE;
  IF o.id IS NULL OR o.branch_id IS DISTINCT FROM p.branch_id
     OR o.currency IS DISTINCT FROM p.currency
     OR o.status IN ('closed','cancelled','voided','charged-to-room')
     OR o.grand_total IS NULL
     OR o.grand_total::text IN ('NaN','Infinity','-Infinity') THEN
    RAISE EXCEPTION 'The source bill requires reconciliation before receipt approval';
  END IF;

  SELECT coalesce(sum(x.amount),0) INTO reserved
  FROM public.pos_payments x
  WHERE x.order_id=p.order_id AND x.organization_id=p.organization_id
    AND x.id<>p.id AND x.status IN ('confirmed','pending','initiated');
  IF reserved::text IN ('NaN','Infinity','-Infinity')
     OR p.amount>round(o.grand_total-reserved,2)+0.005 THEN
    RAISE EXCEPTION 'Receipt would exceed this bill after existing and pending collections; reconcile before approval';
  END IF;

  UPDATE public.pos_payments
     SET status='confirmed',external_reference=code,
         provider_status='manager-reviewed',verified_by=uid,
         verification_note=format(
           'Receipt %s independently reviewed under approval %s. %s',
           code,a.id,a.notes
         ),
         receipt_number=coalesce(
           nullif(btrim(receipt_number),''),public.next_document_number('receipt')
         ),
         paid_at=now(),updated_at=now()
   WHERE id=p.id;

  -- Leave the original provider transaction intact for its delayed callback.
  PERFORM public.pos_reconcile_settlement_internal(p.order_id);
  PERFORM public.neo_mpesa_delivery_sync(p.order_id,true);
  completion:=public.neo_mpesa_complete_pos_order(p.order_id,p.organization_id);

  INSERT INTO public.audit_logs (
    organization_id,branch_id,user_id,action,module,record_id,new_value
  ) VALUES (
    p.organization_id,p.branch_id,uid,
    'mpesa.receipt_review.approved','finance',p.id::text,
    jsonb_build_object(
      'request_id',a.id,'receipt',code,'amount',p.amount,
      'submitted_by',a.requester_id,'completion',completion,
      'confirmation_source','cashier-or-supervisor-review'
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_mpesa_receipt_review_execute(uuid)
  FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE FUNCTION public.neo_approval_standard_types()
 RETURNS TABLE(key text, name text)
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT * FROM (VALUES
    ('discount', 'Discount'),
    ('bill-void', 'Bill void request'),
    ('bill-adjustment', 'Bill adjustment'),
    ('complimentary-meal', 'Complimentary meal'),
    ('complimentary-room', 'Complimentary room'),
    ('refund', 'Refund approval'),
    ('payment-reversal', 'Payment reversal'),
    ('write-off', 'Write-off approval'),
    ('cash-variance', 'Cash variance review'),
    ('mpesa-receipt-review', 'M-Pesa receipt review'),
    ('rate-override', 'Rate override'),
    ('price-change', 'Manual price change'),
    ('credit-account', 'Credit account approval'),
    ('purchase-request', 'Purchase requisition'),
    ('purchase-order', 'Purchase order / LPO'),
    ('procurement-variance', 'Procurement variance / exception'),
    ('supplier-invoice', 'Supplier invoice'),
    ('procurement-approval', 'Procurement approval'),
    ('stock-adjustment', 'Stock adjustment'),
    ('stock-write-off', 'Stock write-off'),
    ('expense', 'Expense approval'),
    ('till-reopen', 'Till reopening'),
    ('event-quotation', 'Event quotation'),
    ('event-pricing-exception', 'Event pricing exception')
  ) AS v(key, name);
$function$;
CREATE OR REPLACE FUNCTION public.neo_approval_route(_type text, _amount numeric DEFAULT NULL::numeric, _percent numeric DEFAULT NULL::numeric, _branch uuid DEFAULT NULL::uuid, _department uuid DEFAULT NULL::uuid, _requester uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  o uuid := public.current_org_id();
  q uuid := coalesce(_requester, auth.uid());
  x record; ops uuid; own uuid;
  pol record;
  unstaffed boolean := false;
  self_only boolean := false;
  reserved boolean;
  exception_active boolean;
BEGIN
  IF _type='mpesa-receipt-review' THEN
    IF o IS NULL OR auth.uid() IS NULL THEN
      RETURN jsonb_build_object('status','unconfigured','message','Authentication required');
    END IF;
    RETURN jsonb_build_object(
      'status','ok','level',1,'approver_role_id',NULL,
      'approver_user_id',NULL,'required_approvers',1,
      'message','Cashier or authorized financial supervisor receipt review'
    );
  END IF;
  IF o IS NULL THEN RETURN jsonb_build_object('status','unconfigured','message','No workspace context'); END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.self_approval_exceptions e
    WHERE e.organization_id = o AND e.workflow_key = _type AND e.active
      AND e.effective_from <= current_date
      AND (e.effective_to IS NULL OR e.effective_to >= current_date)
  ) INTO exception_active;

  SELECT * INTO pol FROM public.approval_routing_policies p
   WHERE p.organization_id = o AND p.workflow_key = _type AND p.active
   LIMIT 1;

  IF pol.id IS NOT NULL THEN
    reserved := pol.reserved_role_id IS NOT NULL;
  ELSE
    reserved := lower(coalesce(_type,'')) = ANY(ARRAY['void','cancel','cancellation','discount','refund','complimentary','rate-override','write-off','payment-reversal','till-reopen','period-reopen','mpesa-receipt-review']);
  END IF;

  IF reserved THEN
    IF pol.id IS NOT NULL THEN
      SELECT id INTO own FROM public.roles
       WHERE id = pol.reserved_role_id AND organization_id = o AND coalesce(active,true)
         AND public.neo_role_is_staffed(id,_branch)
       LIMIT 1;
    ELSE
      SELECT id INTO own FROM public.roles
       WHERE organization_id=o AND coalesce(active,true)
         AND public.neo_resolve_role_template_key(normalized_role_key,name)='owner'
         AND public.neo_role_is_staffed(id,_branch)
       LIMIT 1;
    END IF;
    IF own IS NULL THEN
      RETURN jsonb_build_object('status','owner_unstaffed','message','This reserved action has no staffed approver in the configured reserved role.');
    END IF;
    IF NOT exception_active AND q IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.role_id = own AND ur.organization_id = o AND ur.user_id <> q) THEN
      RETURN jsonb_build_object('status','self_only','level',1,'approver_role_id',own,'approver_user_id',NULL,
        'required_approvers',1,
        'message','You raised this reserved request and you are the only holder of the reserved approval role. It is held for an independent approver.');
    END IF;
    RETURN jsonb_build_object('status','owner_reserved','level',1,'approver_role_id',own,'approver_user_id',NULL,'required_approvers',1,'message','Routed to the configured reserved approver under restricted-action policy.');
  END IF;

  FOR x IN
    SELECT * FROM public.approval_rules r
     WHERE r.organization_id=o AND r.active AND r.approval_type=_type
       AND (r.branch_id IS NULL OR r.branch_id=_branch)
       AND (r.department_id IS NULL OR r.department_id=_department)
       AND (r.effective_from IS NULL OR r.effective_from <= current_date)
       AND (r.effective_to IS NULL OR r.effective_to >= current_date)
     ORDER BY (r.branch_id IS NOT NULL) DESC, (r.department_id IS NOT NULL) DESC, r.level
  LOOP
    IF (x.min_amount IS NOT NULL AND _amount IS NOT NULL AND _amount < x.min_amount) THEN
      CONTINUE;
    END IF;

    IF (x.max_amount IS NOT NULL AND _amount IS NOT NULL AND _amount > x.max_amount)
       OR (x.max_percent IS NOT NULL AND _percent IS NOT NULL AND _percent > x.max_percent) THEN
      CONTINUE;
    END IF;

    IF x.approver_user_id = q AND NOT (x.allow_self_approval AND exception_active) THEN
      self_only := true; CONTINUE;
    END IF;

    IF x.approver_user_id IS NULL AND x.approver_role_id IS NOT NULL THEN
      IF NOT public.neo_role_is_staffed(x.approver_role_id,_branch) THEN
        unstaffed := true; CONTINUE;
      END IF;
      IF q IS NOT NULL AND NOT (x.allow_self_approval AND exception_active)
         AND NOT EXISTS (
           SELECT 1 FROM public.user_roles ur
            WHERE ur.role_id = x.approver_role_id AND ur.organization_id = o AND ur.user_id <> q)
         AND EXISTS (
           SELECT 1 FROM public.user_roles ur
            WHERE ur.role_id = x.approver_role_id AND ur.organization_id = o AND ur.user_id = q) THEN
        self_only := true; CONTINUE;
      END IF;
    END IF;

    RETURN jsonb_build_object('status','ok','rule_id',x.id,'level',x.level,'approver_role_id',x.approver_role_id,
      'approver_user_id',x.approver_user_id,'required_approvers',x.required_approvers,
      'currency',x.currency,
      'require_rejection_reason',x.require_rejection_reason,
      'require_override_reason',x.require_override_reason,
      'message','Routed to the configured approver.');
  END LOOP;

  IF unstaffed OR self_only THEN
    IF pol.id IS NOT NULL THEN
      IF pol.fallback_enabled AND pol.fallback_role_id IS NOT NULL THEN
        SELECT id INTO ops FROM public.roles
         WHERE id = pol.fallback_role_id AND organization_id = o AND coalesce(active,true)
           AND public.neo_role_is_staffed(id,_branch)
         LIMIT 1;
      ELSE
        ops := NULL;
      END IF;
    ELSE
      SELECT id INTO ops FROM public.roles
       WHERE organization_id=o AND coalesce(active,true)
         AND public.neo_resolve_role_template_key(normalized_role_key,name)='operations-manager'
         AND public.neo_role_is_staffed(id,_branch)
       LIMIT 1;
    END IF;

    IF ops IS NOT NULL THEN
      RETURN jsonb_build_object('status','delegated','level',99,'approver_role_id',ops,'approver_user_id',NULL,'required_approvers',1,
        'message','The configured approver is unavailable or raised this request, so it is routed to the configured fallback approver.');
    END IF;

    IF self_only THEN
      RETURN jsonb_build_object('status','self_only',
        'message','You raised this request and you are the only configured approver. It is held for an independent approver.');
    END IF;

    RETURN jsonb_build_object('status','unstaffed',
      'message','No configured approver for this amount is currently staffed at this property.');
  END IF;

  RETURN jsonb_build_object('status','unconfigured',
    'message','No approval authority is configured for this transaction type and amount.');
END;
$function$;
CREATE OR REPLACE FUNCTION public.neo_approval_execute(_request uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r public.approval_requests; _err text; _did boolean := false; _refund uuid;
BEGIN
  SELECT * INTO r FROM public.approval_requests WHERE id = _request FOR UPDATE;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not found'); END IF;
  IF r.execution_status = 'succeeded' THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true);
  END IF;
  IF r.status NOT IN ('approved_pending_execution','execution_failed','executing') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'request is not awaiting execution');
  END IF;

  UPDATE public.approval_requests SET status = 'executing', execution_status = 'running' WHERE id = r.id;

  BEGIN
    IF r.approval_type = 'mpesa-receipt-review' THEN
      PERFORM public.neo_mpesa_receipt_review_execute(r.id);
      _did := true;
    END IF;

    UPDATE public.purchase_requests
       SET status = 'approved', approved_by = r.approver_id, approved_at = now()
     WHERE approval_request_id = r.id AND status <> 'approved';
    IF FOUND THEN _did := true; END IF;

    IF r.source_module = 'pos' AND r.source_record_id IS NOT NULL AND r.approval_type = 'void' THEN
      UPDATE public.pos_orders SET status = 'voided' WHERE id = r.source_record_id AND status <> 'voided';
      IF FOUND THEN _did := true; END IF;
    END IF;

    FOR _refund IN
      SELECT id FROM public.refunds
       WHERE approval_request_id = r.id AND status NOT IN ('processed','rejected')
    LOOP
      UPDATE public.refunds
         SET status = 'processed', approved_by = r.approver_id, processed_at = now(), updated_at = now()
       WHERE id = _refund;
      PERFORM public.neo_finance_post_refund('folio_refund', _refund, true);
      _did := true;
    END LOOP;

    IF r.source_module = 'pos' AND r.approval_type = 'refund' AND r.source_record_id IS NOT NULL THEN
      IF EXISTS (SELECT 1 FROM public.pos_refund_requests WHERE id = r.source_record_id AND status = 'pending') THEN
        PERFORM public.neo_pos_refund_decide(r.source_record_id, true, 'Approved via approval request');
        _did := true;
      END IF;
    END IF;


    -- neo_cash_variance_execution_v1
    IF r.approval_type = 'cash-variance' THEN
      IF r.approver_id IS NULL
         OR r.approver_id = r.requester_id THEN
        RAISE EXCEPTION
          'Cash variance requires an independent recorded approver';
      END IF;

      IF (
        SELECT count(*)
        FROM public.pos_shifts s
        WHERE s.review_approval_request_id = r.id
          AND s.organization_id = r.organization_id
          AND s.branch_id IS NOT DISTINCT FROM r.branch_id
      ) <> 1 THEN
        RAISE EXCEPTION
          'Cash variance approval must link to exactly one property till';
      END IF;

      UPDATE public.pos_shifts s
      SET status = 'closed',
          reviewed_by = r.approver_id,
          reviewed_at = now(),
          updated_at = now()
      WHERE s.review_approval_request_id = r.id
        AND s.organization_id = r.organization_id
        AND s.branch_id IS NOT DISTINCT FROM r.branch_id
        AND s.cashier_id = r.requester_id
        AND s.status = 'variance-review'
        AND abs(s.variance) = r.amount
        AND nullif(btrim(s.variance_reason), '') IS NOT NULL;

      IF NOT FOUND THEN
        RAISE EXCEPTION
          'Till is not awaiting this variance decision, or its amount or maker differs';
      END IF;

      _did := true;
    END IF;

    UPDATE public.approval_requests
       SET status = 'completed',
           execution_status = CASE WHEN _did THEN 'succeeded' ELSE 'not_required' END,
           execution_error = '', executed_at = now(), completed_at = now()
     WHERE id = r.id;
    RETURN jsonb_build_object('ok', true, 'executed', _did);
  EXCEPTION WHEN OTHERS THEN
    _err := SQLERRM;
    UPDATE public.approval_requests
       SET status = 'execution_failed', execution_status = 'failed', execution_error = _err
     WHERE id = r.id;
    INSERT INTO public.approval_execution_failures (organization_id, request_id, source_module,
      source_record_id, error_message)
    VALUES (r.organization_id, r.id, r.source_module, r.source_record_id, _err);
    RETURN jsonb_build_object('ok', false, 'error', _err);
  END;
END $function$;
CREATE OR REPLACE FUNCTION public.pos_confirm_manual_payment(_payment_id uuid, _note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid := public.current_org_id(); _p public.pos_payments; _bal numeric;
BEGIN
  IF NOT public.has_permission('pos','payments','manual-confirm') THEN
    RAISE EXCEPTION 'Not permitted to confirm payments manually';
  END IF;
  IF coalesce(btrim(_note),'') = '' THEN
    RAISE EXCEPTION 'A verification note is required for a manually confirmed payment';
  END IF;

  SELECT * INTO _p FROM public.pos_payments
   WHERE id = _payment_id AND organization_id = _org FOR UPDATE;
  IF _p.id IS NULL THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF NOT public.neo_branch_in_scope(_p.branch_id) THEN
    RAISE EXCEPTION 'That payment belongs to a property outside your access';
  END IF;
  IF _p.status = 'confirmed' THEN
    RETURN jsonb_build_object('payment_id', _p.id, 'status', 'confirmed', 'duplicate', true)
        || public.pos_reconcile_settlement_internal(_p.order_id);
  END IF;
  IF _p.method = 'mpesa' THEN
    RAISE EXCEPTION
      'Submit the actual M-Pesa receipt code for independent receipt review. A note alone cannot confirm this payment.'
      USING ERRCODE='42501';
  END IF;
  IF _p.status NOT IN ('initiated','pending') THEN
    RAISE EXCEPTION 'Payment is % and cannot be confirmed', _p.status;
  END IF;
  IF coalesce(btrim(_p.external_reference),'') = '' THEN
    RAISE EXCEPTION 'This attempt has no provider reference, so it cannot be confirmed manually';
  END IF;

  SELECT round(coalesce(o.grand_total,0)
              - coalesce((SELECT sum(amount) FROM public.pos_payments x
                           WHERE x.order_id = _p.order_id AND x.status='confirmed'),0), 2)
    INTO _bal FROM public.pos_orders o WHERE o.id = _p.order_id;
  IF _p.amount > _bal + 0.005 THEN
    RAISE EXCEPTION 'Confirming % would exceed the outstanding balance of %', _p.amount, greatest(_bal,0);
  END IF;

  UPDATE public.pos_payments
     SET status = 'confirmed', provider_status = 'manual-confirmed', paid_at = now(),
         verified_by = auth.uid(), verification_note = btrim(_note)
   WHERE id = _payment_id;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_org, _p.branch_id, auth.uid(), 'pos.payment.manual_confirm', 'pos', _p.order_id,
          jsonb_build_object('paymentId', _p.id, 'amount', _p.amount, 'method', _p.method,
                             'reference', _p.external_reference, 'note', btrim(_note)));

  RETURN jsonb_build_object('payment_id', _p.id, 'status', 'confirmed', 'duplicate', false)
      || public.pos_reconcile_settlement_internal(_p.order_id);
END $function$;
CREATE OR REPLACE FUNCTION public.pos_record_payment_attempt(_order_id uuid, _amount numeric, _method text, _tendered numeric DEFAULT NULL::numeric, _reference text DEFAULT NULL::text, _shift_id uuid DEFAULT NULL::uuid, _idempotency_key text DEFAULT NULL::text, _manual_confirm boolean DEFAULT false, _note text DEFAULT NULL::text, _account uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _o public.pos_orders;
  _existing public.pos_payments;
  _confirmed numeric := 0;
  _active numeric := 0;
  _balance numeric;
  _headroom numeric;
  _status text;
  _provider boolean;
  _needs_reference boolean;
  _change numeric := 0;
  _payment uuid;
  _shift public.pos_shifts;
  _receipt text;
  _settle jsonb;
  _acct uuid;
  _finance jsonb := jsonb_build_object('ok', true, 'reason', 'not_due');
  _key text := coalesce(nullif(_idempotency_key,''), 'pos-pay:' || _order_id::text || ':' || gen_random_uuid()::text);
BEGIN
  IF _method = 'mpesa' AND coalesce(_manual_confirm,false) THEN
    RAISE EXCEPTION
      'M-Pesa receipt confirmation requires independent receipt review.'
      USING ERRCODE='42501';
  END IF;
  IF NOT public.neo_pos_can_take_payment() THEN
    RAISE EXCEPTION 'Not permitted to take payments';
  END IF;

  SELECT * INTO _existing FROM public.pos_payments
   WHERE organization_id = _org AND idempotency_key = _key;
  IF _existing.id IS NOT NULL THEN
      IF _existing.order_id IS DISTINCT FROM _order_id THEN RAISE EXCEPTION 'Payment intent belongs to a different order' USING ERRCODE='23514'; END IF;
      SELECT * INTO _o FROM public.pos_orders WHERE id=_existing.order_id AND organization_id=_org FOR UPDATE;
      IF _o.id IS NULL OR NOT coalesce(public.neo_branch_in_scope(_o.branch_id),false) THEN RAISE EXCEPTION 'Payment intent belongs to a property outside your access' USING ERRCODE='42501'; END IF;
      IF _existing.branch_id IS DISTINCT FROM _o.branch_id THEN RAISE EXCEPTION 'Payment intent has inconsistent property links' USING ERRCODE='23514'; END IF;
    RETURN jsonb_build_object('payment_id', _existing.id, 'status', _existing.status, 'duplicate', true,
                              'receipt_number', _existing.receipt_number)
        || public.pos_reconcile_settlement_internal(_existing.order_id);
  END IF;

  SELECT * INTO _o FROM public.pos_orders WHERE id = _order_id AND organization_id = _org FOR UPDATE;
  IF _o.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF NOT public.neo_branch_in_scope(_o.branch_id) THEN
    RAISE EXCEPTION 'That bill belongs to a property outside your access';
  END IF;
  IF _o.status IN ('closed','cancelled','voided','charged-to-room') THEN
    RAISE EXCEPTION 'Bill is % and cannot take further payment', _o.status;
  END IF;

  _acct := public.neo_assert_financial_account(_org, _o.branch_id, _account);

  IF _method = 'cash' THEN
    _shift_id := coalesce(_shift_id, public.pos_resolve_open_shift(_o.branch_id));
    IF _shift_id IS NULL THEN
      RAISE EXCEPTION 'No cash drawer is open for this property. Open your till before taking cash.';
    END IF;
    SELECT * INTO _shift FROM public.pos_shifts WHERE id = _shift_id AND organization_id = _org FOR UPDATE;
    IF _shift.id IS NULL THEN RAISE EXCEPTION 'Cash drawer not found for this property'; END IF;
    IF _shift.status <> 'open' THEN
      RAISE EXCEPTION 'That cash drawer is % and cannot take cash. Open a till first.', _shift.status;
    END IF;
  END IF;

  IF _shift_id IS NOT NULL THEN
    SELECT * INTO _shift FROM public.pos_shifts WHERE id=_shift_id AND organization_id=_org FOR UPDATE;
    IF auth.uid() IS NULL OR _shift.id IS NULL OR _shift.status IS DISTINCT FROM 'open' OR _shift.branch_id IS DISTINCT FROM _o.branch_id OR _shift.cashier_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Use your own open till for this property; route cash to its assigned cashier otherwise' USING ERRCODE='42501';
    END IF;
  END IF;
  SELECT coalesce(sum(amount) FILTER (WHERE status = 'confirmed'), 0),
         coalesce(sum(amount) FILTER (WHERE status IN ('initiated','pending')), 0)
    INTO _confirmed, _active
    FROM public.pos_payments WHERE order_id = _order_id;

  _balance := round(coalesce(_o.grand_total,0) - _confirmed, 2);
  _headroom := round(_balance - _active, 2);

  IF coalesce(_amount,0) <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;
  IF _amount > _headroom + 0.005 THEN
    RAISE EXCEPTION 'Payment of % exceeds the settleable balance of % (outstanding %, awaiting provider %)',
      _amount, greatest(_headroom,0), greatest(_balance,0), _active;
  END IF;

  _provider := _method IN ('mpesa','card-terminal','qr');
  _needs_reference := _method <> 'cash' AND _method <> 'complimentary';

  IF _needs_reference AND coalesce(btrim(coalesce(_reference,'')),'') = '' THEN
    RAISE EXCEPTION 'A reference is required for a % payment', _method;
  END IF;

  IF _manual_confirm THEN
    IF NOT public.has_permission('pos','payments','manual-confirm') THEN
      RAISE EXCEPTION 'Not permitted to confirm payments manually';
    END IF;
    IF NOT _provider THEN
      RAISE EXCEPTION 'Manual confirmation applies to provider-backed payments only';
    END IF;
    IF coalesce(btrim(coalesce(_note,'')),'') = '' THEN
      RAISE EXCEPTION 'A verification note is required for a manually confirmed payment';
    END IF;
    _status := 'confirmed';
  ELSE
    _status := CASE WHEN _provider THEN 'pending' ELSE 'confirmed' END;
  END IF;

  IF _method = 'cash' AND _tendered IS NOT NULL THEN
    _change := greatest(0, _tendered - _amount);
  END IF;

  IF _status = 'confirmed' THEN
    _receipt := public.next_document_number('receipt');
  END IF;

  INSERT INTO public.pos_payments (
    organization_id, branch_id, order_id, amount, tendered, change_due, currency, method,
    external_reference, receipt_number, status, provider_status, paid_at, cashier_id, shift_id, customer_id,
    created_by, verified_by, verification_note, idempotency_key, destination_account_id
  ) VALUES (
    _org, _o.branch_id, _order_id, round(_amount,2), _tendered, _change, _o.currency, _method,
    nullif(btrim(coalesce(_reference,'')),''), _receipt, _status,
    CASE WHEN _manual_confirm THEN 'manual-confirmed'
         WHEN _provider THEN 'awaiting-provider'
         WHEN _method = 'cash' THEN NULL
         ELSE 'recorded-unverified' END,
    CASE WHEN _status = 'confirmed' THEN now() ELSE NULL END,
    auth.uid(), _shift_id, _o.customer_id, auth.uid(),
    CASE WHEN _manual_confirm THEN auth.uid() ELSE NULL END,
    nullif(btrim(coalesce(_note,'')),''), _key, _acct
  ) RETURNING id INTO _payment;

  INSERT INTO public.audit_logs (organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_org, _o.branch_id, auth.uid(), 'pos.payment.record', 'pos', _order_id,
          jsonb_build_object('paymentId', _payment, 'amount', round(_amount,2), 'method', _method,
                             'status', _status, 'manualConfirm', _manual_confirm,
                             'providerBacked', _provider, 'receiptNumber', _receipt,
                             'shiftId', _shift_id, 'destinationAccountId', _acct,
                             'reference', nullif(btrim(coalesce(_reference,'')),'')));

  _settle := public.pos_reconcile_settlement_internal(_order_id);

  IF coalesce((_settle->>'payment_status'), '') = 'paid' THEN
    _finance := public.neo_finance_post_source('pos', _order_id, true);
  END IF;

  RETURN jsonb_build_object('payment_id', _payment, 'status', _status, 'duplicate', false,
                            'provider_backed', _provider, 'receipt_number', _receipt,
                            'shift_id', _shift_id, 'destination_account_id', _acct, 'finance', _finance)
      || _settle;
END $function$;
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

  -- A status query can report success without returning the receipt. Preserve
  -- the attempt and its evidence; never invent a receipt or release it for retry.
  IF _result_code=0 AND nullif(btrim(_receipt),'') IS NULL THEN
    IF _t.status='success' AND _t.applied_at IS NOT NULL THEN
      RETURN jsonb_build_object('applied',false,'duplicate',true,'status',_t.status);
    END IF;
    UPDATE public.mpesa_transactions SET status='pending',result_code=0,
      result_desc='Provider reports success; awaiting its verified receipt metadata',
      raw_result=coalesce(_payload,raw_result),applied_at=NULL,last_query_at=now(),updated_at=now()
      WHERE id=_t.id;
    RETURN jsonb_build_object('applied',false,'status','pending','reason','receipt_pending','provider_success',true);
  END IF;
  IF _result_code=0 THEN
    IF _source NOT IN ('callback','status-query') THEN RAISE EXCEPTION 'M-Pesa success requires the verified provider-result workflow'; END IF;
    IF _t.status='success' AND _t.applied_at IS NOT NULL AND nullif(btrim(_t.mpesa_receipt_number),'') IS DISTINCT FROM nullif(btrim(_receipt),'') THEN
      RAISE EXCEPTION 'Provider receipt conflicts with the already applied receipt; review the saved evidence';
    END IF;
    IF _t.amount IS NULL OR _t.amount<=0 OR _t.amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Invalid saved M-Pesa amount'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('mpesa-receipt:'||_t.organization_id::text||':'||upper(btrim(_receipt)),0));
    PERFORM public.neo_mpesa_receipt_available(
      _t.organization_id, _t.payment_table, _t.payment_id,
      upper(btrim(_receipt)), _t.id
    );
    IF EXISTS(SELECT 1 FROM public.mpesa_transactions other WHERE other.id<>_t.id
       AND other.organization_id=_t.organization_id AND upper(btrim(other.mpesa_receipt_number))=upper(btrim(_receipt))
       AND other.status='success' AND other.applied_at IS NOT NULL) THEN
      RAISE EXCEPTION 'This provider receipt is already applied to another saved attempt';
    END IF;
  END IF;
  -- A late verified successful callback may supersede an earlier non-success.
  -- Success itself is immutable, and a later failure never reverses received money.
  IF _t.applied_at IS NOT NULL AND NOT (_result_code=0 AND _t.status IN ('failed','cancelled','timeout')) THEN
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
    IF _p.id IS NULL OR _p.organization_id IS DISTINCT FROM _t.organization_id OR _p.branch_id IS DISTINCT FROM _t.branch_id
       OR _p.amount IS DISTINCT FROM _t.amount OR _p.method IS DISTINCT FROM 'mpesa' OR _p.currency IS DISTINCT FROM 'KES' THEN
      RAISE EXCEPTION 'Verified M-Pesa attempt and saved POS payment do not agree';
    END IF;
    IF _p.status = 'confirmed'
       AND _p.provider_status = 'manager-reviewed' THEN
      IF upper(btrim(coalesce(_p.external_reference,'')))
         IS DISTINCT FROM upper(btrim(_receipt)) THEN
        RAISE EXCEPTION
          'Verified provider receipt differs from the manager-reviewed receipt. Preserve both pieces of evidence for reconciliation; do not count either twice.';
      END IF;
      UPDATE public.pos_payments
         SET provider_status='provider-confirmed', updated_at=now()
       WHERE id=_p.id;
    END IF;
    IF _p.status IN ('initiated', 'pending','failed') THEN
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
    IF _pay.id IS NULL OR _pay.organization_id IS DISTINCT FROM _t.organization_id OR _pay.branch_id IS DISTINCT FROM _t.branch_id
       OR _pay.amount IS DISTINCT FROM _t.amount OR _pay.method IS DISTINCT FROM 'mpesa' OR _pay.currency IS DISTINCT FROM 'KES' THEN
      RAISE EXCEPTION 'Verified M-Pesa attempt and saved folio payment do not agree';
    END IF;
    IF _pay.status IN ('pending','failed') THEN
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
END $function$;
-- A receipt-specific decision command. It does not relax self-approval
-- restrictions for expenses, refunds, discounts or other approval workflows.
CREATE OR REPLACE FUNCTION public.neo_mpesa_receipt_review_decide(
  _request uuid, _action text, _note text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  a public.approval_requests;
  s public.approval_steps;
  uid uuid := auth.uid();
  action text := lower(btrim(coalesce(_action,'')));
  note text := btrim(coalesce(_note,''));
  result jsonb;
  lim record;
BEGIN
  SELECT * INTO a FROM public.approval_requests
   WHERE id=_request FOR UPDATE;

  IF a.id IS NULL OR a.approval_type IS DISTINCT FROM 'mpesa-receipt-review'
     OR a.source_module IS DISTINCT FROM 'pos'
     OR public.neo_mpesa_receipt_can_approve(
          a.organization_id,a.branch_id
        ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Cashier or authorized financial supervisor approval required'
      USING ERRCODE='42501';
  END IF;

  IF a.status='completed' AND a.execution_status='succeeded' THEN
    RETURN jsonb_build_object(
      'ok',true,'status','completed','request_id',a.id,
      'payment_id',a.source_record_id,'duplicate',true
    );
  END IF;
  IF a.status NOT IN ('pending_approval','execution_failed') THEN
    RAISE EXCEPTION 'This receipt review is %',a.status;
  END IF;
  IF action NOT IN ('approved','rejected','returned')
     OR length(note)<10 OR length(note)>1500 THEN
    RAISE EXCEPTION 'Choose approve, reject or return and record a clear decision note';
  END IF;

  IF action='approved' AND NOT coalesce(public.is_org_admin(),false) THEN
    SELECT * INTO lim FROM public.neo_my_approval_authority()
     WHERE approval_type='mpesa-receipt-review' LIMIT 1;
    IF FOUND AND NOT coalesce(lim.unlimited,false)
       AND lim.max_amount IS NOT NULL AND a.amount>lim.max_amount THEN
      RAISE EXCEPTION 'This receipt exceeds your configured approval limit; ask an authorized manager';
    END IF;
  END IF;

  SELECT * INTO s FROM public.approval_steps
   WHERE request_id=a.id AND organization_id=a.organization_id
     AND status IN ('active','approved')
   ORDER BY level DESC LIMIT 1 FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'No receipt-review approval step exists'; END IF;

  INSERT INTO public.approval_actions(
    organization_id,request_id,actor_id,action,comment,level
  ) VALUES(a.organization_id,a.id,uid,action,note,s.level);

  UPDATE public.approval_steps
     SET status=action,decided_at=now(),decided_by=uid,
         comment=note,updated_at=now()
   WHERE id=s.id;

  IF action IN ('rejected','returned') THEN
    UPDATE public.approval_requests
       SET status=CASE WHEN action='returned'
                       THEN 'returned_for_correction' ELSE 'rejected' END,
           approver_id=uid,decided_at=now(),notes=note,
           returned_at=CASE WHEN action='returned' THEN now() ELSE returned_at END
     WHERE id=a.id;
    RETURN jsonb_build_object(
      'ok',true,'status',CASE WHEN action='returned'
        THEN 'returned_for_correction' ELSE 'rejected' END,
      'request_id',a.id,'payment_id',a.source_record_id
    );
  END IF;

  UPDATE public.approval_requests
     SET status='approved_pending_execution',approver_id=uid,
         decided_at=now(),notes=note,
         self_approved=(requester_id=uid)
   WHERE id=a.id;

  result:=public.neo_approval_execute(a.id);

  INSERT INTO public.audit_logs(
    organization_id,branch_id,user_id,action,module,record_id,new_value
  ) VALUES(
    a.organization_id,a.branch_id,uid,'mpesa.receipt_review.decision',
    'finance',a.source_record_id::text,
    jsonb_build_object(
      'request_id',a.id,'self_confirmed',a.requester_id=uid,
      'execution',result
    )
  );

  RETURN jsonb_build_object(
    'ok',true,
    'status',CASE WHEN coalesce((result->>'ok')::boolean,false)
      THEN 'completed' ELSE 'execution_failed' END,
    'request_id',a.id,'payment_id',a.source_record_id,'execution',result
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.neo_mpesa_receipt_review_decide(uuid,text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_mpesa_receipt_review_decide(uuid,text,text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_mpesa_receipt_review_queue(
  _branch uuid DEFAULT NULL
)
RETURNS TABLE(
  request_id uuid,payment_id uuid,amount numeric,currency text,
  receipt text,evidence text,status text,requested_at timestamptz,
  requested_by uuid,execution_error text,can_approve boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
BEGIN
  IF auth.uid() IS NULL OR public.current_org_id() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
  SELECT r.id,r.source_record_id,r.amount,
         r.receipt_review_payload->>'currency',
         r.receipt_review_payload->>'receipt',
         r.receipt_review_payload->>'evidence',
         r.status,r.created_at,r.requester_id,r.execution_error,
         public.neo_mpesa_receipt_can_approve(r.organization_id,r.branch_id)
  FROM public.approval_requests r
  WHERE r.organization_id=public.current_org_id()
    AND r.approval_type='mpesa-receipt-review' AND r.source_module='pos'
    AND (_branch IS NULL OR r.branch_id=_branch)
    AND public.neo_branch_in_scope(r.branch_id) IS TRUE
    AND (
      r.requester_id=auth.uid()
      OR public.neo_mpesa_receipt_can_approve(r.organization_id,r.branch_id) IS TRUE
    )
  ORDER BY r.created_at DESC,r.id
  LIMIT 200;
END;
$function$;
REVOKE ALL ON FUNCTION public.neo_mpesa_receipt_review_queue(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_mpesa_receipt_review_queue(uuid)
  TO authenticated;
DO $check$
DECLARE x record;
BEGIN
  FOR x IN SELECT * FROM neo_receipt_review_originals LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      WHERE p.oid=to_regprocedure(x.signature)
        AND p.proowner=x.owner_oid
        AND p.proacl IS NOT DISTINCT FROM x.acl
    ) THEN
      RAISE EXCEPTION 'Owner or permissions changed for %; rolled back',x.signature;
    END IF;
  END LOOP;
END $check$;

SELECT jsonb_build_object(
  'diagnostic_version','mpesa-cashier-receipt-review-v2',
  'existing_permissions_unchanged',true,
  'scope','Installs future POS receipt submission and cashier/supervisor approval, immutable proposal evidence and delayed-callback receipt matching. Installation confirms no payment, decides no approval and changes no historical amount.'
);
COMMIT;
