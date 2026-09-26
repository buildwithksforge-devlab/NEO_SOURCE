CREATE OR REPLACE FUNCTION public.neo_hr_leave_sync_entitlements(_employee uuid DEFAULT NULL::uuid, _year integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := current_org_id();
  _yr integer := COALESCE(_year, EXTRACT(year FROM current_date)::int);
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
BEGIN
  IF _org IS NULL THEN
    RAISE EXCEPTION 'No organisation context';
  END IF;

  IF NOT (has_permission('hr-leave', 'self.view') OR has_permission('hr-leave', 'approve')) THEN
    RAISE EXCEPTION 'Not authorised to calculate leave entitlement';
  END IF;

  FOR _emp IN
    SELECT e.id, e.employment_date, e.branch_id, e.employment_status
      FROM public.employees e
     WHERE e.organization_id = _org
       AND (_employee IS NULL OR e.id = _employee)
       AND e.employment_status <> 'exited'
  LOOP
    FOR _lt IN
      SELECT * FROM public.leave_types
       WHERE organization_id = _org AND active
         AND (branch_id IS NULL OR _emp.branch_id IS NULL OR branch_id = _emp.branch_id)
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
            EXTRACT(month FROM LEAST(current_date, make_date(_yr, 12, 31)))
            - CASE WHEN COALESCE(_emp.employment_date, make_date(_yr,1,1)) > make_date(_yr, 1, 1)
                   THEN EXTRACT(month FROM _emp.employment_date) - 1 ELSE 0 END
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
         AND EXTRACT(year FROM r.start_date)::int = _yr;

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

  RETURN jsonb_build_object('period_year', _yr, 'balances', _rows);
END;
$function$;