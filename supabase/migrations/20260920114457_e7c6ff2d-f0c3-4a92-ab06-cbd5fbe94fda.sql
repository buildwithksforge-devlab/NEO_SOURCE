CREATE OR REPLACE FUNCTION public.role_permission_ids(_role uuid)
 RETURNS TABLE(permission_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT DISTINCT x.permission_id
  FROM (
    SELECT b.permission_id FROM public.role_permissions_base b WHERE b.role_id = _role
    UNION
    SELECT o.permission_id FROM public.role_permission_overrides o
      WHERE o.role_id = _role AND o.effect = 'grant'
    UNION
    SELECT p.id
      FROM public.roles r
      JOIN public.role_feature_templates t ON t.role_key = r.template_key
      JOIN public.permissions p ON p.module = t.module AND p.feature = t.feature AND p.action = t.action
     WHERE r.id = _role AND r.follows_template
  ) x
  WHERE EXISTS (
    SELECT 1 FROM public.roles ar
     WHERE ar.id = _role
       AND ar.organization_id = public.current_org_id()
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.role_permission_overrides d
     WHERE d.role_id = _role AND d.permission_id = x.permission_id AND d.effect = 'deny'
  );
$function$;

INSERT INTO public.privileged_function_review
  (function_name, identity_arguments, reachability, sensitive, establishes_tenant_context,
   classification, trusts_client_tenant, search_path_fixed, domain, review_note)
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid),
       CASE WHEN p.proname = 'neo_property_entrance' THEN 'public_surface' ELSE 'app_callable' END,
       false,
       p.proname <> 'neo_property_entrance',
       CASE WHEN p.proname = 'neo_property_entrance' THEN 'public_workspace_addressed'
            ELSE 'tenant_validated_privileged' END,
       p.proname = 'neo_property_entrance',
       true,
       CASE WHEN p.proname LIKE 'neo_maint%' OR p.proname LIKE 'neo_grounds%' OR p.proname LIKE 'neo_landscaping%'
              THEN 'maintenance'
            WHEN p.proname LIKE 'neo_property_entrance%' THEN 'access'
            WHEN p.proname = 'neo_provider_declare' THEN 'integrations'
            ELSE 'other' END,
       CASE WHEN p.proname = 'neo_property_entrance'
              THEN 'Deliberate signed-out surface: resolves a property''s public name, city and logo for its own branded sign-in page. Grants nothing; membership and permissions are decided after sign-in.'
            ELSE 'Reviewed with the maintenance, grounds, portal and provider work: workspace context is derived from the signed-in person, never from a caller-supplied workspace.' END
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosecdef
   AND NOT EXISTS (
     SELECT 1 FROM public.privileged_function_review r
      WHERE r.function_name = p.proname
        AND r.identity_arguments = pg_get_function_identity_arguments(p.oid));