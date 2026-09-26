CREATE POLICY "staff read own released payslip"
ON public.payroll_input_records
FOR SELECT
TO authenticated
USING (
  organization_id = current_org_id()
  AND EXISTS (
    SELECT 1 FROM public.employees e
    WHERE e.id = payroll_input_records.employee_id
      AND e.profile_id = auth.uid()
  )
  AND EXISTS (
    SELECT 1 FROM public.payroll_periods p
    WHERE p.id = payroll_input_records.period_id
      AND p.payslips_released_at IS NOT NULL
  )
);