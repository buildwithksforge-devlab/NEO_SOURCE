
-- =========================================================
-- Recovery & tenant lifecycle : schema foundations
-- =========================================================

-- 1. Snapshots -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  scope text NOT NULL DEFAULT 'tenant',
  label text,
  reason text,
  status text NOT NULL DEFAULT 'running',
  table_count integer NOT NULL DEFAULT 0,
  row_count bigint NOT NULL DEFAULT 0,
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  checksum text,
  skipped_tables jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  backup_record_id uuid REFERENCES public.backup_records(id) ON DELETE SET NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_snapshots_scope_chk CHECK (scope IN ('tenant','property')),
  CONSTRAINT tenant_snapshots_status_chk CHECK (status IN ('running','completed','failed','expired')),
  CONSTRAINT tenant_snapshots_property_chk CHECK (scope <> 'property' OR branch_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS tenant_snapshots_org_created_idx ON public.tenant_snapshots (organization_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.tenant_snapshots TO authenticated;
GRANT ALL ON public.tenant_snapshots TO service_role;
ALTER TABLE public.tenant_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "snapshots readable in own workspace"
  ON public.tenant_snapshots FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id()
         AND (public.has_permission('administration','recovery','view')
              OR public.is_org_admin_for(organization_id)));

CREATE POLICY "snapshots managed in own workspace"
  ON public.tenant_snapshots FOR ALL TO authenticated
  USING (organization_id = public.current_org_id()
         AND (public.has_permission('administration','recovery','manage')
              OR public.is_org_admin_for(organization_id)))
  WITH CHECK (organization_id = public.current_org_id()
         AND (public.has_permission('administration','recovery','manage')
              OR public.is_org_admin_for(organization_id)));

-- 2. Snapshot table manifest -----------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_snapshot_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES public.tenant_snapshots(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  table_name text NOT NULL,
  row_count bigint NOT NULL DEFAULT 0,
  chunk_count integer NOT NULL DEFAULT 0,
  checksum text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, table_name)
);
CREATE INDEX IF NOT EXISTS tenant_snapshot_tables_org_idx ON public.tenant_snapshot_tables (organization_id, snapshot_id);

GRANT SELECT ON public.tenant_snapshot_tables TO authenticated;
GRANT ALL ON public.tenant_snapshot_tables TO service_role;
ALTER TABLE public.tenant_snapshot_tables ENABLE ROW LEVEL SECURITY;

CREATE POLICY "snapshot manifest readable in own workspace"
  ON public.tenant_snapshot_tables FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id()
         AND (public.has_permission('administration','recovery','view')
              OR public.is_org_admin_for(organization_id)));

-- 3. Snapshot chunks -------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_snapshot_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL REFERENCES public.tenant_snapshots(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  table_name text NOT NULL,
  chunk_index integer NOT NULL,
  row_count integer NOT NULL DEFAULT 0,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (snapshot_id, table_name, chunk_index)
);
CREATE INDEX IF NOT EXISTS tenant_snapshot_chunks_lookup_idx ON public.tenant_snapshot_chunks (organization_id, snapshot_id, table_name, chunk_index);

GRANT SELECT ON public.tenant_snapshot_chunks TO authenticated;
GRANT ALL ON public.tenant_snapshot_chunks TO service_role;
ALTER TABLE public.tenant_snapshot_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "snapshot contents readable by recovery managers"
  ON public.tenant_snapshot_chunks FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id()
         AND (public.has_permission('administration','recovery','manage')
              OR public.is_org_admin_for(organization_id)));

-- 4. Restore runs ----------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_restore_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  snapshot_id uuid NOT NULL REFERENCES public.tenant_snapshots(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE,
  scope text NOT NULL DEFAULT 'tenant',
  mode text NOT NULL,
  status text NOT NULL DEFAULT 'planned',
  reason text,
  plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  executed_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_restore_runs_scope_chk CHECK (scope IN ('tenant','property')),
  CONSTRAINT tenant_restore_runs_mode_chk CHECK (mode IN ('dry_run','drill','apply')),
  CONSTRAINT tenant_restore_runs_status_chk CHECK (status IN ('planned','awaiting_approval','approved','running','completed','failed','cancelled')),
  CONSTRAINT tenant_restore_runs_no_self_approval CHECK (approved_by IS NULL OR requested_by IS NULL OR approved_by <> requested_by)
);
CREATE INDEX IF NOT EXISTS tenant_restore_runs_org_created_idx ON public.tenant_restore_runs (organization_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.tenant_restore_runs TO authenticated;
GRANT ALL ON public.tenant_restore_runs TO service_role;
ALTER TABLE public.tenant_restore_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "restore runs readable in own workspace"
  ON public.tenant_restore_runs FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id()
         AND (public.has_permission('administration','recovery','view')
              OR public.is_org_admin_for(organization_id)));

CREATE POLICY "restore runs managed in own workspace"
  ON public.tenant_restore_runs FOR ALL TO authenticated
  USING (organization_id = public.current_org_id()
         AND (public.has_permission('administration','recovery','manage')
              OR public.is_org_admin_for(organization_id)))
  WITH CHECK (organization_id = public.current_org_id()
         AND (public.has_permission('administration','recovery','manage')
              OR public.is_org_admin_for(organization_id)));

-- 5. Tenant lifecycle ------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_lifecycle_states (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'active',
  reason text,
  export_snapshot_id uuid REFERENCES public.tenant_snapshots(id) ON DELETE SET NULL,
  export_verified_at timestamptz,
  suspended_at timestamptz,
  suspended_by uuid,
  deletion_requested_by uuid,
  deletion_requested_at timestamptz,
  deletion_approved_by uuid,
  deletion_approved_at timestamptz,
  grace_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_lifecycle_state_chk CHECK (state IN ('active','suspended','pending_deletion','deleted')),
  CONSTRAINT tenant_lifecycle_no_self_approval CHECK (
    deletion_approved_by IS NULL OR deletion_requested_by IS NULL
    OR deletion_approved_by <> deletion_requested_by)
);

GRANT SELECT ON public.tenant_lifecycle_states TO authenticated;
GRANT ALL ON public.tenant_lifecycle_states TO service_role;
ALTER TABLE public.tenant_lifecycle_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lifecycle readable in own workspace"
  ON public.tenant_lifecycle_states FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id()
         AND (public.has_permission('administration','recovery','view')
              OR public.is_org_admin_for(organization_id)));

-- 6. Deletion certificates --------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_deletion_certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  organization_name text NOT NULL,
  export_snapshot_id uuid,
  export_reference text,
  removed_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by uuid,
  approved_by uuid,
  executed_by uuid,
  executed_at timestamptz NOT NULL DEFAULT now(),
  notes text
);
CREATE INDEX IF NOT EXISTS tenant_deletion_certificates_org_idx ON public.tenant_deletion_certificates (organization_id, executed_at DESC);

GRANT SELECT ON public.tenant_deletion_certificates TO authenticated;
GRANT ALL ON public.tenant_deletion_certificates TO service_role;
ALTER TABLE public.tenant_deletion_certificates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "deletion certificates readable by own workspace admins"
  ON public.tenant_deletion_certificates FOR SELECT TO authenticated
  USING (organization_id = public.current_org_id()
         AND (public.has_permission('administration','recovery','view')
              OR public.is_org_admin_for(organization_id)));

-- 7. Provider backup terms on the environment registry -----------
ALTER TABLE public.environment_registry
  ADD COLUMN IF NOT EXISTS backup_provider text,
  ADD COLUMN IF NOT EXISTS backup_frequency text,
  ADD COLUMN IF NOT EXISTS backup_retention_days integer,
  ADD COLUMN IF NOT EXISTS pitr_enabled boolean,
  ADD COLUMN IF NOT EXISTS pitr_window_hours integer,
  ADD COLUMN IF NOT EXISTS backup_region text,
  ADD COLUMN IF NOT EXISTS backup_terms_source text,
  ADD COLUMN IF NOT EXISTS backup_terms_recorded_at timestamptz,
  ADD COLUMN IF NOT EXISTS backup_terms_recorded_by uuid;

-- 8. Recovery permissions ---------------------------------------
INSERT INTO public.permissions (module, feature, action, label)
VALUES
  ('administration','recovery','view','View recovery and workspace lifecycle'),
  ('administration','recovery','manage','Take snapshots, plan and run restores'),
  ('administration','recovery','approve','Approve restores and workspace deletion')
ON CONFLICT DO NOTHING;

INSERT INTO public.role_feature_templates (role_key, module, feature, action)
SELECT rk.role_key, 'administration', 'recovery', a.action
FROM (VALUES ('owner'),('it-system-administrator')) AS rk(role_key)
CROSS JOIN (VALUES ('view'),('manage'),('approve')) AS a(action)
ON CONFLICT DO NOTHING;

-- 9. updated_at triggers -----------------------------------------
CREATE OR REPLACE FUNCTION public.neo_recovery_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS tenant_snapshots_touch ON public.tenant_snapshots;
CREATE TRIGGER tenant_snapshots_touch BEFORE UPDATE ON public.tenant_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.neo_recovery_touch_updated_at();

DROP TRIGGER IF EXISTS tenant_restore_runs_touch ON public.tenant_restore_runs;
CREATE TRIGGER tenant_restore_runs_touch BEFORE UPDATE ON public.tenant_restore_runs
  FOR EACH ROW EXECUTE FUNCTION public.neo_recovery_touch_updated_at();

DROP TRIGGER IF EXISTS tenant_lifecycle_states_touch ON public.tenant_lifecycle_states;
CREATE TRIGGER tenant_lifecycle_states_touch BEFORE UPDATE ON public.tenant_lifecycle_states
  FOR EACH ROW EXECUTE FUNCTION public.neo_recovery_touch_updated_at();
