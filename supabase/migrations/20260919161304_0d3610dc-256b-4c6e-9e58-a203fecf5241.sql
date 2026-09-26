ALTER TABLE public.audit_logs RENAME TO audit_logs_pre_partition;
ALTER TABLE public.audit_logs_partitioned RENAME TO audit_logs;

CREATE TRIGGER audit_logs_stamp BEFORE INSERT ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.stamp_audit_log();
CREATE TRIGGER neo_audit_actor_is_caller BEFORE INSERT ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.neo_audit_actor_is_caller();

-- The pre-partition heap is frozen evidence: readable by administrators, never written.
DROP POLICY IF EXISTS "audit insert" ON public.audit_logs_pre_partition;
REVOKE INSERT, UPDATE, DELETE ON public.audit_logs_pre_partition FROM authenticated, anon;

INSERT INTO public.records_retention_register (table_name, record_class, archive_destination, notes)
VALUES ('audit_logs_pre_partition','evidence','retained until partition swap is certified','Frozen copy of the audit trail as it stood before monthly partitioning.')
ON CONFLICT (table_name) DO NOTHING;