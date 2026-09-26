/**
 * History growth and tenant migration data layer.
 *
 * Retention is reported, never assumed: a table is only archived once the
 * hotel has set a retention period and switched archiving on. Moving a
 * property into its own workspace is planned first, then executed with a
 * reason, and both are recorded.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const sb = supabase as unknown as {
  from: (t: string) => any;
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

const KEY = "data-lifecycle";

export type RetentionRow = {
  table_name: string;
  domain: string;
  live_rows: number;
  total_bytes: number;
  partitioned: boolean;
  retention_months: number | null;
  rows_past_retention: number;
  threshold_rows: number;
  needs_partitioning: boolean;
  blockers: string | null;
};

async function rpc<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await guardedRpc(sb, name, args ?? {});
  if (error) throw new Error(error.message);
  return data as T;
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: [KEY] });
}

export function useRetentionOverview(organizationId: string | null | undefined) {
  return useQuery({
    queryKey: [KEY, "retention", organizationId ?? null],
    enabled: Boolean(organizationId),
    queryFn: () => rpc<RetentionRow[]>("neo_retention_overview"),
  });
}

export function usePartitionMaintenance() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (monthsAhead: number) => rpc<Row>("neo_partition_maintain", { _months_ahead: monthsAhead }),
    onSuccess: (result) => {
      invalidate();
      const created = Array.isArray(result?.["created"]) ? (result["created"] as unknown[]).length : 0;
      toast.success(created ? `${created} monthly section(s) prepared` : "All upcoming months are already prepared");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useArchiveHistory() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { table: string; confirm: boolean }) =>
      rpc<Row>("neo_retention_archive", { _table: input.table, _confirm: input.confirm }),
    onSuccess: (result) => {
      invalidate();
      if (result?.["executed"]) toast.success(`${result["rows_archived"]} row(s) moved to ${result["archive_table"]}`);
      else toast.message(`${result?.["rows_to_archive"] ?? 0} row(s) are older than the retention period`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------- tenant migration */

export function useTenantMigrationRuns(organizationId: string | null | undefined) {
  return useQuery({
    queryKey: [KEY, "migration-runs", organizationId ?? null],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("tenant_migration_runs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(25);
      if (error) throw new Error(error.message);
      return (data ?? []) as Row[];
    },
  });
}

export function usePlanTenantMigration() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (branch: string) => rpc<Row>("neo_tenant_migration_plan", { _branch: branch }),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useExecuteTenantMigration() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { branch: string; reason: string; targetOrganization?: string; newOrganizationName?: string }) =>
      rpc<Row>("neo_tenant_migrate_property", {
        _branch: input.branch,
        _reason: input.reason,
        _target_organization: input.targetOrganization ?? null,
        _new_organization_name: input.newOrganizationName ?? null,
      }),
    onSuccess: (result) => {
      invalidate();
      toast.success(`Property moved — ${result?.["total_rows"] ?? 0} record(s) transferred`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
