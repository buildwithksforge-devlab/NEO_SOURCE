-- Read only: confirm the installed authenticated projection includes saved
-- property and status and retains its authenticated/anonymous grant boundary.
SELECT p.oid::regprocedure::text AS routine,
       position('''branch_id'', p.branch_id' in pg_get_functiondef(p.oid)) > 0 AS projects_property,
       position('''status'', p.status' in pg_get_functiondef(p.oid)) > 0 AS projects_status,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anonymous_can_execute
  FROM pg_proc p
 WHERE p.oid = 'public.neo_guest_folio_projection(uuid)'::regprocedure;
