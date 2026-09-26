-- Inventory of privileged database routines, used by the automated security
-- regression test. It classifies rather than counts: internal/trigger routines
-- are separated from routines a signed-in user can call, and only callable
-- writers with no ownership or permission check are reported as defects.
CREATE OR REPLACE FUNCTION public.neo_security_definer_inventory()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
WITH routines AS (
  SELECT p.oid,
         p.proname::text AS name,
         pg_get_functiondef(p.oid) AS def,
         t.typname AS rettype,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS callable
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_type t ON t.oid = p.prorettype
   WHERE n.nspname = 'public' AND p.prosecdef
), classified AS (
  SELECT name,
         callable,
         rettype = 'trigger' AS is_trigger,
         def ~* '(insert into|update |delete from)' AS writes,
         def ~* '(has_permission|has_role|current_org_id|current_organisation_id|is_org_admin|auth\.uid|organization_id\s*=|neo_branch_in_scope|current_branch_ids)' AS guarded
    FROM routines
)
SELECT jsonb_build_object(
  'total', (SELECT count(*) FROM classified),
  'trigger_only', (SELECT count(*) FROM classified WHERE is_trigger),
  'callable', (SELECT count(*) FROM classified WHERE callable AND NOT is_trigger),
  'writers', (SELECT count(*) FROM classified WHERE callable AND NOT is_trigger AND writes),
  'guarded_writers', (SELECT count(*) FROM classified WHERE callable AND NOT is_trigger AND writes AND guarded),
  'unguarded', coalesce((SELECT jsonb_agg(name ORDER BY name)
                           FROM classified
                          WHERE callable AND NOT is_trigger AND writes AND NOT guarded), '[]'::jsonb)
);
$$;

REVOKE ALL ON FUNCTION public.neo_security_definer_inventory() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_security_definer_inventory() TO service_role;