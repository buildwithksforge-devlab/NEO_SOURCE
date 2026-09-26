-- Exported verbatim from the deployed database (public.neo_hr_offboard_employee).
-- Employment history survives account removal because employees.profile_id is
-- ON DELETE SET NULL; this routine never deletes an employee record.

CREATE OR REPLACE FUNCTION public.neo_hr_offboard_employee(_employee uuid, _last_working_day date DEFAULT NULL::date, _separation_type text DEFAULT 'resignation'::text, _reason text DEFAULT NULL::text, _revoke_access boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid := current_org_id();
  _emp public.employees;
  _prev text;
  _roles_removed int := 0;
  _account_closed boolean := false;
  _lwd date := COALESCE(_last_working_day, current_date);
BEGIN
  IF _org IS NULL THEN
    RAISE EXCEPTION 'No organisation context';
  END IF;

  IF NOT has_permission('hr-employees', 'edit') THEN
    RAISE EXCEPTION 'Not authorised to offboard an employee';
  END IF;

  SELECT * INTO _emp FROM public.employees
   WHERE id = _employee AND organization_id = _org;

  IF _emp.id IS NULL THEN
    RAISE EXCEPTION 'Employee record not found in this organisation';
  END IF;

  IF _emp.employment_status = 'exited' THEN
    RETURN jsonb_build_object(
      'employee_id', _emp.id,
      'already_exited', true,
      'roles_removed', 0,
      'account_closed', false
    );
  END IF;

  _prev := _emp.employment_status;

  UPDATE public.employees
     SET employment_status = 'exited',
         contract_end = COALESCE(contract_end, _lwd),
         system_access_status = CASE WHEN _revoke_access THEN 'revoked' ELSE system_access_status END,
         payroll_status = 'not_ready',
         notes = trim(both E'\n' from COALESCE(notes, '') || E'\n' ||
                 'Offboarded ' || to_char(_lwd, 'YYYY-MM-DD') || ' (' || _separation_type || ')' ||
                 COALESCE(': ' || _reason, '')),
         updated_at = now()
   WHERE id = _emp.id;

  -- System access is removed, the HR record is not.
  IF _revoke_access AND _emp.profile_id IS NOT NULL THEN
    WITH removed AS (
      DELETE FROM public.user_roles
       WHERE user_id = _emp.profile_id AND organization_id = _org
      RETURNING 1
    )
    SELECT count(*) INTO _roles_removed FROM removed;

    UPDATE public.profiles
       SET account_status = 'inactive',
           employment_status = 'exited',
           updated_at = now()
     WHERE id = _emp.profile_id AND organization_id = _org;

    _account_closed := true;
  END IF;

  INSERT INTO public.employment_history (
    organization_id, employee_id, change_type, previous_value, new_value,
    effective_date, reason, requested_by
  ) VALUES (
    _org, _emp.id, 'separation',
    jsonb_build_object('employment_status', _prev),
    jsonb_build_object('employment_status', 'exited', 'separation_type', _separation_type),
    _lwd, _reason, auth.uid()
  );

  INSERT INTO public.employee_exit_clearances (
    organization_id, employee_id, separation_type, notice_date, last_working_day,
    it_access_revoked, status
  ) VALUES (
    _org, _emp.id, _separation_type, current_date, _lwd,
    _revoke_access, 'in_progress'
  )
  ON CONFLICT DO NOTHING;

  PERFORM public.log_audit_event(
    _org, 'hr.employee.offboarded', 'human-resources', _emp.id::text,
    jsonb_build_object('employment_status', _prev),
    jsonb_build_object('employment_status', 'exited', 'separation_type', _separation_type,
                       'roles_removed', _roles_removed, 'access_revoked', _revoke_access),
    _reason
  );

  RETURN jsonb_build_object(
    'employee_id', _emp.id,
    'already_exited', false,
    'roles_removed', _roles_removed,
    'account_closed', _account_closed,
    'last_working_day', _lwd
  );
END;
$function$;
