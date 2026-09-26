import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Controlled role and department consolidation.
 *
 * Nothing here changes an operational record on its own. The workflow is
 * always: preflight → plan → review every proposed change → approve → execute.
 * Every routine is idempotent and every applied change writes both an
 * assignment-history record and an audit record, so a migration can be
 * inspected, repeated safely or reversed.
 */

const rpc = async <T,>(fn: string, args: Record<string, unknown>) => {
  const { data, error } = await guardedRpc(supabase, fn as never, args as never);
  if (error) throw error;
  return data as T;
};

export type Preflight = Record<string, unknown>;

export type MigrationRun = {
  id: string;
  status: "draft" | "previewed" | "approved" | "executing" | "completed" | "failed" | string;
  created_at: string;
  approved_at: string | null;
  executed_at: string | null;
  report: Record<string, unknown> | null;
  preflight: Record<string, unknown> | null;
};

export type MigrationItem = {
  id: string;
  item_kind: string;
  subject_label: string;
  subject_user_id: string | null;
  current_role_id: string | null;
  proposed_role_id: string | null;
  proposed_role_key: string | null;
  target_department_id: string | null;
  manager_candidate: boolean;
  ambiguous: boolean;
  options: { role_key: string; label: string }[];
  permissions_gained: string[];
  permissions_retained: string[];
  permissions_removed: string[];
  restricted_authority_change: string;
  migration_reason: string;
  decision: string;
};

export function usePreflight(organizationId: string | null) {
  return useQuery({
    queryKey: ["role-migration-preflight", organizationId],
    enabled: Boolean(organizationId),
    queryFn: () => rpc<Preflight>("neo_role_migration_preflight", { _org: organizationId }),
  });
}

export function useReconciliation(organizationId: string | null) {
  return useQuery({
    queryKey: ["role-reconciliation", organizationId],
    enabled: Boolean(organizationId),
    queryFn: () => rpc<Record<string, unknown>>("neo_role_reconciliation", { _org: organizationId }),
  });
}

export function useMigrationRuns(organizationId: string | null) {
  return useQuery({
    queryKey: ["role-migration-runs", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("role_migration_runs" as never)
        .select("*")
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data ?? []) as unknown as MigrationRun[];
    },
  });
}

export function useMigrationItems(runId: string | null) {
  return useQuery({
    queryKey: ["role-migration-items", runId],
    enabled: Boolean(runId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("role_migration_items" as never)
        .select("*")
        .eq("run_id", runId as string)
        .order("subject_label");
      if (error) throw error;
      return (data ?? []) as unknown as MigrationItem[];
    },
  });
}

export function useRoleAssignmentHistory(organizationId: string | null) {
  return useQuery({
    queryKey: ["role-assignment-history", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("role_assignment_history" as never)
        .select("*")
        .order("effective_from", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as {
        id: string;
        user_id: string;
        role_name_at_time: string;
        department_name_at_time: string | null;
        assignment_status: string;
        effective_from: string;
        effective_until: string | null;
        change_reason: string | null;
      }[];
    },
  });
}

/**
 * Adoption state of the Modern Hotel Operating Structure v2.0 for this
 * organisation — what is aligned, what is still missing, and the last run.
 */
export function useAdoptionStatus(organizationId: string | null) {
  return useQuery({
    queryKey: ["role-model-adoption", organizationId],
    enabled: Boolean(organizationId),
    queryFn: () => rpc<Record<string, unknown>>("neo_model_adoption_status", { _org: organizationId }),
  });
}

export type PendingRoleDecision = {
  user_id: string;
  organization_id: string;
  full_name: string | null;
  job_title: string | null;
  current_roles: string;
  primary_role: string | null;
  holds_admin_authority: boolean;
  admin_role_count: number;
  reason: string | null;
};

/**
 * Role-ownership decisions the platform refuses to guess: a worker holding an
 * administrative role beside an operational one, or a recorded job title that
 * matches no assigned role. Each is listed in full — never as a bare count.
 */
export function usePendingRoleDecisions(organizationId: string | null) {
  return useQuery({
    queryKey: ["pending-role-decisions", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("neo_pending_role_decisions" as never)
        .select("*")
        .eq("organization_id", organizationId as string);
      if (error) throw error;
      return (data ?? []) as unknown as PendingRoleDecision[];
    },
  });
}

export function useMigrationActions(organizationId: string | null) {
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["role-migration-runs"] });
    qc.invalidateQueries({ queryKey: ["role-migration-items"] });
    qc.invalidateQueries({ queryKey: ["role-migration-preflight"] });
    qc.invalidateQueries({ queryKey: ["role-reconciliation"] });
    qc.invalidateQueries({ queryKey: ["role-model-adoption"] });
    qc.invalidateQueries({ queryKey: ["roles"] });
    qc.invalidateQueries({ queryKey: ["preview-roles"] });
    qc.invalidateQueries({ queryKey: ["preview-role-accounts"] });
    qc.invalidateQueries({ queryKey: ["preview-role-dashboards"] });
    qc.invalidateQueries({ queryKey: ["preview-role-permission-counts"] });
    qc.invalidateQueries({ queryKey: ["departments"] });
  };

  // One idempotent adoption pass: departments, classification, provisioning,
  // duplicate consolidation, permission templates, primary roles, dashboards.
  const adopt = useMutation({
    mutationFn: () =>
      rpc<Record<string, unknown>>("neo_adopt_modern_model", { _org: organizationId, _source: "manual" }),
    onSuccess: refresh,
  });

  const plan = useMutation({
    mutationFn: (key: string) =>
      rpc<string>("neo_plan_role_migration", { _org: organizationId, _idempotency_key: key }),
    onSuccess: refresh,
  });


  const decide = useMutation({
    mutationFn: (input: { item: string; decision: string; overrideRoleId?: string | null; reason?: string }) =>
      rpc("neo_decide_migration_item", {
        _item: input.item,
        _decision: input.decision,
        _override_role_id: input.overrideRoleId ?? null,
        _reason: input.reason ?? "",
      }),
    onSuccess: refresh,
  });

  const approve = useMutation({
    mutationFn: (run: string) => rpc("neo_approve_role_migration", { _run: run }),
    onSuccess: refresh,
  });

  const execute = useMutation({
    mutationFn: (run: string) => rpc<Record<string, unknown>>("neo_execute_role_migration", { _run: run }),
    onSuccess: refresh,
  });

  const archive = useMutation({
    mutationFn: (role: string) => rpc<Record<string, unknown>>("neo_archive_legacy_role", { _role: role }),
    onSuccess: refresh,
  });

  const reactivate = useMutation({
    mutationFn: (input: { role: string; reason: string }) =>
      rpc("neo_reactivate_role", { _role: input.role, _reason: input.reason }),
    onSuccess: refresh,
  });

  return { adopt, plan, decide, approve, execute, archive, reactivate };
}
