-- Payroll payslips are a view of posted payroll truth, not a pre-posting preview.
-- Preserve historical rows, but refuse new releases until the payroll journal exists
-- and hide any historically premature release from employee self-service.

CREATE OR REPLACE FUNCTION public.neo_hr_payroll_release_payslips(
  _period uuid,
  _release boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := public.current_org_id();
  _p public.payroll_periods;
BEGIN
  IF _org IS NULL THEN
    RAISE EXCEPTION 'No organisation context';
  END IF;

  IF NOT (public.has_permission('hr-payroll','approve') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not authorised to release payslips' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO _p
    FROM public.payroll_periods
   WHERE id = _period AND organization_id = _org
   FOR UPDATE;

  IF _p.id IS NULL THEN
    RAISE EXCEPTION 'Payroll period not found in this organisation';
  END IF;

  IF _release THEN
    IF _p.status <> 'exported'
       OR _p.posted_journal_id IS NULL
       OR _p.posted_at IS NULL THEN
      RAISE EXCEPTION 'Post this payroll to Finance before releasing payslips';
    END IF;

    UPDATE public.payroll_periods
       SET payslips_released_at = COALESCE(payslips_released_at, now()),
           payslips_released_by = COALESCE(payslips_released_by, auth.uid()),
           updated_at = now()
     WHERE id = _p.id;
  ELSE
    UPDATE public.payroll_periods
       SET payslips_released_at = NULL,
           payslips_released_by = NULL,
           updated_at = now()
     WHERE id = _p.id;
  END IF;

  PERFORM public.log_audit_event(
    _org,
    CASE WHEN _release THEN 'hr.payroll.payslips_released' ELSE 'hr.payroll.payslips_withdrawn' END,
    'human-resources',
    _p.id::text,
    jsonb_build_object(
      'released_at', _p.payslips_released_at,
      'status', _p.status,
      'posted_journal_id', _p.posted_journal_id
    ),
    jsonb_build_object(
      'released', _release,
      'journal_id', _p.posted_journal_id
    ),
    CASE WHEN _release
      THEN 'Payslips released after payroll posting'
      ELSE 'Payslips withdrawn from employee self-service'
    END
  );

  RETURN jsonb_build_object(
    'ok', true,
    'period_id', _p.id,
    'released', _release,
    'journal_id', _p.posted_journal_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.neo_hr_payroll_release_payslips(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.neo_hr_payroll_release_payslips(uuid, boolean) TO authenticated;

DROP POLICY IF EXISTS "staff read own released payslip" ON public.payroll_input_records;
CREATE POLICY "staff read own released payslip"
ON public.payroll_input_records
FOR SELECT
TO authenticated
USING (
  organization_id = public.current_org_id()
  AND EXISTS (
    SELECT 1
      FROM public.employees e
     WHERE e.id = payroll_input_records.employee_id
       AND e.profile_id = auth.uid()
  )
  AND EXISTS (
    SELECT 1
      FROM public.payroll_periods p
     WHERE p.id = payroll_input_records.period_id
       AND p.organization_id = payroll_input_records.organization_id
       AND p.status = 'exported'
       AND p.posted_journal_id IS NOT NULL
       AND p.posted_at IS NOT NULL
       AND p.payslips_released_at IS NOT NULL
  )
);
