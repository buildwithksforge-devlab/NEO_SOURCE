-- 1. Records retention register -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.records_retention_register (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name text NOT NULL UNIQUE,
  record_class text NOT NULL CHECK (record_class IN ('audit','event','history','evidence','operational')),
  retention_months integer,
  archive_destination text,
  purge_permission text NOT NULL DEFAULT 'administration/recovery/manage',
  legal_hold boolean NOT NULL DEFAULT false,
  approved_by uuid REFERENCES auth.users(id),
  approved_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.records_retention_register TO authenticated;
GRANT ALL ON public.records_retention_register TO service_role;
ALTER TABLE public.records_retention_register ENABLE ROW LEVEL SECURITY;

CREATE POLICY "retention register readable by staff"
  ON public.records_retention_register FOR SELECT TO authenticated
  USING (public.current_org_id() IS NOT NULL);

CREATE TRIGGER records_retention_register_touch
  BEFORE UPDATE ON public.records_retention_register
  FOR EACH ROW EXECUTE FUNCTION public.fin_touch_updated_at();

-- Register entries are declarations only: a NULL retention_months means
-- "kept indefinitely until an owner approves a period". Nothing is purged
-- from an entry without retention_months, approved_at and no legal hold.
INSERT INTO public.records_retention_register (table_name, record_class, archive_destination, notes)
VALUES
  ('audit_logs','audit','audit_logs monthly partitions detached to archive','Tenant audit trail. Partitioned monthly; retention period awaiting owner approval.'),
  ('role_grant_migration_log','history','role_grant_migration_log_archive','Write-once RBAC grant history.'),
  ('rbac_baseline_role_permissions','evidence','rbac_platform_snapshots','Frozen RBAC baseline evidence; retention decision outstanding.'),
  ('rbac_baseline_effective_access','evidence','rbac_platform_snapshots','Frozen RBAC baseline evidence; retention decision outstanding.'),
  ('domain_events','event',NULL,'Operational event stream.')
ON CONFLICT (table_name) DO NOTHING;

-- 2. Partitioned audit trail (empty shell; data moved in a later step) ----------
CREATE TABLE IF NOT EXISTS public.audit_logs_partitioned (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid,
  department_id uuid,
  user_id uuid,
  user_name text NOT NULL DEFAULT ''::text,
  action text NOT NULL,
  module text NOT NULL DEFAULT 'administration'::text,
  record_id text,
  previous_value jsonb,
  new_value jsonb,
  reason text,
  device text,
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  station_id uuid,
  role_names text[],
  permission_used text,
  correlation_id text,
  delegation_context jsonb,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS audit_logs_part_org_created_idx
  ON public.audit_logs_partitioned (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_part_org_module_created_idx
  ON public.audit_logs_partitioned (organization_id, module, created_at DESC);

GRANT SELECT, INSERT ON public.audit_logs_partitioned TO authenticated;
GRANT ALL ON public.audit_logs_partitioned TO service_role;
ALTER TABLE public.audit_logs_partitioned ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit admin read"
  ON public.audit_logs_partitioned FOR SELECT TO authenticated
  USING (
    (SELECT public.current_org_id()) IS NOT NULL
    AND organization_id = (SELECT public.current_org_id())
    AND ((SELECT public.is_org_admin()) OR user_id = (SELECT auth.uid()))
  );

CREATE POLICY "audit insert"
  ON public.audit_logs_partitioned FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT public.current_org_id()) IS NOT NULL
    AND organization_id = (SELECT public.current_org_id())
    AND user_id = (SELECT auth.uid())
  );

CREATE POLICY "audit no update"
  ON public.audit_logs_partitioned FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

CREATE POLICY "audit no delete"
  ON public.audit_logs_partitioned FOR DELETE TO authenticated
  USING (false);

-- 3. Partition maintenance ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.neo_audit_ensure_partition(_month date)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _start date := date_trunc('month', _month)::date;
  _end   date := (date_trunc('month', _month) + interval '1 month')::date;
  _name  text := format('audit_logs_p%s', to_char(_start, 'YYYYMM'));
BEGIN
  IF to_regclass('public.' || _name) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE public.%I PARTITION OF public.audit_logs_partitioned FOR VALUES FROM (%L) TO (%L)',
      _name, _start, _end);
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO authenticated', _name);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', _name);
  END IF;
  RETURN _name;
END;
$$;

REVOKE ALL ON FUNCTION public.neo_audit_ensure_partition(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neo_audit_ensure_partition(date) TO service_role;

-- Create the partitions covering existing history plus the next three months.
DO $$
DECLARE m date;
BEGIN
  FOR m IN
    SELECT generate_series(date '2026-08-01', (date_trunc('month', now()) + interval '3 months')::date, interval '1 month')::date
  LOOP
    PERFORM public.neo_audit_ensure_partition(m);
  END LOOP;
END $$;

-- Safety net so a row outside the created range is never rejected.
CREATE TABLE IF NOT EXISTS public.audit_logs_p_default
  PARTITION OF public.audit_logs_partitioned DEFAULT;
GRANT SELECT, INSERT ON public.audit_logs_p_default TO authenticated;
GRANT ALL ON public.audit_logs_p_default TO service_role;