
CREATE TABLE IF NOT EXISTS public.employee_payment_details (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  payment_method text NOT NULL DEFAULT 'bank_transfer',
  bank_name text,
  bank_branch text,
  account_name text,
  account_number text,
  mobile_money_number text,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_payment_details_employee_unique UNIQUE (employee_id),
  CONSTRAINT employee_payment_details_method_check
    CHECK (payment_method IN ('bank_transfer','mobile_money','cash','cheque'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_payment_details TO authenticated;
GRANT ALL ON public.employee_payment_details TO service_role;

ALTER TABLE public.employee_payment_details ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Payroll staff read payment details"
  ON public.employee_payment_details FOR SELECT TO authenticated
  USING (
    organization_id = current_org_id()
    AND (
      has_permission('hr-payroll','inputs.view')
      OR employee_id IN (
        SELECT e.id FROM public.employees e WHERE e.profile_id = auth.uid()
      )
    )
  );

CREATE POLICY "Payroll staff create payment details"
  ON public.employee_payment_details FOR INSERT TO authenticated
  WITH CHECK (organization_id = current_org_id() AND has_permission('hr-payroll','inputs.edit'));

CREATE POLICY "Payroll staff update payment details"
  ON public.employee_payment_details FOR UPDATE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('hr-payroll','inputs.edit'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('hr-payroll','inputs.edit'));

CREATE POLICY "Payroll staff delete payment details"
  ON public.employee_payment_details FOR DELETE TO authenticated
  USING (organization_id = current_org_id() AND has_permission('hr-payroll','inputs.edit'));

CREATE TRIGGER employee_payment_details_touch
  BEFORE UPDATE ON public.employee_payment_details
  FOR EACH ROW EXECUTE FUNCTION public.hr_touch_updated_at();

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS payroll_effective_from date;

CREATE OR REPLACE FUNCTION public.neo_hr_set_payroll_enrolment(
  _employee uuid,
  _active boolean,
  _effective date
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  _org uuid := current_org_id();
  _prev text;
  _has_pay boolean;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT has_permission('hr-payroll','inputs.edit') THEN
    RAISE EXCEPTION 'Not authorised to change payroll enrolment';
  END IF;

  SELECT payroll_status INTO _prev FROM public.employees
   WHERE id = _employee AND organization_id = _org;
  IF _prev IS NULL AND NOT EXISTS (
    SELECT 1 FROM public.employees WHERE id = _employee AND organization_id = _org
  ) THEN
    RAISE EXCEPTION 'Employee not found in this organisation';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.employee_compensation c
     WHERE c.employee_id = _employee AND c.organization_id = _org
  ) INTO _has_pay;

  IF _active AND NOT _has_pay THEN
    RAISE EXCEPTION 'Record the agreed pay before enrolling this employee in payroll';
  END IF;

  UPDATE public.employees
     SET payroll_status = CASE WHEN _active THEN 'active' ELSE 'inactive' END,
         payroll_effective_from = _effective,
         updated_at = now()
   WHERE id = _employee AND organization_id = _org;

  PERFORM public.log_audit_event(
    _action := CASE WHEN _active THEN 'hr.payroll.enrolled' ELSE 'hr.payroll.unenrolled' END,
    _module := 'human-resources',
    _record_id := _employee::text,
    _previous := jsonb_build_object('payroll_status', _prev),
    _new := jsonb_build_object(
      'payroll_status', CASE WHEN _active THEN 'active' ELSE 'inactive' END,
      'effective_from', _effective
    )
  );

  RETURN jsonb_build_object('ok', true, 'employee_id', _employee, 'active', _active);
END;
$fn$;

REVOKE ALL ON FUNCTION public.neo_hr_set_payroll_enrolment(uuid, boolean, date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.neo_hr_set_payroll_enrolment(uuid, boolean, date) TO authenticated;
