-- 1. Permission history: one store per month, same records, same access rules.
CREATE TABLE public.role_grant_migration_log_partitioned (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  role_id uuid,
  role_key text,
  permission_id uuid,
  module text,
  feature text,
  action text,
  reason text,
  operation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

GRANT SELECT ON public.role_grant_migration_log_partitioned TO authenticated;
GRANT ALL ON public.role_grant_migration_log_partitioned TO service_role;
ALTER TABLE public.role_grant_migration_log_partitioned ENABLE ROW LEVEL SECURITY;
CREATE POLICY "role_grant_log readable in org"
  ON public.role_grant_migration_log_partitioned
  FOR SELECT TO authenticated
  USING (organization_id = current_org_id());

-- Monthly partitions covering every existing record plus the months ahead.
DO $$
DECLARE
  m date := date_trunc('month', (SELECT min(created_at) FROM public.role_grant_migration_log))::date;
  stop date := (date_trunc('month', now()) + interval '6 months')::date;
BEGIN
  IF m IS NULL THEN m := date_trunc('month', now())::date; END IF;
  WHILE m < stop LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.role_grant_migration_log_partitioned FOR VALUES FROM (%L) TO (%L)',
      'role_grant_migration_log_p' || to_char(m, 'YYYYMM'),
      m,
      (m + interval '1 month')::date
    );
    m := (m + interval '1 month')::date;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS public.role_grant_migration_log_p_default
  PARTITION OF public.role_grant_migration_log_partitioned DEFAULT;

-- 2. Move every existing record across, unchanged.
INSERT INTO public.role_grant_migration_log_partitioned
  (id, organization_id, role_id, role_key, permission_id, module, feature, action, reason, operation, created_at)
SELECT id, organization_id, role_id, role_key, permission_id, module, feature, action, reason, operation, created_at
FROM public.role_grant_migration_log;

-- 3. Workspace-scoped history index on every partition.
CREATE INDEX role_grant_log_part_org_created_idx
  ON public.role_grant_migration_log_partitioned (organization_id, created_at DESC);

-- 4. Swap names, keeping the previous copy as evidence.
ALTER TABLE public.role_grant_migration_log RENAME TO role_grant_migration_log_pre_partition;
ALTER TABLE public.role_grant_migration_log_partitioned RENAME TO role_grant_migration_log;

-- 5. Three identical indexes on role permissions become one (the constraint-backed one).
DROP INDEX IF EXISTS public.role_permissions_role_permission_uniq;
DROP INDEX IF EXISTS public.role_permissions_unique_grant;