CREATE OR REPLACE FUNCTION public.current_access_scope()
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c text; v text;
begin
  c := public.neo_ctx_read('scope');
  if c is not null then return substr(c,2); end if;
  SELECT coalesce(
    (SELECT s.lvl FROM (
       SELECT coalesce(r.access_scope, public.role_scope_level(r.name)) AS lvl
       FROM public.user_roles ur
       JOIN public.roles r ON r.id = ur.role_id
       WHERE ur.user_id = auth.uid()
         AND ur.organization_id = public.current_org_id()
     ) s
     ORDER BY public.scope_rank(s.lvl) DESC
     LIMIT 1),
    'self') into v;
  perform public.neo_ctx_write('scope', 'v'||v);
  return v;
end $function$
