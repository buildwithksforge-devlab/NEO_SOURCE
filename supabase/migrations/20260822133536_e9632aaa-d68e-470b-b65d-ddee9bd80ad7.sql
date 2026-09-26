ALTER TABLE public.perm_diagnostics
  ADD COLUMN IF NOT EXISTS organization_id uuid;

UPDATE public.perm_diagnostics d
   SET organization_id = p.organization_id
  FROM public.profiles p
 WHERE d.organization_id IS NULL AND p.id = d.user_id;

DELETE FROM public.perm_diagnostics WHERE organization_id IS NULL;

ALTER TABLE public.perm_diagnostics
  ALTER COLUMN organization_id SET DEFAULT public.current_org_id();
ALTER TABLE public.perm_diagnostics
  ALTER COLUMN organization_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS perm_diagnostics_org_idx
  ON public.perm_diagnostics (organization_id, run_at DESC);

DROP POLICY IF EXISTS "perm diagnostics admin read" ON public.perm_diagnostics;
CREATE POLICY "perm diagnostics admin read" ON public.perm_diagnostics
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id() AND public.is_org_admin());

DROP POLICY IF EXISTS "perm diagnostics admin write" ON public.perm_diagnostics;
CREATE POLICY "perm diagnostics admin write" ON public.perm_diagnostics
  FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.current_org_id() AND public.is_org_admin());

ALTER TABLE public.finance_posting_receipts
  ADD COLUMN IF NOT EXISTS posting_type text NOT NULL DEFAULT 'revenue',
  ADD COLUMN IF NOT EXISTS journal_id uuid,
  ADD COLUMN IF NOT EXISTS reverses_receipt_id uuid;

CREATE INDEX IF NOT EXISTS finance_posting_receipts_source
  ON public.finance_posting_receipts (organization_id, source_module, source_id, posting_type);

CREATE OR REPLACE FUNCTION public.neo_gl_acct(_org uuid, _code text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id FROM public.chart_of_accounts a
   WHERE a.organization_id = _org AND a.code = _code
     AND a.postable AND a.active AND coalesce(a.is_header,false) = false
   LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.neo_gl_acct(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_gl_acct(uuid,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_gl_settlement_code(_method text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE lower(coalesce(_method,'cash'))
    WHEN 'cash' THEN '1010'
    WHEN 'bank' THEN '1020' WHEN 'bank_transfer' THEN '1020' WHEN 'eft' THEN '1020'
    WHEN 'cheque' THEN '1020'
    WHEN 'mpesa' THEN '1030' WHEN 'm-pesa' THEN '1030' WHEN 'mobile_money' THEN '1030'
    WHEN 'card' THEN '1040' WHEN 'credit_card' THEN '1040' WHEN 'debit_card' THEN '1040'
    WHEN 'corporate' THEN '1060' WHEN 'credit' THEN '1060' WHEN 'invoice' THEN '1060'
    WHEN 'room_charge' THEN '1060'
    ELSE '1010' END;
$$;

CREATE OR REPLACE FUNCTION public.neo_gl_revenue_code(_category text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE lower(coalesce(_category,'other'))
    WHEN 'accommodation' THEN '4010' WHEN 'room' THEN '4010' WHEN 'rooms' THEN '4010'
    WHEN 'meal_plan' THEN '4020' WHEN 'restaurant' THEN '4020' WHEN 'food' THEN '4020'
    WHEN 'fnb' THEN '4020' WHEN 'dining' THEN '4020' WHEN 'kitchen' THEN '4020'
    WHEN 'bar' THEN '4030' WHEN 'beverage' THEN '4030'
    WHEN 'room_service' THEN '4040'
    WHEN 'laundry' THEN '4050'
    WHEN 'event' THEN '4060' WHEN 'events' THEN '4060' WHEN 'banquet' THEN '4060'
    WHEN 'delivery' THEN '4070'
    WHEN 'transport' THEN '4080'
    ELSE '4090' END;
$$;

CREATE OR REPLACE FUNCTION public.neo_gl_period(_org uuid, _date date)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p public.accounting_periods; pid uuid;
BEGIN
  SELECT * INTO p FROM public.fin_period_for(_org, _date);
  IF p.id IS NOT NULL THEN RETURN p.id; END IF;
  INSERT INTO public.accounting_periods (organization_id, name, starts_on, ends_on, status)
  VALUES (_org, to_char(_date,'Mon YYYY'), date_trunc('month', _date)::date,
          (date_trunc('month', _date) + interval '1 month - 1 day')::date, 'open')
  RETURNING id INTO pid;
  RETURN pid;
END $$;
REVOKE ALL ON FUNCTION public.neo_gl_period(uuid,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_gl_period(uuid,date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.neo_gl_post(
  _org uuid, _branch uuid, _module text, _source_type text, _source_id uuid,
  _posting_type text, _date date, _currency text, _desc text, _lines jsonb,
  _customer uuid DEFAULT NULL, _reverses uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE key text := _source_type || ':' || _source_id::text || ':' || _posting_type;
        j uuid; ln jsonb; i int := 0; td numeric := 0; tc numeric := 0; acct uuid;
        d numeric; c numeric;
BEGIN
  SELECT id INTO j FROM public.journal_entries
   WHERE organization_id = _org AND idempotency_key = key;
  IF j IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'journal_id', j, 'duplicate_prevented', true);
  END IF;

  INSERT INTO public.journal_entries
    (organization_id, branch_id, journal_number, journal_type, accounting_date,
     period_id, source_module, source_document_type, source_document_id,
     idempotency_key, description, currency, status, created_by, reverses_journal_id)
  VALUES (_org, _branch, public.next_document_number('journal','JV',_branch),
          CASE WHEN _reverses IS NULL THEN 'system' ELSE 'reversal' END, _date,
          public.neo_gl_period(_org, _date), _module,
          _source_type || ':' || _posting_type, _source_id, key, _desc,
          coalesce(_currency,'KES'), 'draft', auth.uid(), _reverses)
  RETURNING id INTO j;

  FOR ln IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    d := round(coalesce((ln->>'debit')::numeric, 0), 2);
    c := round(coalesce((ln->>'credit')::numeric, 0), 2);
    CONTINUE WHEN d = 0 AND c = 0;
    acct := public.neo_gl_acct(_org, ln->>'code');
    IF acct IS NULL THEN
      RAISE EXCEPTION 'chart_of_accounts is missing postable account %', ln->>'code';
    END IF;
    i := i + 1;
    INSERT INTO public.journal_entry_lines
      (organization_id, journal_id, line_number, account_id, description, debit, credit,
       branch_id, customer_id)
    VALUES (_org, j, i, acct, coalesce(ln->>'description', _desc), d, c, _branch, _customer);
    td := td + d; tc := tc + c;
  END LOOP;

  IF i = 0 THEN RAISE EXCEPTION 'nothing_to_post'; END IF;
  IF round(td,2) <> round(tc,2) THEN
    RAISE EXCEPTION 'journal is not balanced (debit % vs credit %)', td, tc;
  END IF;

  UPDATE public.journal_entries
     SET total_debit = td, total_credit = tc, status = 'posted',
         posted_by = auth.uid(), posted_at = now()
   WHERE id = j;

  RETURN jsonb_build_object('ok', true, 'journal_id', j, 'amount', td);
END $$;
REVOKE ALL ON FUNCTION public.neo_gl_post(uuid,uuid,text,text,uuid,text,date,text,text,jsonb,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_gl_post(uuid,uuid,text,text,uuid,text,date,text,text,jsonb,uuid,uuid) TO authenticated, service_role;