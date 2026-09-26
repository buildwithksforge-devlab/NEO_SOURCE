DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname LIKE 'role_grant_migration_log_p%'
      AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('REVOKE ALL ON public.%I FROM authenticated, anon', r.relname);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', r.relname);
  END LOOP;
END $$;

-- The earlier copy is evidence only: readable by nothing through the API, writable by no one.
REVOKE ALL ON public.role_grant_migration_log_pre_partition FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.role_grant_migration_log_pre_partition FROM service_role;