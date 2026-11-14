BEGIN;
DO $guard$ BEGIN IF to_regprocedure('public.neo_event_billing_record_payment(uuid,numeric,text,text,text,text,uuid,text)') IS NOT NULL THEN RAISE EXCEPTION 'Event payment repair already exists; use postcheck'; END IF; IF md5(pg_get_functiondef(to_regprocedure('public.neo_event_billing_record_payment(uuid,numeric,text,text,text,text,uuid)'))) IS DISTINCT FROM '89567465023aa30187069d92fcdc006b' THEN RAISE EXCEPTION 'Installed Events payment changed; inspect before replacing'; END IF; END $guard$;
CREATE OR REPLACE FUNCTION public.neo_event_billing_record_payment(_booking uuid, _amount numeric, _entry_type text, _method text, _reference text, _reason text, _account uuid, _intent_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  prior_context text; existing public.payments; ep public.event_payments; key text;
  org uuid := public.current_org_id();
  b public.event_bookings;
  signed numeric;
  paid numeric := 0; charged numeric := 0; deposits numeric := 0;
  new_id uuid;
  s public.pos_shifts;
  receipt text; pay uuid;
  method text := lower(coalesce(nullif(btrim(_method),''),'cash'));
  acct uuid;
  v_settlement uuid; v_ar uuid; v_journal uuid; v_jnum text; v_abs numeric;
BEGIN
  IF auth.uid() IS NULL OR public.current_access_scope() IS NULL OR public.current_access_scope()='technical' THEN RAISE EXCEPTION 'An authorised staff workspace is required' USING ERRCODE='42501'; END IF;
  IF nullif(btrim(coalesce(_intent_key,'')),'') IS NULL OR length(_intent_key)>200 THEN RAISE EXCEPTION 'A payment attempt identity is required'; END IF;
  IF _amount IS NULL OR _amount::text IN ('NaN','Infinity','-Infinity') OR _amount<=0 OR round(_amount,2)<>_amount THEN RAISE EXCEPTION 'Enter a finite positive payment amount in cents'; END IF;
  IF org IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_organisation'); END IF;
  IF NOT public.has_permission('events','billing','create') THEN
    RAISE EXCEPTION 'The events.billing.create permission is required.' USING ERRCODE = '42501';
  END IF;
  IF _entry_type NOT IN ('deposit','payment','refund','credit','adjustment') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_entry_type');
  END IF;
  IF _entry_type IN ('credit','adjustment','refund') THEN RETURN jsonb_build_object('ok', false, 'reason', 'controlled_adjustment_required'); END IF;
  IF coalesce(_amount,0) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'zero_amount');
  END IF;
  IF _entry_type IN ('refund','credit','adjustment') AND coalesce(trim(_reason),'') = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reason_required',
      'detail', 'Refunds, credits and adjustments require a written reason.');
  END IF;

  SELECT * INTO b FROM public.event_bookings
   WHERE id = _booking AND organization_id = org FOR UPDATE;
  IF b.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF NOT public.neo_branch_in_scope(b.branch_id) THEN
    RAISE EXCEPTION 'That property is outside your access scope.' USING ERRCODE = '42501';
  END IF;
  IF b.billing_status = 'not_billed' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_billed',
      'detail', 'Build the bill before recording money against this event.');
  END IF;

  acct := public.neo_assert_financial_account(org, b.branch_id, _account);
  IF b.branch_id IS NULL OR b.status IN ('cancelled','voided') THEN RAISE EXCEPTION 'This event cannot accept a payment'; END IF;
  IF method<>'cash' AND nullif(btrim(coalesce(_reference,'')),'') IS NULL THEN RAISE EXCEPTION 'A payment confirmation reference is required'; END IF;
  key:='event-payment-v2:'||_intent_key;
  PERFORM pg_advisory_xact_lock(hashtextextended('event-attempt:'||org::text||':'||_intent_key,0));
  SELECT * INTO existing FROM public.payments WHERE organization_id=org AND idempotency_key=key FOR UPDATE;
  IF existing.id IS NOT NULL THEN
    SELECT * INTO ep FROM public.event_payments WHERE payment_id=existing.id AND organization_id=org AND booking_id=b.id;
    IF ep.id IS NULL OR ep.entry_type IS DISTINCT FROM _entry_type OR existing.source_module IS DISTINCT FROM 'events' OR existing.source_record_id IS DISTINCT FROM b.id OR existing.amount IS DISTINCT FROM _amount OR existing.method IS DISTINCT FROM method OR existing.external_reference IS DISTINCT FROM nullif(btrim(coalesce(_reference,'')),'') OR existing.destination_account_id IS DISTINCT FROM acct OR existing.status IS DISTINCT FROM 'confirmed' THEN RAISE EXCEPTION 'Payment attempt details have changed; review the saved receipt'; END IF;
    IF NOT public.neo_connection_journal_matches(existing.posted_journal_id,org,b.branch_id,existing.currency,_amount,'event_payment',ep.id) THEN RAISE EXCEPTION 'The saved payment journal needs reconciliation'; END IF;
    RETURN jsonb_build_object('ok',true,'already_recorded',true,'payment_id',ep.id,'receipt_id',existing.id,'receipt_number',existing.receipt_number,'journal_id',existing.posted_journal_id);
  END IF;
  IF method<>'cash' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('neo:'||method||':'||org::text||':'||upper(btrim(_reference)),0));
    IF EXISTS(SELECT 1 FROM public.payments p WHERE p.organization_id=org AND p.status NOT IN ('cancelled','failed') AND upper(btrim(coalesce(p.external_reference,'')))=upper(btrim(_reference))) OR EXISTS(SELECT 1 FROM public.pos_payments p WHERE p.organization_id=org AND p.status NOT IN ('cancelled','failed') AND upper(btrim(coalesce(p.external_reference,'')))=upper(btrim(_reference))) THEN RAISE EXCEPTION 'Payment confirmation reference is already linked to a saved receipt'; END IF;
  END IF;
  SELECT coalesce(sum(amount),0) INTO paid FROM public.event_payments WHERE booking_id=b.id AND organization_id=org;
  SELECT coalesce(sum(CASE WHEN is_complimentary THEN 0 ELSE line_total END),0) INTO charged FROM public.event_billing_items WHERE booking_id=b.id AND organization_id=org;
  IF paid::text IN ('NaN','Infinity','-Infinity') OR charged::text IN ('NaN','Infinity','-Infinity') OR charged-paid<_amount THEN RAISE EXCEPTION 'Payment exceeds the verified outstanding event bill'; END IF;
  signed := CASE WHEN _entry_type IN ('refund','credit') THEN -abs(_amount) ELSE _amount END;

  IF _entry_type IN ('deposit','payment') THEN
    IF method = 'cash' THEN
      SELECT * INTO s FROM public.pos_shifts
       WHERE organization_id = org AND status = 'open'
         AND cashier_id = auth.uid()
         AND branch_id = b.branch_id
       ORDER BY opened_at DESC LIMIT 1 FOR UPDATE;
      IF s.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'no_open_till',
          'detail', 'Open your till before taking cash for an event, so the shift reconciles.');
      END IF;
    END IF;

    receipt := public.next_document_number('receipt');
    INSERT INTO public.payments (organization_id, branch_id, receipt_number, customer_id, amount,
      currency, method, external_reference, status, received_by, notes, shift_id, station_id,
      source_module, source_record_id, idempotency_key, destination_account_id)
    VALUES (org, b.branch_id, receipt, b.customer_id, abs(signed),
      public.neo_fact_currency(org, b.branch_id), method, nullif(btrim(_reference),''), 'draft',
      auth.uid(), coalesce(nullif(_reason,''), 'Event ' || coalesce(b.event_reference,'')),
      s.id, s.station_id, 'events', b.id,
      key, acct)
    RETURNING id INTO pay;
  END IF;

  INSERT INTO public.event_payments
    (organization_id, branch_id, booking_id, entry_type, method, amount, currency,
     reference, reason, recorded_by, payment_id, shift_id, receipt_number, destination_account_id)
  VALUES (b.organization_id, b.branch_id, b.id, _entry_type, method, signed,
          public.neo_fact_currency(org, b.branch_id), nullif(_reference,''), nullif(_reason,''),
          auth.uid(), pay, s.id, receipt, acct)
  RETURNING id INTO new_id;

  IF _entry_type IN ('deposit','payment') THEN
    v_abs := abs(signed);

    SELECT a.id INTO v_settlement FROM public.chart_of_accounts a
     WHERE a.organization_id = org AND a.active AND coalesce(a.postable, true)
       AND a.code = public.neo_gl_account_code(org, method, acct)
     LIMIT 1;

    SELECT a.id INTO v_ar FROM public.chart_of_accounts a
     WHERE a.organization_id = org AND a.active AND coalesce(a.postable, true)
       AND a.code = CASE
          WHEN _entry_type = 'deposit' THEN '2030'
          ELSE '1060'
        END
     ORDER BY a.code LIMIT 1;

    IF v_settlement IS NULL OR v_ar IS NULL THEN RAISE EXCEPTION 'Configure the event settlement and liability accounts before collecting'; END IF;
    IF v_settlement IS NOT NULL AND v_ar IS NOT NULL THEN
      v_jnum := public.next_document_number('journal');
      INSERT INTO public.journal_entries (organization_id, branch_id, journal_number, journal_type,
        accounting_date, source_module, source_document_type, source_document_id, document_number,
        idempotency_key, description, currency, created_by, status)
      VALUES (org, b.branch_id, v_jnum, 'automatic', CURRENT_DATE, 'events', 'event_payment',
        new_id, coalesce(receipt, v_jnum), 'event-payment-journal:' || new_id::text,
        initcap(_entry_type) || ' on event ' || coalesce(b.event_reference, '')
          || coalesce(' - ' || nullif(btrim(coalesce(_reason,'')), ''), ''),
        public.neo_fact_currency(org, b.branch_id), auth.uid(), 'draft')
      RETURNING id INTO v_journal;

      INSERT INTO public.journal_entry_lines (organization_id, journal_id, line_number, account_id,
        description, debit, credit, branch_id, customer_id, revenue_centre, payment_method)
      VALUES (org, v_journal, 1,
        CASE WHEN signed > 0 THEN v_settlement ELSE v_ar END,
        initcap(_entry_type) || ' ' || coalesce(receipt, v_jnum),
        v_abs, 0, b.branch_id, b.customer_id, 'events', method);

      INSERT INTO public.journal_entry_lines (organization_id, journal_id, line_number, account_id,
        description, debit, credit, branch_id, customer_id, revenue_centre, payment_method)
      VALUES (org, v_journal, 2,
        CASE WHEN signed > 0 THEN v_ar ELSE v_settlement END,
        'Event ' || coalesce(b.event_reference, ''),
        0, v_abs, b.branch_id, b.customer_id, 'events', method);

      prior_context:=current_setting('neo.system_posting',true);
      PERFORM set_config('neo.system_posting', 'on', true);
      PERFORM public.fin_post_journal(v_journal);
      PERFORM set_config('neo.system_posting', coalesce(prior_context,''), true);
      IF NOT public.neo_connection_journal_matches(v_journal,org,b.branch_id,public.neo_fact_currency(org,b.branch_id),_amount,'event_payment',new_id) THEN RAISE EXCEPTION 'Event receipt journal did not post'; END IF;

      IF pay IS NOT NULL THEN
        UPDATE public.payments SET posted_journal_id = v_journal, status='confirmed', updated_at = now()
         WHERE id = pay;
      END IF;
    END IF;
  END IF;

  SELECT coalesce(sum(amount),0) INTO paid FROM public.event_payments WHERE booking_id = b.id;
  SELECT coalesce(sum(amount),0) INTO deposits
    FROM public.event_payments WHERE booking_id = b.id AND entry_type = 'deposit';
  SELECT coalesce(sum(CASE WHEN is_complimentary THEN 0 ELSE line_total END),0) INTO charged
    FROM public.event_billing_items WHERE booking_id = b.id;

  UPDATE public.event_bookings
     SET paid_amount = paid,
         deposit_paid = deposits,
         payment_status = CASE
           WHEN paid <= 0 THEN 'unpaid'
           WHEN paid >= charged AND charged > 0 THEN 'paid'
           ELSE 'partial' END,
         updated_at = now()
   WHERE id = b.id;

  INSERT INTO public.event_activity_logs (organization_id, booking_id, action, detail, actor_id)
  VALUES (b.organization_id, b.id, 'events.billing.' || _entry_type,
          jsonb_build_object('amount', signed, 'method', method,
                             'reference', nullif(_reference,''), 'reason', nullif(_reason,''),
                             'receipt_number', receipt, 'shift_id', s.id,
                             'destination_account_id', acct,
                             'journal_number', v_jnum), auth.uid());

  RETURN jsonb_build_object('ok', true, 'payment_id', new_id, 'receipt_id', pay, 'paid', paid,
                            'charged', charged, 'outstanding', charged - paid,
                            'receipt_number', receipt, 'shift_id', s.id,
                            'destination_account_id', acct,
                            'journal_id', v_journal, 'journal_number', v_jnum);
END $function$
;

CREATE OR REPLACE FUNCTION public.neo_event_billing_record_payment(_booking uuid,_amount numeric,_entry_type text DEFAULT 'payment',_method text DEFAULT 'cash',_reference text DEFAULT NULL,_reason text DEFAULT NULL,_account uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
 RETURN public.neo_event_billing_record_payment(_booking,_amount,_entry_type,_method,_reference,_reason,_account,'legacy:'||CASE WHEN nullif(btrim(coalesce(_reference,'')),'') IS NULL THEN gen_random_uuid()::text ELSE md5(_booking::text||':'||coalesce(_entry_type,'')||':'||coalesce(_method,'')||':'||upper(btrim(_reference))) END);
END $function$;

REVOKE ALL ON FUNCTION public.neo_event_billing_record_payment(uuid,numeric,text,text,text,text,uuid) FROM PUBLIC,anon,service_role; GRANT EXECUTE ON FUNCTION public.neo_event_billing_record_payment(uuid,numeric,text,text,text,text,uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.neo_event_billing_record_payment(uuid,numeric,text,text,text,text,uuid,text) FROM PUBLIC,anon,service_role; GRANT EXECUTE ON FUNCTION public.neo_event_billing_record_payment(uuid,numeric,text,text,text,text,uuid,text) TO authenticated;
NOTIFY pgrst,'reload schema';
WITH expected(signature,hash) AS(VALUES ('public.neo_event_billing_record_payment(uuid,numeric,text,text,text,text,uuid)','06948a5ad146b15b5ce9c2b7eaed46c5'),('public.neo_event_billing_record_payment(uuid,numeric,text,text,text,text,uuid,text)','38bc729c4bd2e8c70e38cc0c88d49121')),checked AS(SELECT signature,coalesce(md5(pg_get_functiondef(to_regprocedure(signature)))=hash,false) matches FROM expected) SELECT jsonb_build_object('diagnostic_version','event-payment-attempt-connection-v1','definitions_match',(SELECT bool_and(matches) FROM checked),'definition_checks',(SELECT jsonb_agg(to_jsonb(checked)) FROM checked),'scope','Two guarded Events payment commands only. Installation does not collect money, create receipts or journals, alter event balances or rewrite history.') result;
COMMIT;
