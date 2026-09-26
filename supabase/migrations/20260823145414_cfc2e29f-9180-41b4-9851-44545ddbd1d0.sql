-- UAT defect: in_my_scope could return NULL (not false) when the record had no
-- station match, no assignee and no creator. `NOT NULL` is NULL, so every guard
-- written as `IF NOT in_my_scope(...) THEN raise` silently passed, letting a
-- Pastry chef progress a Hot Kitchen ticket. Make the predicate strictly boolean.
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
      WHEN 'technical' THEN false
      ELSE COALESCE(_assigned_user = auth.uid() OR _created_by = auth.uid(), false)
    END
  END, false);
$function$;