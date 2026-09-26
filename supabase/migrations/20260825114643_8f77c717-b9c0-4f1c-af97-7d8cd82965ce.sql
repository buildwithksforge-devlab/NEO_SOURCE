-- NEØ governance correction: Owner/Director and IT/System Administrator are
-- both superuser roles for platform access. "technical" is a governance label
-- (they are not automatically commercial approvers), never a data-reach
-- restriction: for scope purposes it ranks with organisation-wide access.

CREATE OR REPLACE FUNCTION public.scope_rank(_scope text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE _scope
    WHEN 'organisation' THEN 5
    -- Equal platform reach to an Owner. Business approval authority is decided
    -- separately by the organisation's approval matrix, not by this rank.
    WHEN 'technical' THEN 5
    WHEN 'branch' THEN 4
    WHEN 'department' THEN 3
    WHEN 'team' THEN 2
    WHEN 'self' THEN 1
    ELSE 1 END;
$function$;

CREATE OR REPLACE FUNCTION public.in_my_scope(_org uuid, _branch uuid, _department uuid, _station uuid, _assigned_user uuid, _created_by uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(CASE
    WHEN _org IS NULL OR _org <> public.current_org_id() THEN false
    ELSE CASE public.current_access_scope()
      WHEN 'organisation' THEN true
      WHEN 'technical' THEN true
      WHEN 'branch' THEN (_branch IS NULL OR _branch = ANY (public.current_branch_ids()))
      WHEN 'department' THEN
        (_branch IS NULL OR _branch = ANY (public.current_branch_ids()))
        AND COALESCE(
          _department = ANY (public.current_department_ids())
          OR _station = ANY (public.current_station_ids())
          OR _assigned_user = auth.uid()
          OR _created_by = auth.uid()
          OR public.supervises_user(_assigned_user), false)
      WHEN 'team' THEN
        (_branch IS NULL OR _branch = ANY (public.current_branch_ids()))
        AND COALESCE(
          _station = ANY (public.current_station_ids())
          OR _assigned_user = auth.uid()
          OR _created_by = auth.uid()
          OR public.supervises_user(_assigned_user), false)
      ELSE COALESCE(_assigned_user = auth.uid() OR _created_by = auth.uid(), false)
    END
  END, false);
$function$;

CREATE OR REPLACE FUNCTION public.in_my_branch_scope(_org uuid, _branch uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN _org IS NULL OR _org <> public.current_org_id() THEN false
    WHEN public.current_access_scope() IN ('organisation','technical') THEN true
    ELSE (_branch IS NULL OR _branch = ANY (public.current_branch_ids()))
  END;
$function$;

CREATE OR REPLACE FUNCTION public.neo_branch_in_scope(_branch uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN public.current_access_scope() IN ('organisation','technical') THEN true
    ELSE _branch IS NULL OR _branch = ANY (public.current_branch_ids())
  END;
$function$;

CREATE OR REPLACE FUNCTION public.in_my_module_scope(_org uuid, _branch uuid, _module text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(CASE
    WHEN _org IS NULL OR _org <> public.current_org_id() THEN false
    ELSE CASE
      WHEN public.current_access_scope() IN ('organisation','technical') THEN true
      WHEN public.current_access_scope() = 'branch'
        THEN (_branch IS NULL OR _branch = ANY (public.current_branch_ids()))
      ELSE
        (_branch IS NULL OR _branch = ANY (public.current_branch_ids()))
        AND EXISTS (
          SELECT 1 FROM public.departments d
          WHERE d.id = ANY (public.current_department_ids())
            AND d.organization_id = _org
            AND upper(coalesce(d.code,'')) = ANY (public.neo_module_department_codes(_module))
        )
    END
  END, false);
$function$;

-- Organisation-wide reporting is equally available to both superuser roles.
CREATE OR REPLACE FUNCTION public.neo_assert_reporting_scope(_branch uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_scope text;
BEGIN
  IF public.current_org_id() IS NULL THEN
    RAISE EXCEPTION 'no_organisation' USING ERRCODE = '42501';
  END IF;
  v_scope := public.current_access_scope();
  IF _branch IS NULL AND v_scope NOT IN ('organisation','technical') THEN
    RAISE EXCEPTION 'Select a property — your access does not cover the whole organisation'
      USING ERRCODE = '42501';
  END IF;
  IF _branch IS NOT NULL AND NOT public.neo_branch_in_scope(_branch) THEN
    RAISE EXCEPTION 'That property is outside your access scope' USING ERRCODE = '42501';
  END IF;
END $function$;

-- Product-wide template parity with Owner. Sensitive commercial approvals are
-- filtered out of the copy and remain governed by the approval matrix; the
-- template compiler also strips restricted actions from any role without
-- explicit restricted authority.
INSERT INTO public.role_permission_templates (version, template_name, template_key, module, action)
SELECT 1, 'IT/System Administrator', 'it-system-administrator', t.module, t.action
  FROM public.role_permission_templates t
 WHERE t.version = 1 AND t.template_key = 'owner'
   AND NOT EXISTS (
     SELECT 1 FROM public.restricted_actions ra
      WHERE ra.module = t.module AND ra.action = t.action)
   AND NOT EXISTS (
     SELECT 1 FROM public.role_permission_templates x
      WHERE x.version = 1 AND x.template_key = 'it-system-administrator'
        AND x.module = t.module AND x.action = t.action);

REVOKE ALL ON FUNCTION public.neo_assert_reporting_scope(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_assert_reporting_scope(uuid) TO authenticated;