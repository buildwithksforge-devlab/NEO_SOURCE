/**
 * Recovery & tenant lifecycle data layer.
 *
 * Five distinct recovery levels exist in NEØ and they are different problems:
 *
 *  1. a normal mistake        → application correction (reversals already in each module)
 *  2. a bad import            → reverse the onboarding batch
 *  3. a property data problem → restore one property from a snapshot
 *  4. workspace corruption    → restore the whole workspace from a snapshot
 *  5. a platform incident     → the hosting provider's backups / point-in-time recovery
 *
 * This module owns levels 3–5: snapshots, restore comparisons, verification
 * drills, and the export → suspend → delete workspace lifecycle. Nothing here
 * invents a backup, a retention window or a restore result: a value is written
 * only when a real run produced it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { guardedRpc } from "@/lib/rpc-guard";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const sb = supabase as unknown as {
  from: (t: string) => any;
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

const KEY = "recovery";

function fail(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

async function rpc<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await guardedRpc(sb, name, args ?? {});
  if (error) throw new Error(error.message);
  return data as T;
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: [KEY] });
}

/* --------------------------------------------------------------- reads */

export function useSnapshots(organizationId: string | null | undefined) {
  return useQuery({
    queryKey: [KEY, "snapshots", organizationId ?? null],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("tenant_snapshots")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useRestoreRuns(organizationId: string | null | undefined) {
  return useQuery({
    queryKey: [KEY, "restore-runs", organizationId ?? null],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("tenant_restore_runs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useBackupRecords(organizationId: string | null | undefined) {
  return useQuery({
    queryKey: [KEY, "backup-records", organizationId ?? null],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("backup_records")
        .select("*")
        .order("taken_at", { ascending: false })
        .limit(50);
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useDeletionCertificates(organizationId: string | null | undefined) {
  return useQuery({
    queryKey: [KEY, "deletion-certificates", organizationId ?? null],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("tenant_deletion_certificates")
        .select("*")
        .order("executed_at", { ascending: false })
        .limit(20);
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useTenantLifecycle(organizationId: string | null | undefined) {
  return useQuery({
    queryKey: [KEY, "lifecycle", organizationId ?? null],
    enabled: Boolean(organizationId),
    queryFn: async () => (await rpc<Row | null>("neo_tenant_lifecycle")) ?? null,
  });
}

/** What the hosting provider actually gives us — recorded, never guessed. */
export function useBackupTerms() {
  return useQuery({
    queryKey: [KEY, "backup-terms"],
    queryFn: async () => {
      const { data, error } = await sb
        .from("environment_registry")
        .select("*")
        .order("is_production", { ascending: false });
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

/* ----------------------------------------------------------- snapshots */

export type SnapshotProgress = { capturedTables: number; remaining: number; passes: number };

/**
 * Takes a snapshot in timed passes so a large workspace never hits a statement
 * timeout, then seals it and writes the matching backup-register entry.
 */
export function useTakeSnapshot() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: { branchId?: string | null; label?: string; reason?: string }) => {
      const snapshot = await rpc<string>("neo_snapshot_begin", {
        _branch: input.branchId ?? null,
        _label: input.label ?? null,
        _reason: input.reason ?? null,
      });

      let passes = 0;
      let remaining = 1;
      while (remaining > 0 && passes < 60) {
        const res = await rpc<Row>("neo_snapshot_capture", { _snapshot: snapshot });
        remaining = Number(res?.["remaining"] ?? 0);
        passes += 1;
      }
      if (remaining > 0) {
        throw new Error("The snapshot is taking longer than expected. Run it again to continue where it stopped.");
      }
      return (await rpc<Row>("neo_snapshot_finalise", { _snapshot: snapshot })) ?? {};
    },
    onSuccess: (result) => {
      invalidate();
      toast.success(
        `Snapshot taken · ${Number(result?.["tables"] ?? 0)} table(s), ${Number(result?.["rows"] ?? 0)} record(s)`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Re-reads a snapshot's stored contents and records whether it verified. */
export function useRunDrill() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (snapshotId: string) => rpc<Row>("neo_restore_drill", { _snapshot: snapshotId }),
    onSuccess: (r) => {
      invalidate();
      if (r?.["result"] === "passed") toast.success(`Drill passed · ${Number(r["verified"] ?? 0)} table(s) verified`);
      else toast.error(`Drill failed · ${Number(r?.["failed"] ?? 0)} table(s) did not verify`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Checks a snapshot against the records that are actually in the backend now:
 * its stored contents must still be intact and every captured area must still
 * exist. Differences against today's records are reported, not hidden.
 */
export function useVerifySnapshot() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (snapshotId: string) => rpc<Row>("neo_snapshot_verify", { _snapshot: snapshotId }),
    onSuccess: (r) => {
      invalidate();
      const intact = Number(r?.["tables_intact"] ?? 0);
      const differing = Number(r?.["tables_differing_from_live"] ?? 0);
      if (r?.["verified"] === true) {
        toast.success(`Snapshot verified · ${intact} area(s) intact, ${differing} differ from current records`);
      } else {
        toast.error(
          `Snapshot could not be verified · ${Number(r?.["tables_failed"] ?? 0)} failed, ${Number(
            r?.["tables_missing_live"] ?? 0,
          )} no longer exist`,
        );
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------- restore */

/** Comparison only — writes nothing to the workspace's data. */
export function usePlanRestore() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (snapshotId: string) =>
      rpc<string>("neo_restore_open", { _snapshot: snapshotId, _mode: "dry_run", _reason: null }),
    onSuccess: () => {
      invalidate();
      toast.success("Restore comparison ready");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRequestRestore() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: { snapshotId: string; reason: string }) =>
      rpc<string>("neo_restore_open", { _snapshot: input.snapshotId, _mode: "apply", _reason: input.reason }),
    onSuccess: () => {
      invalidate();
      toast.success("Restore requested · a second person must approve it");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useApproveRestore() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: { runId: string; reason?: string }) =>
      rpc<Row>("neo_restore_approve", { _run: input.runId, _reason: input.reason ?? null }),
    onSuccess: () => {
      invalidate();
      toast.success("Restore approved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useCancelRestore() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: { runId: string; reason?: string }) =>
      rpc<Row>("neo_restore_cancel", { _run: input.runId, _reason: input.reason ?? null }),
    onSuccess: () => {
      invalidate();
      toast.success("Restore cancelled");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useExecuteRestore() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (runId: string) => {
      let passes = 0;
      let remaining = 1;
      let last: Row = {};
      while (remaining > 0 && passes < 60) {
        last = await rpc<Row>("neo_restore_execute", { _run: runId });
        remaining = Number(last?.["remaining"] ?? 0);
        passes += 1;
      }
      if (remaining > 0) throw new Error("The restore is still running. Run it again to continue.");
      return last;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Restore completed");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ----------------------------------------------------------- lifecycle */

export function useLifecycleAction() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (
      input:
        | { action: "set_export"; snapshotId: string }
        | { action: "suspend"; reason: string }
        | { action: "begin_offboarding"; reason: string }
        | { action: "resume"; reason?: string }
        | { action: "request_deletion"; reason: string; graceDays: number }
        | { action: "approve_deletion"; reason?: string }
        | { action: "cancel_deletion"; reason?: string }
        | { action: "execute_deletion"; confirmName: string },
    ) => {
      switch (input.action) {
        case "set_export":
          return rpc("neo_tenant_set_export", { _snapshot: input.snapshotId });
        case "suspend":
          return rpc("neo_tenant_suspend", { _reason: input.reason });
        case "begin_offboarding":
          return rpc("neo_tenant_begin_offboarding", { _reason: input.reason });
        case "resume":
          return rpc("neo_tenant_resume", { _reason: input.reason ?? null });
        case "request_deletion":
          return rpc("neo_tenant_request_deletion", { _reason: input.reason, _grace_days: input.graceDays });
        case "approve_deletion":
          return rpc("neo_tenant_approve_deletion", { _reason: input.reason ?? null });
        case "cancel_deletion":
          return rpc("neo_tenant_cancel_deletion", { _reason: input.reason ?? null });
        case "execute_deletion":
          return rpc("neo_tenant_execute_deletion", { _confirm_name: input.confirmName });
      }
    },
    onSuccess: () => {
      invalidate();
      toast.success("Workspace lifecycle updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRecordBackupTerms() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: {
      environmentKey: string;
      provider: string;
      frequency: string;
      retentionDays: number | null;
      pitr: boolean | null;
      pitrWindowHours: number | null;
      region: string;
      source: string;
    }) =>
      rpc("neo_record_backup_terms", {
        _environment_key: input.environmentKey,
        _provider: input.provider,
        _frequency: input.frequency,
        _retention_days: input.retentionDays,
        _pitr: input.pitr,
        _pitr_window_hours: input.pitrWindowHours,
        _region: input.region,
        _source: input.source,
      }),
    onSuccess: () => {
      invalidate();
      toast.success("Provider backup terms recorded");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ----------------------------------------------------------- readiness */

export type RecoveryLevel = {
  level: number;
  title: string;
  problem: string;
  answer: string;
  available: boolean;
  detail: string;
  to?: string;
};

/**
 * Pure: turns the recorded facts into the five-level readiness view. Anything
 * that has not actually been recorded reads as not established, never as
 * protection.
 */
export function buildRecoveryLevels(input: {
  latestSnapshot: Row | null;
  lastVerifiedDrillAt: string | null;
  providerTermsRecorded: boolean;
  providerPitr: boolean | null;
  providerRetentionDays: number | null;
}): RecoveryLevel[] {
  const snap = input.latestSnapshot;
  const snapAge = snap?.["completed_at"]
    ? Math.floor((Date.now() - new Date(String(snap["completed_at"])).getTime()) / 86_400_000)
    : null;

  return [
    {
      level: 1,
      title: "Normal mistake",
      problem: "Someone entered or posted the wrong thing.",
      answer: "Correct it in the module that created it — reversals keep the original and the reason.",
      available: true,
      detail: "Available in Finance, Folios, Receiving, Payroll and HR.",
    },
    {
      level: 2,
      title: "Bad import",
      problem: "An import brought in wrong or duplicated records.",
      answer: "Reverse the whole batch; records that already have activity are kept and reported.",
      available: true,
      detail: "Available in the Hotel Data Onboarding Centre.",
      to: "/platform/migration",
    },
    {
      level: 3,
      title: "Property data problem",
      problem: "One property's data is wrong but the rest of the workspace is fine.",
      answer: "Restore that property from a snapshot, after a comparison and a second approval.",
      available: Boolean(snap),
      detail: snap
        ? `Latest snapshot ${snapAge === null ? "in progress" : `${snapAge} day(s) old`}.`
        : "No snapshot has been taken yet, so there is nothing to restore from.",
    },
    {
      level: 4,
      title: "Workspace corruption",
      problem: "A large part of the workspace is wrong.",
      answer: "Restore the whole workspace from a snapshot, after a comparison and a second approval.",
      available: Boolean(snap) && Boolean(input.lastVerifiedDrillAt),
      detail: input.lastVerifiedDrillAt
        ? `Last verified drill ${new Date(input.lastVerifiedDrillAt).toLocaleDateString()}.`
        : "No snapshot has passed a restore drill yet, so this is untested.",
    },
    {
      level: 5,
      title: "Platform or database incident",
      problem: "The database itself is lost or damaged.",
      answer: "The hosting provider's automated backups and point-in-time recovery.",
      available: input.providerTermsRecorded && input.providerPitr === true,
      detail: input.providerTermsRecorded
        ? `Recorded: ${input.providerPitr ? "point-in-time recovery available" : "no point-in-time recovery"}${
            input.providerRetentionDays ? `, ${input.providerRetentionDays} day retention` : ""
          }.`
        : "Not established. Confirm the terms with your hosting provider and record them here.",
    },
  ];
}
