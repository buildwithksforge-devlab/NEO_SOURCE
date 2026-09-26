CREATE OR REPLACE FUNCTION public.neo_role_reporting_meta(_role_ids uuid[])
 RETURNS TABLE(allowed_manager_keys text[], manager_required boolean, worker_keys text[], worker_level integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH r AS (
    SELECT ro.normalized_role_key AS key,
           ro.reports_to_role_keys AS override_keys,
           ro.reporting_manager_required AS override_required,
           ro.management_level AS override_level
      FROM public.roles ro
     WHERE ro.id = ANY(COALESCE(_role_ids, '{}'::uuid[]))
       -- A role identifier from another workspace must never be answerable here.
       AND ro.organization_id = public.current_org_id()
  ),
  merged AS (
    SELECT r.key,
           COALESCE(r.override_keys, c.reports_to_role_keys, '{}') AS keys,
           COALESCE(r.override_required, c.reporting_manager_required, true) AS required,
           COALESCE(r.override_level, c.management_level, 0) AS lvl
      FROM r LEFT JOIN public.role_catalogue c ON c.role_key = r.key
  ),
  inverse AS (
    SELECT DISTINCT c.role_key AS key
      FROM public.role_catalogue c
     WHERE EXISTS (SELECT 1 FROM merged m WHERE m.key = ANY(c.can_manage_role_keys))
  )
  SELECT
    (SELECT COALESCE(array_agg(DISTINCT k), '{}')
       FROM (SELECT unnest(keys) k FROM merged
             UNION SELECT key FROM inverse) u
      WHERE k IS NOT NULL AND k <> ''),
    (SELECT COALESCE(bool_or(required), false) FROM merged),
    (SELECT COALESCE(array_agg(DISTINCT key), '{}') FROM merged WHERE key IS NOT NULL),
    (SELECT COALESCE(max(lvl), 0) FROM merged);
$function$;