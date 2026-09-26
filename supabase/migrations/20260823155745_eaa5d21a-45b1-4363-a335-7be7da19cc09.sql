-- Re-point workforce-administration routines at the shared capability rule so
-- backend authority matches what the interface offers. The bodies are
-- otherwise unchanged: only the authorisation predicate is swapped.
DO $do$
DECLARE
  _name text;
  _def text;
BEGIN
  FOREACH _name IN ARRAY ARRAY[
    'neo_provision_worker',
    'set_role_permissions',
    'apply_recommended_permissions',
    'neo_reactivate_role',
    'unassigned_accounts'
  ] LOOP
    SELECT pg_get_functiondef(p.oid) INTO _def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = _name
     LIMIT 1;
    IF _def IS NULL THEN
      RAISE EXCEPTION 'Routine % not found', _name;
    END IF;
    _def := replace(_def, 'public.is_org_admin()', 'public.can_manage_workforce()');
    EXECUTE _def;
  END LOOP;
END
$do$;

REVOKE ALL ON FUNCTION public.neo_provision_worker(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.neo_provision_worker(jsonb) TO authenticated, service_role;
