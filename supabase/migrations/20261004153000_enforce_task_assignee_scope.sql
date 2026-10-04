-- Enforce the same Property -> Department -> Worker relationship at the
-- database boundary that the Tasks UI now enforces in its selectors.
--
-- Existing unassigned tasks remain valid. A task cannot acquire or retain an
-- assignee while its branch / department relationship is invalid.

CREATE OR REPLACE FUNCTION public.neo_validate_task_assignee_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_department_key text;
  v_profile public.profiles;
  v_employee public.employees;
  v_role_ok boolean;
BEGIN
  -- Unassigned tasks do not require worker validation.
  IF NEW.assignee_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'Task organisation is required before assignment';
  END IF;

  IF NEW.branch_id IS NULL THEN
    RAISE EXCEPTION 'Select the property before assigning this task';
  END IF;

  IF NEW.department_id IS NULL THEN
    RAISE EXCEPTION 'Select the department before assigning this task';
  END IF;

  -- The selected department itself must belong to this organisation/property.
  SELECT coalesce(
           nullif(btrim(coalesce(d.catalogue_key, '')), ''),
           public.neo_department_catalogue_key(d.name),
           lower(btrim(d.name))
         )
    INTO v_department_key
    FROM public.departments d
   WHERE d.id = NEW.department_id
     AND d.organization_id = NEW.organization_id
     AND coalesce(d.active, true)
     AND coalesce(d.department_status, 'active') <> 'archived'
     AND (d.branch_id IS NULL OR d.branch_id = NEW.branch_id);

  IF v_department_key IS NULL THEN
    RAISE EXCEPTION 'That department is not active for the selected property';
  END IF;

  -- Assignee must be an active staff profile in the same organisation.
  SELECT *
    INTO v_profile
    FROM public.profiles p
   WHERE p.id = NEW.assignee_id
     AND p.organization_id = NEW.organization_id;

  IF v_profile.id IS NULL THEN
    RAISE EXCEPTION 'That worker is not a staff account in this organisation';
  END IF;

  IF coalesce(v_profile.account_status, 'active') <> 'active'
     OR coalesce(v_profile.employment_status, 'active')
        IN ('terminated', 'exited', 'resigned') THEN
    RAISE EXCEPTION 'That worker''s account is not active';
  END IF;

  -- HR record must also be active.
  SELECT *
    INTO v_employee
    FROM public.employees e
   WHERE e.profile_id = NEW.assignee_id
     AND e.organization_id = NEW.organization_id
   ORDER BY e.updated_at DESC
   LIMIT 1;

  IF v_employee.id IS NULL THEN
    RAISE EXCEPTION 'That worker is not linked to an active HR employee record';
  END IF;

  IF coalesce(v_employee.employment_status, 'active')
        IN ('terminated', 'exited', 'resigned')
     OR coalesce(v_employee.system_access_status, 'active')
        IN ('disabled', 'revoked', 'suspended') THEN
    RAISE EXCEPTION 'That worker is not an active employee';
  END IF;

  -- Property relationship must be explicit and exact.
  IF coalesce(v_profile.branch_id, v_employee.branch_id)
       IS DISTINCT FROM NEW.branch_id THEN
    RAISE EXCEPTION 'That worker belongs to another property';
  END IF;

  -- Worker must actually belong to the task department.
  IF NOT EXISTS (
    SELECT 1
      FROM public.departments d
     WHERE d.id IN (v_profile.department_id, v_employee.department_id)
       AND d.organization_id = NEW.organization_id
       AND coalesce(d.active, true)
       AND coalesce(d.department_status, 'active') <> 'archived'
       AND (d.branch_id IS NULL OR d.branch_id = NEW.branch_id)
       AND coalesce(
             nullif(btrim(coalesce(d.catalogue_key, '')), ''),
             public.neo_department_catalogue_key(d.name),
             lower(btrim(d.name))
           ) = v_department_key
  ) THEN
    RAISE EXCEPTION
      'That worker is not assigned to the requested department for this property';
  END IF;

  -- Worker must hold a live role belonging to that same department.
  SELECT EXISTS (
    SELECT 1
      FROM public.user_roles ur
      JOIN public.roles r
        ON r.id = ur.role_id
       AND r.organization_id = NEW.organization_id
       AND coalesce(r.active, true)
       AND coalesce(r.role_status, 'active') <> 'archived'
      JOIN public.departments rd
        ON rd.id = r.department_id
     WHERE ur.user_id = NEW.assignee_id
       AND ur.organization_id = NEW.organization_id
       AND coalesce(
             nullif(btrim(coalesce(rd.catalogue_key, '')), ''),
             public.neo_department_catalogue_key(rd.name),
             lower(btrim(rd.name))
           ) = v_department_key
  )
  INTO v_role_ok;

  IF NOT coalesce(v_role_ok, false) THEN
    RAISE EXCEPTION
      'That worker does not hold an active role for the requested department';
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS neo_validate_task_assignee_scope_trg
ON public.tasks;

CREATE TRIGGER neo_validate_task_assignee_scope_trg
BEFORE INSERT OR UPDATE OF
  assignee_id,
  branch_id,
  department_id,
  organization_id
ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.neo_validate_task_assignee_scope();

REVOKE ALL
ON FUNCTION public.neo_validate_task_assignee_scope()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE
ON FUNCTION public.neo_validate_task_assignee_scope()
TO service_role;

NOTIFY pgrst, 'reload schema';