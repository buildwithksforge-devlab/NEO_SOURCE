CREATE OR REPLACE FUNCTION public.neo_deposit_post(_deposit uuid, _silent boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE d public.reservation_deposits; org uuid; cur text; cash_code text; cash_name text;
        occurred date; ref text; res jsonb; jid uuid; msg text;
BEGIN
  SELECT * INTO d FROM public.reservation_deposits WHERE id = _deposit;
  IF d.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  org := d.organization_id;

  IF NOT _silent AND NOT (public.is_org_admin() OR public.has_permission('finance','edit')
                          OR public.has_permission('finance','approve')) THEN
    RAISE EXCEPTION 'insufficient_privilege' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('deposit:' || _deposit::text, 0));

  IF EXISTS (SELECT 1 FROM public.finance_posting_receipts
              WHERE organization_id = org AND idempotency_key = 'deposit:' || _deposit::text
                AND status = 'posted') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_posted');
  END IF;

  cur := COALESCE(NULLIF(d.currency,''), public.neo_fact_currency(org, d.branch_id));
  occurred := COALESCE((d.received_at)::date, (d.created_at)::date, CURRENT_DATE);
  SELECT COALESCE(r.confirmation_number, d.reservation_id::text) INTO ref
    FROM public.reservations r WHERE r.id = d.reservation_id;
  ref := COALESCE(ref, _deposit::text);

  SELECT c.code, c.name INTO cash_code, cash_name FROM (VALUES
      ('mpesa','1030','M-Pesa Clearing'),
      ('mobile','1030','M-Pesa Clearing'),
      ('card','1040','Card Clearing'),
      ('bank','1020','Bank Accounts'),
      ('transfer','1020','Bank Accounts'),
      ('eft','1020','Bank Accounts'),
      ('cash','1000','Cash on Hand')
    ) AS c(method, code, name)
   WHERE c.method = lower(COALESCE(d.method,'cash'));
  cash_code := COALESCE(cash_code, '1000');
  cash_name := COALESCE(cash_name, 'Cash on Hand');

  BEGIN
    PERFORM public.neo_finance_ensure_account(org, cash_code, cash_name, 'asset', 'Cash and Bank');
    PERFORM public.neo_finance_ensure_account(org, '2020', 'Guest Deposits', 'liability', 'Liabilities');

    res := public.neo_gl_post(
      org, d.branch_id, 'pms', 'reservation_deposit', _deposit, 'deposit',
      occurred, cur,
      'Pre-arrival deposit ' || ref,
      jsonb_build_array(
        jsonb_build_object('code', cash_code, 'debit', round(COALESCE(d.amount,0),2),
                           'description', 'Deposit received (' || COALESCE(d.method,'cash') || ')'),
        jsonb_build_object('code', '2020', 'credit', round(COALESCE(d.amount,0),2),
                           'description', 'Guest deposit held')
      ), d.customer_id);
    jid := NULLIF(res->>'journal_id','')::uuid;
  EXCEPTION WHEN OTHERS THEN
    msg := SQLERRM;
    PERFORM public.neo_record_posting_receipt(org, d.branch_id, 'deposit', _deposit, ref, 'failed',
      COALESCE(d.amount,0), cur, NULL, NULL, msg, occurred);
    PERFORM public.neo_financial_state_set(org, d.branch_id, 'deposit', _deposit, ref,
      d.status, 'failed', 'The deposit could not be recognised in Finance.',
      COALESCE(d.amount,0), cur, occurred, NULL, NULL, msg, auth.uid(), NULL);
    IF _silent THEN RETURN jsonb_build_object('ok', false, 'reason', 'failed', 'detail', msg); END IF;
    RAISE;
  END;

  PERFORM public.neo_record_posting_receipt(org, d.branch_id, 'deposit', _deposit, ref,
    CASE WHEN jid IS NOT NULL THEN 'posted' ELSE 'blocked' END,
    COALESCE(d.amount,0), cur, NULL, res->>'detail', NULL, occurred);

  PERFORM public.neo_financial_state_set(org, d.branch_id, 'deposit', _deposit, ref,
    d.status, CASE WHEN jid IS NOT NULL THEN 'posted' ELSE 'blocked' END,
    'A pre-arrival deposit is held as a liability until it is applied to the guest folio.',
    COALESCE(d.amount,0), cur, occurred, jid, NULL, NULL, auth.uid(), NULL);

  RETURN COALESCE(res, '{}'::jsonb) || jsonb_build_object('module', 'deposit', 'source_id', _deposit);
END $function$;