-- 1. Employee compensation (HR-entered; nothing generated)
CREATE TABLE IF NOT EXISTS public.employee_compensation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT current_org_id(),
  branch_id uuid REFERENCES public.branches(id),
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  effective_from date NOT NULL,
  pay_frequency text NOT NULL DEFAULT 'monthly',
  base_amount numeric(14,2) NOT NULL,
  currency text NOT NULL DEFAULT 'KES',
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_compensation_frequency_chk
    CHECK (pay_frequency IN ('monthly','daily','hourly')),
  CONSTRAINT employee_compensation_amount_chk CHECK (base_amount >= 0),
  CONSTRAINT employee_compensation_unique UNIQUE (employee_id, effective_from)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_compensation TO authenticated;
GRANT ALL ON public.employee_compensation TO service_role;
ALTER TABLE public.employee_compensation ENABLE ROW LEVEL SECURITY;

CREATE POLICY "employee compensation read" ON public.employee_compensation
  FOR SELECT TO authenticated
  USING (organization_id = current_org_id() AND has_permission('hr-payroll','inputs.view'));
CREATE POLICY "employee compensation write" ON public.employee_compensation
  FOR INSERT TO authenticated
  WITH CHECK (organization_id = current_org_id() AND has_permission('hr-payroll','inputs.edit'));
CREATE POLICY "employee compensation update" ON public.employee_compensation
  FOR UPDATE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('hr-payroll','inputs.edit'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('hr-payroll','inputs.edit'));
CREATE POLICY "employee compensation delete" ON public.employee_compensation
  FOR DELETE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('hr-payroll','inputs.edit'));

CREATE INDEX IF NOT EXISTS employee_compensation_employee_idx
  ON public.employee_compensation (employee_id, effective_from DESC);

CREATE TRIGGER employee_compensation_touch
  BEFORE UPDATE ON public.employee_compensation
  FOR EACH ROW EXECUTE FUNCTION public.fin_touch_updated_at();

-- 2. Payroll posting accounts (Finance-chosen; no defaults invented)
CREATE TABLE IF NOT EXISTS public.payroll_posting_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT current_org_id(),
  branch_id uuid REFERENCES public.branches(id),
  salary_expense_account_id uuid REFERENCES public.chart_of_accounts(id),
  allowance_expense_account_id uuid REFERENCES public.chart_of_accounts(id),
  bonus_expense_account_id uuid REFERENCES public.chart_of_accounts(id),
  reimbursement_expense_account_id uuid REFERENCES public.chart_of_accounts(id),
  deduction_liability_account_id uuid REFERENCES public.chart_of_accounts(id),
  net_pay_liability_account_id uuid REFERENCES public.chart_of_accounts(id),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll_posting_settings TO authenticated;
GRANT ALL ON public.payroll_posting_settings TO service_role;
ALTER TABLE public.payroll_posting_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payroll posting settings read" ON public.payroll_posting_settings
  FOR SELECT TO authenticated
  USING (organization_id = current_org_id() AND has_permission('hr-payroll','inputs.view'));
CREATE POLICY "payroll posting settings write" ON public.payroll_posting_settings
  FOR INSERT TO authenticated
  WITH CHECK (organization_id = current_org_id() AND has_permission('hr-payroll','inputs.edit'));
CREATE POLICY "payroll posting settings update" ON public.payroll_posting_settings
  FOR UPDATE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('hr-payroll','inputs.edit'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('hr-payroll','inputs.edit'));

CREATE UNIQUE INDEX IF NOT EXISTS payroll_posting_settings_scope_idx
  ON public.payroll_posting_settings (organization_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TRIGGER payroll_posting_settings_touch
  BEFORE UPDATE ON public.payroll_posting_settings
  FOR EACH ROW EXECUTE FUNCTION public.fin_touch_updated_at();

-- 3. Money columns on payroll records and posting trace on periods
ALTER TABLE public.payroll_input_records
  ADD COLUMN IF NOT EXISTS base_pay numeric(14,2),
  ADD COLUMN IF NOT EXISTS gross_pay numeric(14,2),
  ADD COLUMN IF NOT EXISTS net_pay numeric(14,2),
  ADD COLUMN IF NOT EXISTS currency text;

ALTER TABLE public.payroll_periods
  ADD COLUMN IF NOT EXISTS posted_journal_id uuid REFERENCES public.journal_entries(id),
  ADD COLUMN IF NOT EXISTS posted_at timestamptz,
  ADD COLUMN IF NOT EXISTS posted_by uuid;

-- 4. Compute a period's money position from real records only
CREATE OR REPLACE FUNCTION public.neo_hr_payroll_compute(_period uuid)
RETURNS TABLE (
  employee_id uuid,
  full_name text,
  branch_id uuid,
  currency text,
  pay_frequency text,
  base_pay numeric,
  allowances numeric,
  bonuses numeric,
  reimbursements numeric,
  deductions numeric,
  gross_pay numeric,
  net_pay numeric,
  missing_compensation boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH p AS (
    SELECT * FROM public.payroll_periods
     WHERE id = _period AND organization_id = current_org_id()
  ), comp AS (
    SELECT DISTINCT ON (c.employee_id) c.*
      FROM public.employee_compensation c, p
     WHERE c.organization_id = p.organization_id
       AND c.effective_from <= p.period_end
     ORDER BY c.employee_id, c.effective_from DESC
  )
  SELECT r.employee_id,
         e.full_name,
         r.branch_id,
         COALESCE(c.currency, 'KES') AS currency,
         COALESCE(c.pay_frequency, 'monthly') AS pay_frequency,
         ROUND(COALESCE(
           CASE c.pay_frequency
             WHEN 'monthly' THEN c.base_amount
             WHEN 'daily'   THEN c.base_amount * COALESCE(r.worked_days, 0)
             WHEN 'hourly'  THEN c.base_amount * COALESCE(r.worked_hours, 0)
           END, 0), 2) AS base_pay,
         ROUND(COALESCE(r.allowances, 0), 2) AS allowances,
         ROUND(COALESCE(r.bonuses, 0) + COALESCE(r.commissions, 0), 2) AS bonuses,
         ROUND(COALESCE(r.reimbursements, 0), 2) AS reimbursements,
         ROUND(COALESCE(r.deductions, 0), 2) AS deductions,
         ROUND(COALESCE(
           CASE c.pay_frequency
             WHEN 'monthly' THEN c.base_amount
             WHEN 'daily'   THEN c.base_amount * COALESCE(r.worked_days, 0)
             WHEN 'hourly'  THEN c.base_amount * COALESCE(r.worked_hours, 0)
           END, 0)
           + COALESCE(r.allowances, 0) + COALESCE(r.bonuses, 0) + COALESCE(r.commissions, 0), 2) AS gross_pay,
         ROUND(COALESCE(
           CASE c.pay_frequency
             WHEN 'monthly' THEN c.base_amount
             WHEN 'daily'   THEN c.base_amount * COALESCE(r.worked_days, 0)
             WHEN 'hourly'  THEN c.base_amount * COALESCE(r.worked_hours, 0)
           END, 0)
           + COALESCE(r.allowances, 0) + COALESCE(r.bonuses, 0) + COALESCE(r.commissions, 0)
           + COALESCE(r.reimbursements, 0) - COALESCE(r.deductions, 0), 2) AS net_pay,
         (c.id IS NULL) AS missing_compensation
    FROM public.payroll_input_records r
    JOIN p ON p.id = r.period_id
    JOIN public.employees e ON e.id = r.employee_id
    LEFT JOIN comp c ON c.employee_id = r.employee_id
   WHERE has_permission('hr-payroll','inputs.view')
   ORDER BY e.full_name;
$$;

-- 5. Post an approved period to the finance books, once
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
    RAISE EXCEPTION 'ateach % employee(s) have no pay record — enter their pay before posting', _missing;
  END IF;
  IF (SELECT count(DISTINCT currency) FROM public.neo_hr_payroll_compute(_period)) > 1 THEN
    RAISE EXCEPTION 'This period mixes currencies — post each currency separately';
  END IF;

  -- Account codes are read from the accounts Finance selected; none are assumed.
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

REVOKE ALL ON FUNCTION public.neo_hr_payroll_compute(uuid) FROM public;
REVOKE ALL ON FUNCTION public.neo_hr_payroll_post(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.neo_hr_payroll_compute(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_hr_payroll_post(uuid) TO authenticated;