-- NEÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¹ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ F02: coordinate event collection posting.
-- DEF-MVIFBIVM
--
-- Preserve all historical payments, receipts and journals.
-- Prevent competing automatic triggers from posting
-- collections already handled by event billing.

-- General guest-payment autoposting must exclude Events.
DROP TRIGGER IF EXISTS payments_autopost_txn
ON public.payments;

CREATE TRIGGER payments_autopost_txn
AFTER INSERT OR UPDATE
ON public.payments
FOR EACH ROW
WHEN (NEW.source_module IS DISTINCT FROM 'events')
EXECUTE FUNCTION public.neo_autopost_txn();

-- Prevent the legacy event-payment trigger from creating
-- another journal for the same billing-originated collection.
DROP TRIGGER IF EXISTS tg_neo_event_payment_autopost
ON public.event_payments;

-- Retain the event-booking trigger for completion and cancellation.
-- Its deposit-posting branch still requires correction.
-- Event deposit balances are summaries of actual event payments.
-- They must not independently produce another cash collection.
--
-- Preserve legitimate completion and cancellation posting.

CREATE OR REPLACE FUNCTION public.neo_event_booking_lifecycle_autopost()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
    IF NEW.status IN ('completed','closed')
       AND NEW.status IS DISTINCT FROM OLD.status THEN
        PERFORM public.neo_finance_post_txn('event_earned', NEW.id, true);
    END IF;

    IF NEW.status = 'cancelled'
       AND NEW.status IS DISTINCT FROM OLD.status THEN
        PERFORM public.neo_finance_post_txn('event_cancellation', NEW.id, true);
    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS event_bookings_autopost_txn
ON public.event_bookings;

CREATE TRIGGER event_bookings_autopost_txn
AFTER UPDATE
ON public.event_bookings
FOR EACH ROW
EXECUTE FUNCTION public.neo_event_booking_lifecycle_autopost();
-- F02 EVENT BILLING ACCOUNTING REPLACEMENT
CREATE OR REPLACE FUNCTION public.neo_event_billing_record_payment(
  _booking uuid, _amount numeric, _entry_type text DEFAULT 'payment'::text,
  _method text DEFAULT 'cash'::text, _reference text DEFAULT NULL::text,
  _reason text DEFAULT NULL::text, _account uuid DEFAULT NULL::uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  org uuid := public.current_org_id();
  b public.event_bookings;
  signed numeric;
  paid numeric := 0; charged numeric := 0; deposits numeric := 0;
  new_id uuid;
  s public.pos_shifts;
  receipt text; pay uuid;
  method text := coalesce(_method,'cash');
  acct uuid;
  v_settlement uuid; v_ar uuid; v_journal uuid; v_jnum text; v_abs numeric;
BEGIN
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
  signed := CASE WHEN _entry_type IN ('refund','credit') THEN -abs(_amount) ELSE _amount END;

  IF _entry_type IN ('deposit','payment') THEN
    IF method = 'cash' THEN
      SELECT * INTO s FROM public.pos_shifts
       WHERE organization_id = org AND status = 'open'
         AND (cashier_id = auth.uid() OR opened_by = auth.uid())
         AND (branch_id = b.branch_id OR branch_id IS NULL)
       ORDER BY opened_at DESC LIMIT 1;
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
      public.neo_fact_currency(org, b.branch_id), method, nullif(_reference,''), 'confirmed',
      auth.uid(), coalesce(nullif(_reason,''), 'Event ' || coalesce(b.event_reference,'')),
      s.id, s.station_id, 'events', b.id,
      'event-payment:' || b.id::text || ':' || _entry_type || ':' || method || ':' || abs(signed)::text
        || ':' || coalesce(nullif(_reference,''), to_char(now(), 'YYYYMMDDHH24MISSMS')), acct)
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

    IF v_settlement IS NOT NULL AND v_ar IS NOT NULL THEN
      v_jnum := public.next_document_number('journal');
      INSERT INTO public.journal_entries (organization_id, branch_id, journal_number, journal_type,
        accounting_date, source_module, source_document_type, source_document_id, document_number,
        idempotency_key, description, currency, created_by, status)
      VALUES (org, b.branch_id, v_jnum, 'automatic', CURRENT_DATE, 'events', 'event_payment',
        new_id, coalesce(receipt, v_jnum), 'event-payment-journal:' || new_id::text,
        initcap(_entry_type) || ' on event ' || coalesce(b.event_reference, '')
          || coalesce(' ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ' || nullif(btrim(coalesce(_reason,'')), ''), ''),
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

      PERFORM set_config('neo.system_posting', 'on', true);
      PERFORM public.fin_post_journal(v_journal);
      PERFORM set_config('neo.system_posting', 'off', true);

      IF pay IS NOT NULL THEN
        UPDATE public.payments SET posted_journal_id = v_journal, updated_at = now()
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

  RETURN jsonb_build_object('ok', true, 'payment_id', new_id, 'paid', paid,
                            'charged', charged, 'outstanding', charged - paid,
                            'receipt_number', receipt, 'shift_id', s.id,
                            'destination_account_id', acct,
                            'journal_id', v_journal, 'journal_number', v_jnum);
END $function$;

GRANT EXECUTE ON FUNCTION public.neo_event_billing_record_payment(uuid, numeric, text, text, text, text, uuid) TO authenticated, service_role;
