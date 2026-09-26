CREATE OR REPLACE FUNCTION public.neo_hr_payroll_post(_period uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _org uuid := current_org_id();
  _p public.payroll_periods;
  _s public.payroll_posting_settings;
  _rows int;
  _missing int;
  _base numeric := 0; _allow numeric := 0; _bonus numeric := 0;
  _reimb numeric := 0; _deduct numeric := 0; _net numeric := 0;
  _cur text;
  _lines jsonb := '[]'::jsonb;
  _res jsonb;
  _code text;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT has_permission('hr-payroll','approve') THEN
    RAISE EXCEPTION 'Not authorised to post payroll to the finance books';
  END IF;

  SELECT * INTO _p FROM public.payroll_periods WHERE id = _period AND organization_id = _org;
  IF _p.id IS NULL THEN RAISE EXCEPTION 'Payroll period not found in this organisation'; END IF;
  IF _p.posted_journal_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'journal_id', _p.posted_journal_id, 'duplicate_prevented', true);
  END IF;
  IF _p.status NOT IN ('approved','locked') THEN
    RAISE EXCEPTION 'Approve or lock the payroll period before posting it';
  END IF;

  SELECT * INTO _s FROM public.payroll_posting_settings
   WHERE organization_id = _org AND branch_id IS NOT DISTINCT FROM _p.branch_id;
  IF _s.id IS NULL THEN
    SELECT * INTO _s FROM public.payroll_posting_settings
     WHERE organization_id = _org AND branch_id IS NULL;
  END IF;
  IF _s.id IS NULL THEN
    RAISE EXCEPTION 'Payroll posting accounts are not configured for this property';
  END IF;

  SELECT count(*), count(*) FILTER (WHERE missing_compensation),
         COALESCE(sum(base_pay),0), COALESCE(sum(allowances),0), COALESCE(sum(bonuses),0),
         COALESCE(sum(reimbursements),0), COALESCE(sum(deductions),0), COALESCE(sum(net_pay),0),
         min(currency)
    INTO _rows, _missing, _base, _allow, _bonus, _reimb, _deduct, _net, _cur
    FROM public.neo_hr_payroll_compute(_period);

  IF _rows = 0 THEN RAISE EXCEPTION 'This period has no payroll input records'; END IF;
  IF _missing > 0 THEN
    RAISE EXCEPTION '% employee(s) have no pay record — enter their pay before posting', _missing;
  END IF;
  IF (SELECT count(DISTINCT currency) FROM public.neo_hr_payroll_compute(_period)) > 1 THEN
    RAISE EXCEPTION 'This period mixes currencies — post each currency separately';
  END IF;

  IF _base > 0 THEN
    SELECT code INTO _code FROM public.chart_of_accounts WHERE id = _s.salary_expense_account_id;
    IF _code IS NULL THEN RAISE EXCEPTION 'Choose a salary expense account before posting'; END IF;
    _lines := _lines || jsonb_build_object('code', _code, 'debit', _base, 'description', 'Salaries and wages');
  END IF;
  IF _allow > 0 THEN
    SELECT code INTO _code FROM public.chart_of_accounts WHERE id = _s.allowance_expense_account_id;
    IF _code IS NULL THEN RAISE EXCEPTION 'Choose an allowance expense account before posting'; END IF;
    _lines := _lines || jsonb_build_object('code', _code, 'debit', _allow, 'description', 'Allowances');
  END IF;
  IF _bonus > 0 THEN
    SELECT code INTO _code FROM public.chart_of_accounts WHERE id = _s.bonus_expense_account_id;
    IF _code IS NULL THEN RAISE EXCEPTION 'Choose a bonus and commission expense account before posting'; END IF;
    _lines := _lines || jsonb_build_object('code', _code, 'debit', _bonus, 'description', 'Bonuses and commissions');
  END IF;
  IF _reimb > 0 THEN
    SELECT code INTO _code FROM public.chart_of_accounts WHERE id = _s.reimbursement_expense_account_id;
    IF _code IS NULL THEN RAISE EXCEPTION 'Choose a reimbursement account before posting'; END IF;
    _lines := _lines || jsonb_build_object('code', _code, 'debit', _reimb, 'description', 'Reimbursements');
  END IF;
  IF _deduct > 0 THEN
    SELECT code INTO _code FROM public.chart_of_accounts WHERE id = _s.deduction_liability_account_id;
    IF _code IS NULL THEN RAISE EXCEPTION 'Choose a deductions payable account before posting'; END IF;
    _lines := _lines || jsonb_build_object('code', _code, 'credit', _deduct, 'description', 'Payroll deductions payable');
  END IF;
  IF _net > 0 THEN
    SELECT code INTO _code FROM public.chart_of_accounts WHERE id = _s.net_pay_liability_account_id;
    IF _code IS NULL THEN RAISE EXCEPTION 'Choose a net pay payable account before posting'; END IF;
    _lines := _lines || jsonb_build_object('code', _code, 'credit', _net, 'description', 'Net pay payable');
  END IF;

  _res := public.neo_gl_post(
    _org, _p.branch_id, 'human-resources', 'payroll_period', _p.id, 'payroll',
    _p.period_end, COALESCE(_cur, 'KES'),
    'Payroll ' || _p.name, _lines);

  UPDATE public.payroll_input_records r
     SET base_pay = c.base_pay, gross_pay = c.gross_pay, net_pay = c.net_pay,
         currency = c.currency, updated_at = now()
    FROM public.neo_hr_payroll_compute(_period) c
   WHERE r.period_id = _p.id AND r.employee_id = c.employee_id;

  UPDATE public.payroll_periods
     SET posted_journal_id = (_res->>'journal_id')::uuid,
         posted_at = now(), posted_by = auth.uid(),
         status = 'exported', updated_at = now()
   WHERE id = _p.id;

  PERFORM public.log_audit_event(
    _org, 'hr.payroll.posted', 'human-resources', _p.id::text,
    jsonb_build_object('status', _p.status),
    jsonb_build_object('journal_id', _res->>'journal_id', 'employees', _rows,
                       'gross', _base + _allow + _bonus, 'net', _net, 'currency', COALESCE(_cur,'KES')),
    'Payroll posted to the finance books');

  RETURN jsonb_build_object('ok', true, 'journal_id', _res->>'journal_id',
                            'employees', _rows, 'net', _net,
                            'duplicate_prevented', COALESCE((_res->>'duplicate_prevented')::boolean, false));
END;
$$;