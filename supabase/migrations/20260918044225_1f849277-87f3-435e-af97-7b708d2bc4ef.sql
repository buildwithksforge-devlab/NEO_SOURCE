ALTER TABLE public.payroll_periods
  ADD COLUMN IF NOT EXISTS payslips_released_at timestamptz,
  ADD COLUMN IF NOT EXISTS payslips_released_by uuid;