
-- 1. Leave policy fields ---------------------------------------------------
ALTER TABLE public.leave_types
  ADD COLUMN IF NOT EXISTS counts_weekends boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS counts_public_holidays boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS approval_route text NOT NULL DEFAULT 'supervisor_then_hr',
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS eligibility_months integer NOT NULL DEFAULT 0;

-- 2. Leave request lifecycle -----------------------------------------------
ALTER TABLE public.leave_requests
  ADD COLUMN IF NOT EXISTS returned_at timestamptz,
  ADD COLUMN IF NOT EXISTS returned_by uuid,
  ADD COLUMN IF NOT EXISTS return_note text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid,
  ADD COLUMN IF NOT EXISTS cancellation_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS taken_marked_at timestamptz,
  ADD COLUMN IF NOT EXISTS policy_warnings jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 3. Balance detail ---------------------------------------------------------
ALTER TABLE public.leave_balances
  ADD COLUMN IF NOT EXISTS accrued_days numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expired_days numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_calculated_at timestamptz;

-- 4. Document versioning ----------------------------------------------------
ALTER TABLE public.employee_documents
  ADD COLUMN IF NOT EXISTS supersedes_document_id uuid REFERENCES public.employee_documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS document_date date;

CREATE INDEX IF NOT EXISTS employee_documents_supersedes_idx
  ON public.employee_documents(supersedes_document_id);

-- 5. Probation start --------------------------------------------------------
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS probation_start_date date;

-- 6. Public holidays --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.public_holidays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  holiday_date date NOT NULL,
  name text NOT NULL,
  observed boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS public_holidays_unique_idx
  ON public.public_holidays(organization_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), holiday_date);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.public_holidays TO authenticated;
GRANT ALL ON public.public_holidays TO service_role;

ALTER TABLE public.public_holidays ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Workspace can read holidays" ON public.public_holidays;
CREATE POLICY "Workspace can read holidays" ON public.public_holidays
  FOR SELECT TO authenticated
  USING (organization_id = current_org_id());

DROP POLICY IF EXISTS "HR maintains holidays" ON public.public_holidays;
CREATE POLICY "HR maintains holidays" ON public.public_holidays
  FOR ALL TO authenticated
  USING (organization_id = current_org_id() AND has_permission('hr-leave', 'configure'))
  WITH CHECK (organization_id = current_org_id() AND has_permission('hr-leave', 'configure'));

CREATE OR REPLACE FUNCTION public.hr_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS public_holidays_touch ON public.public_holidays;
CREATE TRIGGER public_holidays_touch BEFORE UPDATE ON public.public_holidays
  FOR EACH ROW EXECUTE FUNCTION public.hr_touch_updated_at();

-- 7. Working-day calculation ------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_hr_leave_working_days(
  _leave_type uuid,
  _from date,
  _to date,
  _branch uuid DEFAULT NULL
) RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _org uuid := current_org_id();
  _t public.leave_types;
  _d date;
  _days numeric := 0;
BEGIN
  IF _org IS NULL OR _from IS NULL OR _to IS NULL OR _to < _from THEN
    RETURN 0;
  END IF;

  SELECT * INTO _t FROM public.leave_types
   WHERE id = _leave_type AND organization_id = _org;

  IF _t.id IS NULL THEN
    RETURN 0;
  END IF;

  _d := _from;
  WHILE _d <= _to LOOP
    IF (_t.counts_weekends OR EXTRACT(isodow FROM _d) < 6)
       AND (_t.counts_public_holidays OR NOT EXISTS (
              SELECT 1 FROM public.public_holidays h
               WHERE h.organization_id = _org
                 AND h.observed
                 AND h.holiday_date = _d
                 AND (h.branch_id IS NULL OR _branch IS NULL OR h.branch_id = _branch)))
    THEN
      _days := _days + 1;
    END IF;
    _d := _d + 1;
  END LOOP;

  RETURN _days;
END;
$$;

-- 8. Entitlement synchronisation --------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_hr_leave_sync_entitlements(
  _employee uuid DEFAULT NULL,
  _year integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
      _service_months := GREATEST(0, EXTRACT(epoch FROM (current_date - COALESCE(_emp.employment_date, current_date))) / 2629800.0);

      IF _service_months < COALESCE(_lt.eligibility_months, 0) THEN
        _entitlement := 0;
        _accrued := 0;
      ELSIF _lt.accrual_method = 'monthly' THEN
        -- months of the leave year already served
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

      -- carry forward from the previous leave year
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

      -- days already committed this leave year, derived from the requests themselves
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
$$;

-- 9. Leave application ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_hr_leave_apply(
  _employee uuid,
  _leave_type uuid,
  _start date,
  _end date,
  _reason text DEFAULT '',
  _handover text DEFAULT '',
  _acting_employee uuid DEFAULT NULL,
  _document_path text DEFAULT NULL,
  _contact text DEFAULT ''
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
    organization_id, employee_id, leave_type_id, leave_request_id, period_year,
    transaction_type, days, reason, idempotency_key, created_by
  ) VALUES (
    _org, _employee, _leave_type, _id, _yr,
    'requested', _days, COALESCE(_reason,''), 'leave-requested-' || _id::text, auth.uid()
  ) ON CONFLICT DO NOTHING;

  PERFORM public.log_audit_event(
    _org, 'hr.leave.requested', 'human-resources', _id::text,
    NULL,
    jsonb_build_object('reference', _ref, 'days', _days, 'leave_type', _lt.name,
                       'start', _start, 'end', _end, 'warnings', _warnings),
    COALESCE(_reason, '')
  );

  RETURN jsonb_build_object(
    'request_id', _id, 'reference', _ref, 'days', _days,
    'available_before', _available, 'available_after', GREATEST(0, _available - _days),
    'warnings', _warnings
  );
END;
$$;

-- 10. Leave decision --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_hr_leave_decide(
  _request uuid,
  _decision text,
  _note text DEFAULT ''
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _org uuid := current_org_id();
  _r public.leave_requests;
  _emp public.employees;
  _yr integer;
  _prev text;
  _status text;
BEGIN
  IF _org IS NULL THEN
    RAISE EXCEPTION 'No organisation context';
  END IF;

  IF _decision NOT IN ('approve','reject','return','cancel','taken') THEN
    RAISE EXCEPTION 'Unknown leave decision';
  END IF;

  SELECT * INTO _r FROM public.leave_requests WHERE id = _request AND organization_id = _org;
  IF _r.id IS NULL THEN
    RAISE EXCEPTION 'Leave request not found in this organisation';
  END IF;

  SELECT * INTO _emp FROM public.employees WHERE id = _r.employee_id;

  IF _decision = 'cancel' THEN
    IF _emp.profile_id IS DISTINCT FROM auth.uid() AND NOT has_permission('hr-leave','approve') THEN
      RAISE EXCEPTION 'Not authorised to cancel this request';
    END IF;
  ELSIF NOT has_permission('hr-leave', 'approve') THEN
    RAISE EXCEPTION 'Not authorised to decide leave requests';
  END IF;

  IF _r.status IN ('approved','rejected','cancelled','taken') AND _decision <> 'taken' THEN
    RAISE EXCEPTION 'This request has already been decided';
  END IF;

  _prev := _r.status;
  _yr := EXTRACT(year FROM _r.start_date)::int;
  _status := CASE _decision
               WHEN 'approve' THEN 'approved'
               WHEN 'reject'  THEN 'rejected'
               WHEN 'return'  THEN 'returned'
               WHEN 'cancel'  THEN 'cancelled'
               ELSE 'taken' END;

  UPDATE public.leave_requests
     SET status = _status,
         decision_note = CASE WHEN _decision IN ('approve','reject') THEN COALESCE(_note,'') ELSE decision_note END,
         return_note = CASE WHEN _decision = 'return' THEN COALESCE(_note,'') ELSE return_note END,
         returned_at = CASE WHEN _decision = 'return' THEN now() ELSE returned_at END,
         returned_by = CASE WHEN _decision = 'return' THEN auth.uid() ELSE returned_by END,
         cancellation_reason = CASE WHEN _decision = 'cancel' THEN COALESCE(_note,'') ELSE cancellation_reason END,
         cancelled_at = CASE WHEN _decision = 'cancel' THEN now() ELSE cancelled_at END,
         cancelled_by = CASE WHEN _decision = 'cancel' THEN auth.uid() ELSE cancelled_by END,
         taken_marked_at = CASE WHEN _decision = 'taken' THEN now() ELSE taken_marked_at END,
         approved_by = CASE WHEN _decision = 'approve' THEN auth.uid() ELSE approved_by END,
         approved_at = CASE WHEN _decision = 'approve' THEN now() ELSE approved_at END,
         posted = CASE WHEN _decision = 'approve' THEN true ELSE posted END,
         updated_at = now()
   WHERE id = _r.id;

  IF _decision IN ('approve','reject','cancel') THEN
    INSERT INTO public.leave_transactions (
      organization_id, employee_id, leave_type_id, leave_request_id, period_year,
      transaction_type, days, reason, idempotency_key, created_by
    ) VALUES (
      _org, _r.employee_id, _r.leave_type_id, _r.id, _yr,
      CASE WHEN _decision = 'approve' THEN 'taken' ELSE 'released' END,
      CASE WHEN _decision = 'approve' THEN -abs(_r.days) ELSE abs(_r.days) END,
      COALESCE(_note,''),
      'leave-' || _decision || '-' || _r.id::text,
      auth.uid()
    ) ON CONFLICT DO NOTHING;
  END IF;

  PERFORM public.neo_hr_leave_sync_entitlements(_r.employee_id, _yr);

  PERFORM public.log_audit_event(
    _org, 'hr.leave.' || _status, 'human-resources', _r.id::text,
    jsonb_build_object('status', _prev),
    jsonb_build_object('status', _status, 'days', _r.days, 'reference', _r.reference),
    COALESCE(_note, '')
  );

  RETURN jsonb_build_object('request_id', _r.id, 'status', _status, 'days', _r.days);
END;
$$;
