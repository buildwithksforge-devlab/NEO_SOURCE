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
      ELSE
        COALESCE(
          _assigned_user = auth.uid()
          OR _created_by = auth.uid()
          OR (
            _station IS NOT NULL
            AND _station = ANY (public.current_station_ids())
            AND (_branch IS NULL OR _branch = ANY (public.current_branch_ids()))
          ), false)
    END
  END, false);
$function$;