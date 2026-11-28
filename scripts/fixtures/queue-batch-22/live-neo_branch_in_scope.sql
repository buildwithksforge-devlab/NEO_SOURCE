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
$function$
