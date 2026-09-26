ALTER TABLE public.leave_types
  ADD COLUMN IF NOT EXISTS employment_types text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS department_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS effective_to date,
  ADD COLUMN IF NOT EXISTS minimum_service_days integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_requests_per_year integer;

CREATE OR REPLACE FUNCTION public.neo_hr_leave_applicability(_employee uuid, _leave_type uuid, _on date DEFAULT current_date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := current_org_id();
  _emp public.employees;
  _lt public.leave_types;
  _service_days numeric;
  _reasons text[] := '{}';
  _gender text;
BEGIN
  SELECT * INTO _emp FROM public.employees WHERE id = _employee AND organization_id = _org;
  SELECT * INTO _lt FROM public.leave_types WHERE id = _leave_type AND organization_id = _org;
  IF _emp.id IS NULL OR _lt.id IS NULL THEN
    RETURN jsonb_build_object('eligible', false, 'reasons', to_jsonb(ARRAY['Record not found in this organisation']));
  END IF;

  IF NOT _lt.active THEN
    _reasons := _reasons || 'This leave policy is not active';
  END IF;

  IF _lt.effective_from IS NOT NULL AND _on < _lt.effective_from THEN
    _reasons := _reasons || format('This policy starts on %s', to_char(_lt.effective_from, 'DD Mon YYYY'));
  END IF;
  IF _lt.effective_to IS NOT NULL AND _on > _lt.effective_to THEN
    _reasons := _reasons || format('This policy ended on %s', to_char(_lt.effective_to, 'DD Mon YYYY'));
  END IF;

  IF _lt.branch_id IS NOT NULL AND _emp.branch_id IS NOT NULL AND _lt.branch_id <> _emp.branch_id THEN
    _reasons := _reasons || 'This policy applies to another property';
  END IF;

  IF array_length(_lt.department_ids, 1) IS NOT NULL
     AND NOT (_emp.department_id IS NOT NULL AND _emp.department_id = ANY (_lt.department_ids)) THEN
    _reasons := _reasons || 'This policy applies to selected departments only';
  END IF;

  IF array_length(_lt.employment_types, 1) IS NOT NULL
     AND NOT (COALESCE(NULLIF(lower(_emp.employment_type::text), ''), 'unset') = ANY (
        SELECT lower(t) FROM unnest(_lt.employment_types) t)) THEN
    _reasons := _reasons || 'This policy applies to selected employment types only';
  END IF;

  IF COALESCE(lower(_lt.gender_scope), 'any') <> 'any' THEN
    _gender := NULLIF(lower(COALESCE(_emp.gender::text, '')), '');
    IF _gender IS NULL THEN
      _reasons := _reasons || 'This policy applies to a specific sex; the employee record does not record one';
    ELSIF _gender <> lower(_lt.gender_scope) THEN
      _reasons := _reasons || format('This policy applies to %s employees only', lower(_lt.gender_scope));
    END IF;
  END IF;

  _service_days := GREATEST(0, _on - COALESCE(_emp.employment_date, _on));
  IF _lt.minimum_service_days > 0 AND _service_days < _lt.minimum_service_days THEN
    _reasons := _reasons || format('Requires %s day(s) of service', _lt.minimum_service_days);
  END IF;

  RETURN jsonb_build_object(
    'eligible', array_length(_reasons, 1) IS NULL,
    'reasons', to_jsonb(_reasons),
    'service_days', _service_days
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_hr_leave_applies(_employee uuid, _leave_type uuid, _on date DEFAULT current_date)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE((public.neo_hr_leave_applicability(_employee, _leave_type, _on) ->> 'eligible')::boolean, false);
$function$;

GRANT EXECUTE ON FUNCTION public.neo_hr_leave_applicability(uuid, uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.neo_hr_leave_applies(uuid, uuid, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.neo_hr_leave_sync_entitlements(_employee uuid DEFAULT NULL::uuid, _year integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := current_org_id();
  _start_month integer;
  _yr integer;
  _period_start date;
  _period_end date;
  _emp record;
  _lt record;
  _service_months numeric;
  _months_in_year numeric;
  _entitlement numeric;
  _accrued numeric;
  _prior_available numeric;
  _carried numeric;
  _expired numeric;
  _pending numeric;
  _taken numeric;
  _rows integer := 0;
  _removed integer := 0;
  _n integer;
BEGIN
  IF _org IS NULL THEN
    RAISE EXCEPTION 'No organisation context';
  END IF;

  IF NOT (has_permission('hr-leave', 'self.view') OR has_permission('hr-leave', 'approve')) THEN
    RAISE EXCEPTION 'Not authorised to calculate leave entitlement';
  END IF;

  _start_month := COALESCE((SELECT s.leave_year_start_month FROM public.hr_settings s WHERE s.organization_id = _org LIMIT 1), 1);
  _yr := COALESCE(_year, public.hr_leave_year_of(_org, current_date));
  _period_start := make_date(_yr, _start_month, 1);
  _period_end := (_period_start + interval '1 year - 1 day')::date;

  FOR _emp IN
    SELECT e.id, e.employment_date, e.branch_id, e.employment_status
      FROM public.employees e
     WHERE e.organization_id = _org
       AND (_employee IS NULL OR e.id = _employee)
       AND e.employment_status <> 'exited'
  LOOP
    -- A balance that the employee does not qualify for is withdrawn, unless
    -- days were already taken or are pending against it: history is preserved.
    WITH gone AS (
      DELETE FROM public.leave_balances b
       WHERE b.organization_id = _org
         AND b.employee_id = _emp.id
         AND b.period_year = _yr
         AND COALESCE(b.taken_days, 0) = 0
         AND COALESCE(b.pending_days, 0) = 0
         AND NOT public.neo_hr_leave_applies(_emp.id, b.leave_type_id, current_date)
      RETURNING 1
    )
    SELECT count(*) INTO _n FROM gone;
    _removed := _removed + COALESCE(_n, 0);

    FOR _lt IN
      SELECT * FROM public.leave_types
       WHERE organization_id = _org AND active
         AND (branch_id IS NULL OR _emp.branch_id IS NULL OR branch_id = _emp.branch_id)
         AND public.neo_hr_leave_applies(_emp.id, id, current_date)
    LOOP
      _service_months := GREATEST(
        0,
        EXTRACT(epoch FROM age(current_date, COALESCE(_emp.employment_date, current_date))) / 2629800.0
      );

      IF _service_months < COALESCE(_lt.eligibility_months, 0) THEN
        _entitlement := 0;
        _accrued := 0;
      ELSIF _lt.accrual_method = 'monthly' THEN
        _months_in_year := LEAST(
          12,
          GREATEST(0,
            (EXTRACT(year FROM age(LEAST(current_date, _period_end), GREATEST(_period_start, COALESCE(_emp.employment_date, _period_start)))) * 12
             + EXTRACT(month FROM age(LEAST(current_date, _period_end), GREATEST(_period_start, COALESCE(_emp.employment_date, _period_start)))) + 1)
          )
        );
        _accrued := round((COALESCE(_lt.annual_entitlement_days, 0) * _months_in_year / 12.0)::numeric, 1);
        _entitlement := _accrued;
      ELSE
        _entitlement := COALESCE(_lt.annual_entitlement_days, 0);
        _accrued := _entitlement;
      END IF;

      SELECT GREATEST(0,
               COALESCE(b.entitlement_days,0) + COALESCE(b.carried_forward_days,0)
               + COALESCE(b.adjustment_days,0) - COALESCE(b.taken_days,0))
        INTO _prior_available
        FROM public.leave_balances b
       WHERE b.organization_id = _org AND b.employee_id = _emp.id
         AND b.leave_type_id = _lt.id AND b.period_year = _yr - 1;

      _prior_available := COALESCE(_prior_available, 0);

      IF _lt.carry_forward THEN
        _carried := LEAST(_prior_available, COALESCE(_lt.max_carry_forward_days, _prior_available));
      ELSE
        _carried := 0;
      END IF;
      _expired := GREATEST(0, _prior_available - _carried);

      SELECT COALESCE(SUM(r.days) FILTER (WHERE r.status IN ('submitted','supervisor_approved')), 0),
             COALESCE(SUM(r.days) FILTER (WHERE r.status IN ('approved','taken')), 0)
        INTO _pending, _taken
        FROM public.leave_requests r
       WHERE r.organization_id = _org AND r.employee_id = _emp.id
         AND r.leave_type_id = _lt.id
         AND r.start_date BETWEEN _period_start AND _period_end;

      INSERT INTO public.leave_balances AS b (
        organization_id, employee_id, leave_type_id, period_year,
        entitlement_days, accrued_days, carried_forward_days, expired_days,
        pending_days, taken_days, last_calculated_at
      ) VALUES (
        _org, _emp.id, _lt.id, _yr,
        _entitlement, _accrued, _carried, _expired,
        _pending, _taken, now()
      )
      ON CONFLICT (employee_id, leave_type_id, period_year) DO UPDATE
        SET entitlement_days = EXCLUDED.entitlement_days,
            accrued_days = EXCLUDED.accrued_days,
            carried_forward_days = EXCLUDED.carried_forward_days,
            expired_days = EXCLUDED.expired_days,
            pending_days = EXCLUDED.pending_days,
            taken_days = EXCLUDED.taken_days,
            last_calculated_at = now(),
            updated_at = now();

      _rows := _rows + 1;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'period_year', _yr,
    'period_start', _period_start,
    'period_end', _period_end,
    'balances', _rows,
    'withdrawn', _removed
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_hr_leave_apply(_employee uuid, _leave_type uuid, _start date, _end date, _reason text DEFAULT ''::text, _handover text DEFAULT ''::text, _acting_employee uuid DEFAULT NULL::uuid, _document_path text DEFAULT NULL::text, _contact text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := current_org_id();
  _emp public.employees;
  _lt public.leave_types;
  _days numeric;
  _available numeric;
  _warnings jsonb := '[]'::jsonb;
  _ref text;
  _id uuid;
  _yr integer;
  _fit jsonb;
  _used integer;
BEGIN
  IF _org IS NULL THEN
    RAISE EXCEPTION 'No organisation context';
  END IF;

  SELECT * INTO _emp FROM public.employees WHERE id = _employee AND organization_id = _org;
  IF _emp.id IS NULL THEN
    RAISE EXCEPTION 'Employee record not found in this organisation';
  END IF;

  IF _emp.profile_id IS DISTINCT FROM auth.uid()
     AND NOT has_permission('hr-leave', 'approve') THEN
    RAISE EXCEPTION 'You may only apply for your own leave';
  END IF;

  SELECT * INTO _lt FROM public.leave_types WHERE id = _leave_type AND organization_id = _org AND active;
  IF _lt.id IS NULL THEN
    RAISE EXCEPTION 'Leave type not available';
  END IF;

  _fit := public.neo_hr_leave_applicability(_employee, _leave_type, _start);
  IF NOT COALESCE((_fit ->> 'eligible')::boolean, false) THEN
    RAISE EXCEPTION 'Not eligible for this leave policy: %',
      COALESCE(array_to_string(ARRAY(SELECT jsonb_array_elements_text(_fit -> 'reasons')), '; '), 'policy conditions not met');
  END IF;

  IF _end < _start THEN
    RAISE EXCEPTION 'The last day cannot fall before the first day';
  END IF;

  _days := public.neo_hr_leave_working_days(_leave_type, _start, _end, _emp.branch_id);
  IF _days <= 0 THEN
    RAISE EXCEPTION 'The selected dates contain no countable leave days under this policy';
  END IF;

  IF _lt.requires_document AND COALESCE(_document_path, '') = '' THEN
    RAISE EXCEPTION 'This leave type requires a supporting document';
  END IF;

  IF _lt.max_consecutive_days IS NOT NULL AND _days > _lt.max_consecutive_days THEN
    RAISE EXCEPTION 'This policy allows at most % consecutive days', _lt.max_consecutive_days;
  END IF;

  IF _lt.max_requests_per_year IS NOT NULL THEN
    SELECT count(*) INTO _used
      FROM public.leave_requests r
     WHERE r.organization_id = _org AND r.employee_id = _employee
       AND r.leave_type_id = _leave_type
       AND r.status IN ('submitted','supervisor_approved','approved','taken')
       AND EXTRACT(year FROM r.start_date)::int = EXTRACT(year FROM _start)::int;
    IF _used >= _lt.max_requests_per_year THEN
      RAISE EXCEPTION 'This policy allows at most % request(s) per leave year', _lt.max_requests_per_year;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.leave_requests r
     WHERE r.organization_id = _org AND r.employee_id = _employee
       AND r.status IN ('submitted','supervisor_approved','approved','taken')
       AND r.start_date <= _end AND r.end_date >= _start
  ) THEN
    RAISE EXCEPTION 'You already have a leave request covering these dates';
  END IF;

  IF _start - current_date < COALESCE(_lt.minimum_notice_days, 0) THEN
    _warnings := _warnings || jsonb_build_object(
      'code', 'short_notice',
      'detail', format('Policy asks for %s days notice; this request gives %s.',
                       _lt.minimum_notice_days, GREATEST(0, _start - current_date)));
  END IF;

  PERFORM public.neo_hr_leave_sync_entitlements(_employee, EXTRACT(year FROM _start)::int);

  SELECT GREATEST(0, COALESCE(entitlement_days,0) + COALESCE(carried_forward_days,0)
                   + COALESCE(adjustment_days,0) - COALESCE(taken_days,0) - COALESCE(pending_days,0))
    INTO _available
    FROM public.leave_balances
   WHERE organization_id = _org AND employee_id = _employee
     AND leave_type_id = _leave_type
     AND period_year = EXTRACT(year FROM _start)::int;

  _available := COALESCE(_available, 0);

  IF _days > _available THEN
    IF _lt.paid THEN
      RAISE EXCEPTION 'Requested % day(s) exceeds the available balance of % day(s)', _days, _available;
    END IF;
    _warnings := _warnings || jsonb_build_object(
      'code', 'over_balance',
      'detail', format('Requested %s day(s) against an available balance of %s.', _days, _available));
  END IF;

  _ref := 'LEV-' || to_char(current_date, 'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''), 1, 5));
  _yr := EXTRACT(year FROM _start)::int;

  INSERT INTO public.leave_requests (
    organization_id, employee_id, leave_type_id, branch_id, department_id,
    reference, start_date, end_date, days, reason, handover_notes,
    acting_employee_id, document_path, contact_while_away, status,
    balance_before, policy_warnings, supervisor_id
  ) VALUES (
    _org, _employee, _leave_type, _emp.branch_id, _emp.department_id,
    _ref, _start, _end, _days, COALESCE(_reason,''), COALESCE(_handover,''),
    _acting_employee, _document_path, COALESCE(_contact,''), 'submitted',
    _available, _warnings, _emp.reporting_manager_id
  ) RETURNING id INTO _id;

  UPDATE public.leave_balances
     SET pending_days = COALESCE(pending_days,0) + _days, updated_at = now()
   WHERE organization_id = _org AND employee_id = _employee
     AND leave_type_id = _leave_type AND period_year = _yr;

  INSERT INTO public.leave_transactions (
    organization_id, employee_id, leave_type_id, leave_request_id,
    period_year, movement, days, note, created_by
  ) VALUES (
    _org, _employee, _leave_type, _id, _yr, 'pending', _days, 'Leave applied for', auth.uid()
  );

  RETURN jsonb_build_object(
    'request_id', _id,
    'reference', _ref,
    'days', _days,
    'balance_before', _available,
    'warnings', _warnings
  );
END;
$function$;