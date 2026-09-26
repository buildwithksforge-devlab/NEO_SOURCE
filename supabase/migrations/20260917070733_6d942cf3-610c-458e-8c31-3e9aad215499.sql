-- 1. Company position grades -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.position_grades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL DEFAULT current_org_id(),
  code text NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS position_grades_org_code_key
  ON public.position_grades (organization_id, lower(code));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.position_grades TO authenticated;
GRANT ALL ON public.position_grades TO service_role;

ALTER TABLE public.position_grades ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS position_grades_read ON public.position_grades;
CREATE POLICY position_grades_read ON public.position_grades
  FOR SELECT TO authenticated
  USING (organization_id = current_org_id());

DROP POLICY IF EXISTS position_grades_write ON public.position_grades;
CREATE POLICY position_grades_write ON public.position_grades
  FOR ALL TO authenticated
  USING (
    organization_id = current_org_id()
    AND (public.has_permission('human-resources','employees','edit') OR public.is_org_admin_for(organization_id))
  )
  WITH CHECK (
    organization_id = current_org_id()
    AND (public.has_permission('human-resources','employees','edit') OR public.is_org_admin_for(organization_id))
  );

DROP TRIGGER IF EXISTS position_grades_touch ON public.position_grades;
CREATE TRIGGER position_grades_touch
  BEFORE UPDATE ON public.position_grades
  FOR EACH ROW EXECUTE FUNCTION public.hr_touch_updated_at();

-- 2. Leave policy applicability ----------------------------------------------
ALTER TABLE public.leave_types
  ADD COLUMN IF NOT EXISTS gender_scope text NOT NULL DEFAULT 'any';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leave_types_gender_scope_check'
  ) THEN
    ALTER TABLE public.leave_types
      ADD CONSTRAINT leave_types_gender_scope_check
      CHECK (gender_scope IN ('any','female','male'));
  END IF;
END $$;

-- 3. Establish employment terms ----------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_hr_employment_terms(
  _employee uuid,
  _employment_date date DEFAULT NULL,
  _employment_type text DEFAULT NULL,
  _position_grade text DEFAULT NULL,
  _contract_start date DEFAULT NULL,
  _contract_end date DEFAULT NULL,
  _probation_start date DEFAULT NULL,
  _probation_end date DEFAULT NULL,
  _reporting_manager uuid DEFAULT NULL,
  _department uuid DEFAULT NULL,
  _branch uuid DEFAULT NULL,
  _station uuid DEFAULT NULL,
  _job_title text DEFAULT NULL,
  _gender text DEFAULT NULL,
  _reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := current_org_id();
  v_emp public.employees;
  v_prev jsonb;
  v_next jsonb;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'No organisation context';
  END IF;
  IF NOT (public.has_permission('human-resources','employees','edit') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to change employment records';
  END IF;

  SELECT * INTO v_emp FROM public.employees
   WHERE id = _employee AND organization_id = v_org FOR UPDATE;
  IF v_emp.id IS NULL THEN RAISE EXCEPTION 'Unknown employee'; END IF;

  IF _gender IS NOT NULL AND _gender <> '' AND _gender NOT IN ('female','male','other','undisclosed') THEN
    RAISE EXCEPTION 'Unknown gender value';
  END IF;
  IF _contract_end IS NOT NULL AND _contract_start IS NOT NULL AND _contract_end < _contract_start THEN
    RAISE EXCEPTION 'Contract expiry cannot fall before the contract start';
  END IF;
  IF _probation_end IS NOT NULL AND _probation_start IS NOT NULL AND _probation_end < _probation_start THEN
    RAISE EXCEPTION 'Probation end cannot fall before the probation start';
  END IF;
  IF _reporting_manager IS NOT NULL AND _reporting_manager = _employee THEN
    RAISE EXCEPTION 'An employee cannot report to themselves';
  END IF;
  IF _position_grade IS NOT NULL AND btrim(_position_grade) <> '' AND NOT EXISTS (
    SELECT 1 FROM public.position_grades g
     WHERE g.organization_id = v_org AND g.active AND lower(g.code) = lower(btrim(_position_grade))
  ) THEN
    RAISE EXCEPTION 'That position grade is not configured for this organisation';
  END IF;

  v_prev := jsonb_build_object(
    'employment_date', v_emp.employment_date,
    'employment_type', v_emp.employment_type,
    'position_grade', v_emp.position_grade,
    'contract_start', v_emp.contract_start,
    'contract_end', v_emp.contract_end,
    'probation_start_date', v_emp.probation_start_date,
    'probation_end_date', v_emp.probation_end_date,
    'reporting_manager_id', v_emp.reporting_manager_id,
    'department_id', v_emp.department_id,
    'branch_id', v_emp.branch_id,
    'station_id', v_emp.station_id,
    'job_title', v_emp.job_title);

  UPDATE public.employees SET
    employment_date = COALESCE(_employment_date, employment_date),
    employment_type = COALESCE(NULLIF(btrim(COALESCE(_employment_type,'')),''), employment_type),
    position_grade = COALESCE(NULLIF(btrim(COALESCE(_position_grade,'')),''), position_grade),
    contract_start = COALESCE(_contract_start, contract_start),
    contract_end = CASE WHEN _contract_end IS NULL THEN contract_end ELSE _contract_end END,
    probation_start_date = COALESCE(_probation_start, probation_start_date),
    probation_end_date = COALESCE(_probation_end, probation_end_date),
    reporting_manager_id = COALESCE(_reporting_manager, reporting_manager_id),
    department_id = COALESCE(_department, department_id),
    branch_id = COALESCE(_branch, branch_id),
    station_id = COALESCE(_station, station_id),
    job_title = COALESCE(NULLIF(btrim(COALESCE(_job_title,'')),''), job_title),
    gender = COALESCE(NULLIF(btrim(COALESCE(_gender,'')),''), gender),
    updated_at = now()
  WHERE id = _employee
  RETURNING jsonb_build_object(
    'employment_date', employment_date,
    'employment_type', employment_type,
    'position_grade', position_grade,
    'contract_start', contract_start,
    'contract_end', contract_end,
    'probation_start_date', probation_start_date,
    'probation_end_date', probation_end_date,
    'reporting_manager_id', reporting_manager_id,
    'department_id', department_id,
    'branch_id', branch_id,
    'station_id', station_id,
    'job_title', job_title)
  INTO v_next;

  IF v_emp.profile_id IS NOT NULL THEN
    UPDATE public.profiles
       SET branch_id = COALESCE(_branch, branch_id),
           department_id = COALESCE(_department, department_id),
           job_title = COALESCE(NULLIF(btrim(COALESCE(_job_title,'')),''), job_title),
           updated_at = now()
     WHERE id = v_emp.profile_id;
  END IF;

  IF v_prev IS DISTINCT FROM v_next THEN
    INSERT INTO public.employment_history
      (organization_id, employee_id, change_type, previous_value, new_value, effective_date, reason, requested_by)
    VALUES (v_org, _employee, 'employment-terms', v_prev, v_next,
            COALESCE(_employment_date, v_emp.employment_date, current_date),
            COALESCE(_reason, 'Employment terms established'), auth.uid());
  END IF;

  RETURN jsonb_build_object('ok', true, 'employee_id', _employee, 'previous', v_prev, 'current', v_next);
END $function$;

REVOKE ALL ON FUNCTION public.neo_hr_employment_terms(uuid,date,text,text,date,date,date,date,uuid,uuid,uuid,uuid,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_hr_employment_terms(uuid,date,text,text,date,date,date,date,uuid,uuid,uuid,uuid,text,text,text) TO authenticated;

-- 4. Movements carry the position grade --------------------------------------
CREATE OR REPLACE FUNCTION public.neo_hr_employee_movement(
  _employee uuid,
  _change_type text,
  _effective_date date DEFAULT CURRENT_DATE,
  _reason text DEFAULT NULL::text,
  _branch uuid DEFAULT NULL::uuid,
  _department uuid DEFAULT NULL::uuid,
  _job_title text DEFAULT NULL::text,
  _reporting_manager uuid DEFAULT NULL::uuid,
  _employment_status text DEFAULT NULL::text,
  _position_grade text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := current_org_id();
  v_emp record;
  v_prev jsonb;
  v_next jsonb;
BEGIN
  IF NOT (public.has_permission('human-resources','employees','edit') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'Not permitted to change employment records';
  END IF;
  IF _change_type NOT IN ('promotion','transfer','role-change','status-change','confirmation') THEN
    RAISE EXCEPTION 'Unknown employment change type';
  END IF;

  SELECT * INTO v_emp FROM public.employees
   WHERE id = _employee AND organization_id = v_org FOR UPDATE;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'Unknown employee'; END IF;

  IF _position_grade IS NOT NULL AND btrim(_position_grade) <> '' AND NOT EXISTS (
    SELECT 1 FROM public.position_grades g
     WHERE g.organization_id = v_org AND g.active AND lower(g.code) = lower(btrim(_position_grade))
  ) THEN
    RAISE EXCEPTION 'That position grade is not configured for this organisation';
  END IF;

  v_prev := jsonb_build_object(
    'branch_id', v_emp.branch_id, 'department_id', v_emp.department_id,
    'job_title', v_emp.job_title, 'reporting_manager_id', v_emp.reporting_manager_id,
    'position_grade', v_emp.position_grade,
    'employment_status', v_emp.employment_status);

  UPDATE public.employees SET
    branch_id = coalesce(_branch, branch_id),
    department_id = coalesce(_department, department_id),
    job_title = coalesce(nullif(trim(coalesce(_job_title,'')),''), job_title),
    position_grade = coalesce(nullif(trim(coalesce(_position_grade,'')),''), position_grade),
    reporting_manager_id = coalesce(_reporting_manager, reporting_manager_id),
    employment_status = coalesce(nullif(trim(coalesce(_employment_status,'')),''), employment_status),
    updated_at = now()
  WHERE id = _employee
  RETURNING jsonb_build_object(
    'branch_id', branch_id, 'department_id', department_id, 'job_title', job_title,
    'reporting_manager_id', reporting_manager_id, 'position_grade', position_grade,
    'employment_status', employment_status)
  INTO v_next;

  IF v_emp.profile_id IS NOT NULL THEN
    UPDATE public.profiles
       SET branch_id = coalesce(_branch, branch_id),
           department_id = coalesce(_department, department_id),
           job_title = coalesce(nullif(trim(coalesce(_job_title,'')),''), job_title),
           updated_at = now()
     WHERE id = v_emp.profile_id;
  END IF;

  INSERT INTO public.employment_history
    (organization_id, employee_id, change_type, previous_value, new_value, effective_date, reason, requested_by)
  VALUES (v_org, _employee, _change_type, v_prev, v_next, coalesce(_effective_date, current_date), _reason, auth.uid());

  RETURN jsonb_build_object('ok', true, 'employee_id', _employee,
    'previous', v_prev, 'current', v_next,
    'access_review_required', (v_prev->>'department_id') IS DISTINCT FROM (v_next->>'department_id')
                              OR (v_prev->>'job_title') IS DISTINCT FROM (v_next->>'job_title'));
END $function$;

REVOKE ALL ON FUNCTION public.neo_hr_employee_movement(uuid,text,date,text,uuid,uuid,text,uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_hr_employee_movement(uuid,text,date,text,uuid,uuid,text,uuid,text,text) TO authenticated;

-- 5. Leave applicability enforced on application -----------------------------
CREATE OR REPLACE FUNCTION public.neo_hr_leave_gender_allowed(_employee uuid, _leave_type uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN lt.gender_scope IS NULL OR lt.gender_scope = 'any' THEN true
    WHEN e.gender IS NULL OR btrim(e.gender) = '' THEN true
    ELSE lower(btrim(e.gender)) = lt.gender_scope
  END
  FROM public.leave_types lt
  JOIN public.employees e ON e.id = _employee
 WHERE lt.id = _leave_type
$function$;

REVOKE ALL ON FUNCTION public.neo_hr_leave_gender_allowed(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_hr_leave_gender_allowed(uuid,uuid) TO authenticated;