-- 1. Payslip document type, patched into the existing payload routine additively.
DO $mig$
DECLARE src text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO src FROM pg_proc
   WHERE proname = 'neo_document_payload' AND pronamespace = 'public'::regnamespace;

  IF src IS NULL THEN RAISE EXCEPTION 'neo_document_payload not found'; END IF;

  IF position('''payslip''' in src) = 0 THEN
    src := replace(
      src,
      '    when ''task_sheet'' then ''tasks''',
      '    when ''task_sheet'' then ''tasks''
    when ''payslip'' then ''human-resources'''
    );

    src := replace(
      src,
      '  elsif _type = ''task_sheet'' then',
      '  elsif _type = ''payslip'' then
    select p.organization_id, coalesce(p.branch_id, e.branch_id, per.branch_id), coalesce(p.currency, ''KES''),
           jsonb_build_object(
             ''number'', coalesce(e.employee_number, left(p.id::text, 8)),
             ''date'', per.period_end,
             ''status'', case when per.payslips_released_at is null then ''withheld'' else ''released'' end,
             ''title'', ''Payslip'',
             ''subtitle'', per.name),
           jsonb_build_object(''label'', ''Employee'', ''name'', coalesce(e.full_name, ''Not configured''),
             ''lines'', jsonb_build_array(coalesce(e.job_title, ''''), coalesce(e.employee_number, ''''))),
           ''[]''::jsonb,
           jsonb_build_array(
             jsonb_build_object(''label'', ''Basic pay'', ''amount'', p.base_pay),
             jsonb_build_object(''label'', ''Allowances'', ''amount'', p.allowances),
             jsonb_build_object(''label'', ''Bonuses'', ''amount'', p.bonuses),
             jsonb_build_object(''label'', ''Commissions'', ''amount'', p.commissions),
             jsonb_build_object(''label'', ''Reimbursements'', ''amount'', p.reimbursements),
             jsonb_build_object(''label'', ''Gross pay'', ''amount'', p.gross_pay, ''emphasis'', true),
             jsonb_build_object(''label'', ''Deductions'', ''amount'', -p.deductions),
             jsonb_build_object(''label'', ''Net pay'', ''amount'', p.net_pay, ''emphasis'', true)),
           jsonb_strip_nulls(jsonb_build_object(
             ''Period'', per.period_start::text || '' - '' || per.period_end::text,
             ''Days worked'', p.worked_days,
             ''Hours worked'', p.worked_hours,
             ''Overtime hours'', p.overtime_hours,
             ''Paid leave days'', p.paid_leave_days,
             ''Unpaid leave days'', p.unpaid_leave_days,
             ''Notes'', nullif(p.notes, '''')))
      into _org, _branch, _currency, _doc, _party, _lines, _totals, _meta
      from payroll_input_records p
      join payroll_periods per on per.id = p.period_id
      left join employees e on e.id = p.employee_id
      where p.id = _id;

  elsif _type = ''task_sheet'' then'
    );

    EXECUTE src;
  END IF;
END
$mig$;

-- 2. Internal routines must not be executable by PUBLIC / anon.
DO $g$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN (
         'neo_hr_leave_applicability',
         'neo_hr_leave_applies',
         'neo_sync_reporting_line_to_employee',
         'neo_sync_reporting_line_to_profile')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    IF r.proname IN ('neo_hr_leave_applicability', 'neo_hr_leave_applies') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
    ELSE
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    END IF;
  END LOOP;
END
$g$;