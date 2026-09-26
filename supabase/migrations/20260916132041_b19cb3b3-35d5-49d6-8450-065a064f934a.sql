CREATE TABLE IF NOT EXISTS public.staff_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  branch_id uuid,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  profile_id uuid,
  card_number text NOT NULL,
  status text NOT NULL DEFAULT 'issued',
  issued_on date NOT NULL DEFAULT current_date,
  issued_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, card_number)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_cards TO authenticated;
GRANT ALL ON public.staff_cards TO service_role;
ALTER TABLE public.staff_cards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_cards_read" ON public.staff_cards;
CREATE POLICY "staff_cards_read" ON public.staff_cards
  FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id());

DROP POLICY IF EXISTS "staff_cards_write" ON public.staff_cards;
CREATE POLICY "staff_cards_write" ON public.staff_cards
  FOR ALL TO authenticated
  USING (organization_id = public.current_org_id()
         AND (public.has_permission('administration','users','edit') OR public.is_org_admin_for(organization_id)))
  WITH CHECK (organization_id = public.current_org_id()
         AND (public.has_permission('administration','users','edit') OR public.is_org_admin_for(organization_id)));

CREATE INDEX IF NOT EXISTS staff_cards_employee_idx ON public.staff_cards(employee_id);

DROP TRIGGER IF EXISTS staff_cards_touch ON public.staff_cards;
CREATE TRIGGER staff_cards_touch BEFORE UPDATE ON public.staff_cards
  FOR EACH ROW EXECUTE FUNCTION public.fin_touch_updated_at();

-- Onboarding: HR number, employee record linked to the property, staff card.
CREATE OR REPLACE FUNCTION public.neo_onboard_staff(
  _profile uuid,
  _employment_date date DEFAULT current_date,
  _issue_card boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  _org uuid := public.current_org_id();
  _p public.profiles;
  _emp public.employees;
  _number text;
  _card public.staff_cards;
BEGIN
  IF _org IS NULL THEN RAISE EXCEPTION 'No organisation context'; END IF;
  IF NOT (public.has_permission('administration','users','create') OR public.is_org_admin()) THEN
    RAISE EXCEPTION 'You are not permitted to onboard staff';
  END IF;

  SELECT * INTO _p FROM public.profiles WHERE id = _profile AND organization_id = _org;
  IF _p.id IS NULL THEN RAISE EXCEPTION 'That staff account is not in your organisation'; END IF;

  SELECT * INTO _emp FROM public.employees WHERE profile_id = _p.id AND organization_id = _org LIMIT 1;

  IF _emp.id IS NULL THEN
    _number := public.neo_allocate_employee_number(_org);
    INSERT INTO public.employees(
      organization_id, profile_id, employee_number, full_name, avatar_url, phone,
      work_email, branch_id, department_id, station_id, job_title,
      employment_status, employment_date, created_by)
    VALUES (_org, _p.id, _number, _p.full_name, _p.avatar_url, coalesce(_p.phone,''),
            coalesce(_p.email,''), _p.branch_id, _p.department_id, _p.station_id,
            coalesce(_p.job_title,''), coalesce(_p.employment_status,'active'),
            coalesce(_employment_date, current_date), auth.uid())
    RETURNING * INTO _emp;
  ELSE
    IF _emp.employee_number IS NULL OR btrim(_emp.employee_number) = '' THEN
      _number := public.neo_allocate_employee_number(_org);
    ELSE
      _number := _emp.employee_number;
    END IF;
    UPDATE public.employees
       SET employee_number = _number,
           branch_id = coalesce(_p.branch_id, branch_id),
           department_id = coalesce(_p.department_id, department_id),
           job_title = CASE WHEN coalesce(_p.job_title,'') <> '' THEN _p.job_title ELSE job_title END,
           employment_date = coalesce(employment_date, _employment_date, current_date),
           updated_at = now()
     WHERE id = _emp.id
     RETURNING * INTO _emp;
  END IF;

  IF _issue_card THEN
    SELECT * INTO _card FROM public.staff_cards
     WHERE employee_id = _emp.id AND organization_id = _org AND status = 'issued' LIMIT 1;
    IF _card.id IS NULL THEN
      INSERT INTO public.staff_cards(organization_id, branch_id, employee_id, profile_id,
                                     card_number, issued_by)
      VALUES (_org, _emp.branch_id, _emp.id, _p.id,
              'CARD-' || replace(_emp.employee_number, 'EMP-', ''), auth.uid())
      RETURNING * INTO _card;
    END IF;
  END IF;

  INSERT INTO public.audit_logs(organization_id, branch_id, user_id, action, module, record_id, new_value)
  VALUES (_org, _emp.branch_id, auth.uid(), 'hr.staff.onboarded', 'human-resources', _emp.id,
          jsonb_build_object('employee_number', _emp.employee_number,
                             'profile_id', _p.id,
                             'branch_id', _emp.branch_id,
                             'card_number', _card.card_number));

  RETURN jsonb_build_object('ok', true, 'employee_id', _emp.id,
                            'employee_number', _emp.employee_number,
                            'branch_id', _emp.branch_id,
                            'card_number', _card.card_number);
END; $$;

REVOKE ALL ON FUNCTION public.neo_onboard_staff(uuid, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_onboard_staff(uuid, date, boolean) TO authenticated;

-- Inactive or suspended accounts hold no roles until reactivated.
CREATE OR REPLACE FUNCTION public.current_user_role_ids()
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT CASE WHEN public.is_active_staff() THEN
    COALESCE((SELECT array_agg(ur.role_id) FROM public.user_roles ur
               WHERE ur.user_id = auth.uid()
                 AND ur.organization_id = public.current_org_id()), '{}'::uuid[])
  ELSE '{}'::uuid[] END
$$;

-- An assigner may not hand out authority they do not themselves hold.
CREATE OR REPLACE FUNCTION public.neo_validate_role_assignment(_branch uuid, _department uuid, _role_ids uuid[])
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid := public.current_org_id();
  v_dept_key text;
  v_dept_branch uuid;
  v_dept_name text;
  r record;
  v_role_dept_key text;
  v_scope text;
  v_assigner_wide boolean;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'No organisation context';
  END IF;

  v_assigner_wide := public.is_org_admin() OR EXISTS (
    SELECT 1 FROM public.user_roles ur
      JOIN public.roles ro ON ro.id = ur.role_id
     WHERE ur.user_id = auth.uid()
       AND ur.organization_id = v_org
       AND coalesce(ro.access_scope,'') IN ('organisation','technical'));

  IF _department IS NOT NULL THEN
    SELECT public.neo_department_identity(d.catalogue_key, d.name), d.branch_id, d.name
      INTO v_dept_key, v_dept_branch, v_dept_name
      FROM public.departments d
     WHERE d.id = _department AND d.organization_id = v_org;
    IF v_dept_name IS NULL THEN
      RAISE EXCEPTION 'That department does not belong to your organisation';
    END IF;
    IF v_dept_branch IS NOT NULL AND _branch IS NOT NULL AND v_dept_branch <> _branch THEN
      RAISE EXCEPTION 'Department % belongs to another property', v_dept_name;
    END IF;
  END IF;

  FOR r IN
    SELECT ro.id, ro.name, ro.active, ro.role_status, ro.access_scope,
           ro.department_id, ro.normalized_role_key,
           rc.access_scope AS cat_scope, rc.department AS cat_dept, rc.retired AS cat_retired
      FROM public.roles ro
      LEFT JOIN public.role_catalogue rc ON rc.role_key = ro.normalized_role_key
     WHERE ro.id = ANY(coalesce(_role_ids, '{}'::uuid[]))
       AND ro.organization_id = v_org
  LOOP
    IF r.active IS NOT TRUE OR r.role_status = 'archived' OR coalesce(r.cat_retired, false) THEN
      RAISE EXCEPTION 'Role % is no longer part of the role model', r.name;
    END IF;

    v_scope := coalesce(r.access_scope, r.cat_scope);

    IF v_scope IN ('organisation', 'technical') THEN
      IF NOT v_assigner_wide THEN
        RAISE EXCEPTION 'You are not permitted to assign the organisation-wide role %', r.name;
      END IF;
      CONTINUE;
    END IF;

    SELECT public.neo_department_identity(d.catalogue_key, d.name) INTO v_role_dept_key
      FROM public.departments d
     WHERE d.id = r.department_id;

    IF v_role_dept_key IS NULL THEN
      v_role_dept_key := public.neo_department_identity(NULL, r.cat_dept);
    END IF;

    IF v_role_dept_key IS NULL THEN
      CONTINUE;
    END IF;

    IF _department IS NULL THEN
      RAISE EXCEPTION 'Role % requires a department to be selected', r.name;
    END IF;

    IF v_dept_key IS DISTINCT FROM v_role_dept_key THEN
      RAISE EXCEPTION 'Role % does not belong to department %', r.name, v_dept_name;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM public.roles
       WHERE id = ANY(coalesce(_role_ids, '{}'::uuid[])) AND organization_id = v_org)
     <> coalesce(array_length(_role_ids, 1), 0) THEN
    RAISE EXCEPTION 'One of the selected roles does not belong to your organisation';
  END IF;

  RETURN jsonb_build_object('ok', true, 'department_key', v_dept_key,
                            'role_count', coalesce(array_length(_role_ids, 1), 0));
END;
$function$;
