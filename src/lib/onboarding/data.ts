/**
 * Onboarding persistence and execution.
 *
 * A batch is a durable object: stage, counters, mapping, transformations,
 * resolution decisions and every candidate row live in the database, so a
 * browser refresh resumes rather than restarts, and a partially completed
 * import never loses the rows that already succeeded.
 *
 * Idempotency is structural rather than hopeful: a row can only be imported
 * once, because `(batch_id, row_number)` is unique and an imported row carries
 * its `imported_record_id` and `imported_at`. Pressing Import twice replays the
 * *pending* rows only.
 */
import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter, useWriteBranchId } from "@/lib/branch-filter";
import { logAudit } from "@/lib/audit";
import { useScopedDepartments, useScopedWorkers } from "@/lib/scoped-options";
import { guardedRpc } from "@/lib/rpc-guard";
import { domainByKey, type OnboardingDomain, type RelationshipTarget } from "./domains";
import { adapterFor, buildPayload, columnForField } from "./adapters";
import { matchPolicy } from "./matching";
import type { MasterOption, PreparedRow, TransformKey } from "./engine";

// The onboarding columns are additive and not yet in the generated typings.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type BatchRow = Record<string, unknown>;

const KEY = ["onboarding"] as const;

function reference(prefix: string): string {
  const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  const tail = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${stamp}-${tail}`;
}

// ------------------------------------------------------------------ masters

/** Named masters that behave alike: a label plus an optional code alias. */
const NAMED_MASTER_SOURCES: [RelationshipTarget, string, string, string, boolean][] = [
  ["room_type", "room_types", "id, name, code", "name", true],
  ["meal_plan", "meal_plans", "id, name, code", "name", true],
  ["rate_plan", "rate_plans", "id, name, code", "name", true],
  ["stock_item_group", "stock_item_groups", "id, name, code", "name", false],
  ["stock_category", "stock_categories", "id, name, code", "name", false],
  ["menu_category", "menu_categories", "id, name", "name", false],
  ["corporate_account", "corporate_accounts", "id, legal_name, trading_name, account_number", "legal_name", true],
  ["account", "chart_of_accounts", "id, name, code", "name", false],
  ["customer", "customers", "id, full_name, customer_number", "full_name", false],
];

/**
 * Every relationship target an import can actually resolve against. A domain
 * that links to a target absent from this list would leave the value unmatched
 * for ever, so the alignment test asserts the coverage.
 */
export const RESOLVABLE_MASTER_TARGETS: RelationshipTarget[] = [
  "asset_category",
  "supplier",
  "room",
  "store",
  "department",
  "employee",
  ...NAMED_MASTER_SOURCES.map(([target]) => target),
];

/**
 * The real NEØ masters an import resolves against. Imports create
 * relationships, not strings, so these are the only permitted match targets.
 */
export function useOnboardingMasters(domain: OnboardingDomain | undefined) {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const targets = domain?.linksTo ?? [];

  // Departments and people always come from the shared scoped catalogue, so an
  // import can never resolve a value against another property's records.
  const scopedDepartments = useScopedDepartments();
  const scopedWorkers = useScopedWorkers();

  const query = useQuery({
    queryKey: [...KEY, "masters", organizationId, branchId, targets.join(",")],
    enabled: Boolean(organizationId) && targets.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const masters: Partial<Record<RelationshipTarget, MasterOption[]>> = {};

      const load = async (
        table: string,
        select: string,
        toOption: (row: Record<string, unknown>) => MasterOption,
        scoped = true,
      ): Promise<MasterOption[]> => {
        let query = db.from(table).select(select).limit(2000);
        if (scoped && branchId) query = query.or(`branch_id.eq.${branchId},branch_id.is.null`);
        const { data, error } = await query;
        if (error) return [];
        return ((data ?? []) as Record<string, unknown>[]).map(toOption).filter((o) => o.label);
      };

      if (targets.includes("asset_category")) {
        masters.asset_category = await load(
          "asset_categories",
          "id, name, code",
          (r) => ({
            id: String(r["id"]),
            label: String(r["name"] ?? ""),
            aliases: r["code"] ? [String(r["code"])] : [],
          }),
          false,
        );
      }
      if (targets.includes("supplier")) {
        masters.supplier = await load("suppliers", "id, name, code", (r) => ({
          id: String(r["id"]),
          label: String(r["name"] ?? ""),
          aliases: r["code"] ? [String(r["code"])] : [],
        }));
      }
      if (targets.includes("room")) {
        masters.room = await load("rooms", "id, room_number", (r) => ({
          id: String(r["id"]),
          label: `Room ${String(r["room_number"] ?? "")}`.trim(),
          aliases: [String(r["room_number"] ?? "")],
        }));
      }
      if (targets.includes("store")) {
        masters.store = await load("stock_locations", "id, name, code", (r) => ({
          id: String(r["id"]),
          label: String(r["name"] ?? ""),
          aliases: r["code"] ? [String(r["code"])] : [],
        }));
      }
      // Named masters that behave alike: a label plus an optional code alias.
      const named = NAMED_MASTER_SOURCES;
      for (const [target, table, select, labelColumn, scoped] of named) {
        if (!targets.includes(target)) continue;
        masters[target] = await load(
          table,
          select,
          (r) => {
            const aliases: string[] = [];
            for (const key of ["code", "account_number", "customer_number", "trading_name"]) {
              if (r[key]) aliases.push(String(r[key]));
            }
            return { id: String(r["id"]), label: String(r[labelColumn] ?? ""), aliases };
          },
          scoped,
        );
      }
      return masters;
    },
  });

  return {
    ...query,
    data: useMemo(() => {
      const merged: Partial<Record<RelationshipTarget, MasterOption[]>> = { ...(query.data ?? {}) };
      if (targets.includes("department")) {
        merged.department = (scopedDepartments.data ?? []).map((d) => ({
          id: d.id,
          label: d.name,
          aliases: d.catalogue_key ? [d.catalogue_key] : [],
        }));
      }
      if (targets.includes("employee")) {
        merged.employee = (scopedWorkers.data ?? []).map((w) => ({
          id: w.id,
          label: w.full_name,
          aliases: w.staff_id ? [w.staff_id] : [],
        }));
      }
      return merged;
    }, [query.data, scopedDepartments.data, scopedWorkers.data, targets.join(",")]),
  };
}

/**
 * Existing record identities for duplicate protection, in the same shape the
 * engine computes for an incoming row. The columns come from the domain's
 * declared duplicate keys, so every adapter is protected the same way.
 */
export function useExistingIdentities(domain: OnboardingDomain | undefined) {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const adapter = domain ? adapterFor(domain.key) : undefined;

  return useQuery({
    queryKey: [...KEY, "identities", domain?.key ?? null, organizationId, branchId],
    enabled: Boolean(organizationId) && Boolean(adapter),
    staleTime: 30_000,
    queryFn: async () => {
      const map = new Map<string, string>();
      if (!domain || !adapter) return map;
      const columns = ["id", ...new Set(adapter.identityColumns)].join(", ");
      let query = db.from(adapter.table).select(columns).limit(5000);
      if (adapter.branchScoped && branchId) query = query.eq("branch_id", branchId);
      const { data, error } = await query;
      if (error) return map;
      for (const row of (data ?? []) as Record<string, unknown>[]) {
        const id = String(row["id"]);
        for (const fields of domain.duplicateKeys) {
          const parts = fields.map((field) =>
            String(row[columnForField(adapter, field)] ?? "").trim().toLowerCase(),
          );
          if (parts.some((p) => !p)) continue;
          map.set(`${fields.join("+")}::${parts.join("|")}`, id);
        }
      }
      return map;
    },
  });
}

/** The highest identifier NEØ has issued, so a generated run continues rather than restarts. */
async function nextIdentifierSeed(
  table: string,
  column: string,
  branchId: string | null,
  branchScoped: boolean,
): Promise<number> {
  let query = db.from(table).select(column).not(column, "is", null).limit(5000);
  if (branchScoped && branchId) query = query.eq("branch_id", branchId);
  const { data } = await query;
  let highest = 0;
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const match = /(\d+)\s*$/.exec(String(row[column] ?? ""));
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

// ------------------------------------------------------------------ batches

export function useOnboardingBatches() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [...KEY, "batches", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await db
        .from("data_migration_batches")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as BatchRow[];
    },
  });
}

export function useOnboardingBatch(batchId: string | null) {
  return useQuery({
    queryKey: [...KEY, "batch", batchId],
    enabled: Boolean(batchId),
    refetchInterval: (query) => {
      const stage = (query.state.data as BatchRow | undefined)?.["stage"];
      return stage === "importing" ? 1200 : false;
    },
    queryFn: async () => {
      const { data, error } = await db.from("data_migration_batches").select("*").eq("id", batchId).maybeSingle();
      if (error) throw error;
      return (data ?? null) as BatchRow | null;
    },
  });
}

export function useOnboardingBatchRows(batchId: string | null, limit = 400) {
  return useQuery({
    queryKey: [...KEY, "rows", batchId, limit],
    enabled: Boolean(batchId),
    queryFn: async () => {
      const { data, error } = await db
        .from("data_migration_rows")
        .select("*")
        .eq("batch_id", batchId)
        .order("row_number", { ascending: true })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as BatchRow[];
    },
  });
}

/**
 * Brings a batch that was recorded outside the onboarding engine — an older
 * validation-only run, for instance — into the one canonical lifecycle, with
 * its uploaded rows preserved exactly as they were stored. Nothing is
 * re-uploaded and no second batch is created.
 */
export function useAdoptBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (batchId: string) => {
      const { data, error } = await db
        .from("data_migration_batches")
        .update({ stage: "draft", status: "draft", entry_point: "data_migration" })
        .eq("id", batchId)
        .is("reversed_at", null)
        .select()
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("That batch can no longer be continued.");
      await logAudit({
        action: "onboarding.batch_adopted",
        module: "administration",
        recordId: batchId,
        newValue: { stage: "draft" },
      });
      return data as BatchRow;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...KEY] });
      toast.success("Batch reopened — its rows were kept, so nothing needs uploading again.");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

// -------------------------------------------------------- mapping templates

export function useMappingTemplates(dataType: string | undefined) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [...KEY, "mapping-templates", organizationId, dataType ?? null],
    enabled: Boolean(organizationId) && Boolean(dataType),
    queryFn: async () => {
      const { data, error } = await db
        .from("onboarding_mapping_templates")
        .select("*")
        .eq("data_type", dataType as string)
        .order("name", { ascending: true });
      if (error) throw error;
      return (data ?? []) as BatchRow[];
    },
  });
}

export function useSaveMappingTemplate() {
  const { organizationId, user } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      dataType: string;
      name: string;
      mapping: Record<string, string>;
      transforms: string[];
      ignoredFields: string[];
    }) => {
      const name = input.name.trim();
      if (!name) throw new Error("Give the mapping a name so it can be reused.");
      const { error } = await db.from("onboarding_mapping_templates").upsert(
        {
          organization_id: organizationId,
          data_type: input.dataType,
          name,
          mapping: input.mapping,
          transforms: input.transforms,
          ignored_fields: input.ignoredFields,
          created_by: user?.id ?? null,
        } as never,
        { onConflict: "organization_id,data_type,name" },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Mapping saved for reuse");
      void qc.invalidateQueries({ queryKey: [...KEY, "mapping-templates"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Lineage answer: where did this record come from? */
export function useRecordLineage(recordId: string | null | undefined) {
  return useQuery({
    queryKey: [...KEY, "lineage", recordId ?? null],
    enabled: Boolean(recordId),
    queryFn: async () => {
      const { data, error } = await db
        .from("data_migration_rows")
        .select("row_number, imported_at, batch_id, data_migration_batches(reference, source_filename, created_at, created_by, data_type)")
        .eq("imported_record_id", recordId)
        .maybeSingle();
      if (error) return null;
      return (data ?? null) as BatchRow | null;
    },
  });
}

/**
 * Everything the wizard needs to reopen exactly where the administrator left
 * it. Held on the batch itself, so a close, a refresh or a different machine
 * resumes the same work rather than restarting the analysis.
 */
export type WorkingState = {
  filename: string;
  sheet: string;
  headers: string[];
  mapping: Record<string, string>;
  transforms: TransformKey[];
  ignoredFields: string[];
  decisions: Record<string, string>;
  rowDecisions: Record<string, "skip" | "import" | "update">;
  identifierChoice: string;
  autoAccept: boolean;
  step: string;
};

/** Stages a batch is allowed to be discarded from — nothing live exists yet. */
export const DISCARDABLE_STAGES = ["draft", "prepared", "ready", "failed"];

/** Batch stages owned by the onboarding engine, never by the legacy workflow. */
export const ENGINE_STAGES = [
  "draft",
  "prepared",
  "ready",
  "importing",
  "completed",
  "completed_with_exceptions",
  "failed",
  "reversed",
  "discarded",
];

export function isEngineBatch(batch: BatchRow): boolean {
  return Boolean(batch["entry_point"]) || ENGINE_STAGES.includes(String(batch["stage"] ?? ""));
}

export function workingStateOf(batch: BatchRow | null | undefined): WorkingState | null {
  const report = (batch?.["profile_report"] ?? {}) as Record<string, unknown>;
  const state = report["working_state"];
  return state && typeof state === "object" ? (state as WorkingState) : null;
}

/** Drafts an administrator can pick up again, newest first. */
export function useOnboardingDrafts(domainKey: string | undefined) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [...KEY, "drafts", organizationId, domainKey ?? null],
    enabled: Boolean(organizationId) && Boolean(domainKey),
    queryFn: async () => {
      const { data, error } = await db
        .from("data_migration_batches")
        .select("*")
        .eq("data_type", domainKey)
        .in("stage", ["draft", "prepared"])
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as BatchRow[];
    },
  });
}

export type DraftInput = {
  batchId?: string | null;
  domain: OnboardingDomain;
  entryPoint: string;
  working: WorkingState;
  /** Source rows exactly as read from the file; only written when the draft is created. */
  sourceRows: Record<string, unknown>[];
};

/**
 * Saves the work in progress. The source rows are written once, so reopening a
 * draft never asks for the file again; mappings and decisions are overwritten
 * on every save.
 */
export function useSaveDraft() {
  const { organizationId, user } = useAuth();
  const branchId = useWriteBranchId();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: DraftInput): Promise<BatchRow> => {
      if (input.batchId) {
        const { data, error } = await db
          .from("data_migration_batches")
          .update({
            column_mapping: input.working.mapping,
            field_mapping: input.working.mapping,
            transformations: input.working.transforms,
            resolutions: input.working.decisions,
            profile_report: { working_state: input.working },
          })
          .eq("id", input.batchId)
          .in("stage", ["draft", "prepared"])
          .select()
          .maybeSingle();
        if (error) throw error;
        if (!data) throw new Error("This draft can no longer be edited.");
        return data as BatchRow;
      }

      const { data, error } = await db
        .from("data_migration_batches")
        .insert({
          organization_id: organizationId,
          branch_id: branchId,
          reference: reference("IMP"),
          data_type: input.domain.key,
          target_module: input.domain.module,
          entry_point: input.entryPoint,
          status: "draft",
          stage: "draft",
          source_filename: `${input.working.filename}${input.working.sheet ? ` · ${input.working.sheet}` : ""}`,
          row_count: input.sourceRows.length,
          column_mapping: input.working.mapping,
          field_mapping: input.working.mapping,
          transformations: input.working.transforms,
          resolutions: input.working.decisions,
          profile_report: { working_state: input.working },
          created_by: user?.id ?? null,
        })
        .select()
        .maybeSingle();
      if (error) throw error;
      const batch = data as BatchRow;

      const payload = input.sourceRows.map((raw, index) => ({
        organization_id: organizationId,
        batch_id: batch["id"],
        row_number: index + 1,
        raw_values: raw,
        status: "draft",
      }));
      for (let i = 0; i < payload.length; i += 500) {
        const { error: rowError } = await db.from("data_migration_rows").insert(payload.slice(i, i + 500));
        if (rowError) throw rowError;
      }

      await logAudit({
        action: "onboarding.draft_saved",
        module: "administration",
        recordId: String(batch["id"]),
        newValue: { data_type: input.domain.key, rows: input.sourceRows.length, file: input.working.filename },
      });
      return batch;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...KEY, "drafts"] });
      void qc.invalidateQueries({ queryKey: [...KEY, "batches"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

// ------------------------------------------------------- inline master create

/**
 * Creates a missing master from inside an import — and only where the shared
 * resolution contract grants CREATE_INLINE for that relationship target.
 *
 * The record is written through the owning domain's own adapter, so it obeys
 * the same tenant and property scope, the same columns and the same duplicate
 * protection as a full import of that domain. Nothing is invented: the only
 * value written is the label the hotel's own file contained. An existing
 * record with the same label is reused rather than duplicated.
 */
export function useCreateMaster() {
  const { organizationId, user, can } = useAuth();
  const branchId = useWriteBranchId();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: { target: RelationshipTarget; label: string }): Promise<MasterOption> => {
      const policy = matchPolicy(input.target);
      const spec = policy.inlineSpec;
      if (!policy.inlineCreate || !spec) {
        throw new Error(
          `${policy.label} records are owned by ${policy.ownedBy} and cannot be created from an import.`,
        );
      }
      if (!can(spec.capability.module, spec.capability.action)) {
        throw new Error(`You do not have permission to create a ${policy.label.toLowerCase()}.`);
      }
      const label = input.label.trim();
      if (!label) throw new Error(`A ${policy.label.toLowerCase()} needs a name.`);

      const adapter = adapterFor(spec.adapterKey);
      if (!adapter) throw new Error("This record has no destination configured in NEØ.");
      const labelColumn = columnForField(adapter, spec.labelField);

      // Duplicate protection first: an import never creates a second copy of a
      // record the hotel already has.
      let existingQuery = db.from(adapter.table).select(`id, ${labelColumn}`).ilike(labelColumn, label).limit(1);
      if (organizationId) existingQuery = existingQuery.eq("organization_id", organizationId);
      if (adapter.branchScoped && branchId) existingQuery = existingQuery.eq("branch_id", branchId);
      const { data: existing } = await existingQuery;
      const found = ((existing ?? []) as Record<string, unknown>[])[0];
      if (found) {
        return { id: String(found["id"]), label: String(found[labelColumn] ?? label), aliases: [] };
      }

      const { data: created, error } = await db
        .from(adapter.table)
        .insert({
          [labelColumn]: label,
          organization_id: organizationId,
          ...(adapter.branchScoped ? { branch_id: branchId } : {}),
          ...(adapter.noCreatedBy ? {} : { created_by: user?.id ?? null }),
        })
        .select(`id, ${labelColumn}`)
        .maybeSingle();
      if (error) throw error;
      if (!created) throw new Error("The record could not be created.");

      await logAudit({
        action: "onboarding.master_created_inline",
        module: "administration",
        recordId: String((created as Record<string, unknown>)["id"]),
        newValue: { target: input.target, table: adapter.table, label, source: "data_onboarding" },
      });

      return { id: String((created as Record<string, unknown>)["id"]), label, aliases: [] };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...KEY, "masters"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Discards work that never became live records. A setup mistake should cost a
 * click, not a support request — but anything that has already written a record
 * is refused here and must go through reversal instead.
 */
export function useDiscardBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (batchId: string) => {
      const { data, error } = await db
        .from("data_migration_batches")
        .select("id, stage, reference, data_type, imported_rows")
        .eq("id", batchId)
        .maybeSingle();
      if (error) throw error;
      const batch = data as BatchRow | null;
      if (!batch) throw new Error("That batch no longer exists.");
      if (Number(batch["imported_rows"] ?? 0) > 0) {
        throw new Error("This batch already created records. Reverse it instead of discarding it.");
      }
      if (!DISCARDABLE_STAGES.includes(String(batch["stage"] ?? ""))) {
        throw new Error("Only a draft or a prepared batch can be discarded.");
      }

      const { error: rowError } = await db.from("data_migration_rows").delete().eq("batch_id", batchId);
      if (rowError) throw rowError;
      const { error: deleteError } = await db.from("data_migration_batches").delete().eq("id", batchId);
      if (deleteError) throw deleteError;

      await logAudit({
        action: "onboarding.batch_discarded",
        module: "administration",
        recordId: batchId,
        previousValue: { reference: batch["reference"], data_type: batch["data_type"], stage: batch["stage"] },
      });
      return batchId;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...KEY] });
      toast.success("Batch discarded — nothing was written to your records");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export type StagedBatchInput = {
  batchId?: string | null;
  domain: OnboardingDomain;
  filename: string;
  sheet: string;
  mapping: Record<string, string>;
  transforms: TransformKey[];
  decisions: Record<string, string>;
  generateIdentifiers: boolean;
  ignoredFields: string[];
  prepared: PreparedRow[];
  profile: Record<string, unknown>;
  working: WorkingState;
  /** Only a reconciled plan with every mandatory decision made becomes Ready. */
  ready: boolean;
  entryPoint: string;
};

/**
 * Stages the reviewed batch. Still writes no operational record: it saves the
 * prepared rows and marks the batch Ready only when the plan reconciles and
 * nothing mandatory is still open.
 */
export function useStageBatch() {
  const { organizationId, user } = useAuth();
  const branchId = useWriteBranchId();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: StagedBatchInput) => {
      const stage = input.ready ? "ready" : "prepared";
      const common = {
        data_type: input.domain.key,
        target_module: input.domain.module,
        entry_point: input.entryPoint,
        status: stage,
        stage,
        source_filename: `${input.filename}${input.sheet ? ` · ${input.sheet}` : ""}`,
        row_count: input.prepared.length,
        valid_rows: input.prepared.filter((r) => r.action !== "skip").length,
        invalid_rows: input.prepared.filter((r) => r.severity === "blocker").length,
        column_mapping: input.mapping,
        field_mapping: input.mapping,
        transformations: input.transforms,
        resolutions: input.decisions,
        profile_report: { ...input.profile, working_state: input.working },
        validation_summary: input.profile,
        dry_run_summary: input.profile,
      };

      let batch: BatchRow;
      if (input.batchId) {
        const { data, error } = await db
          .from("data_migration_batches")
          .update(common)
          .eq("id", input.batchId)
          .in("stage", ["draft", "prepared", "ready"])
          .select()
          .maybeSingle();
        if (error) throw error;
        if (!data) throw new Error("This batch can no longer be prepared — it has already been imported.");
        batch = data as BatchRow;
        // Nothing has been written yet, so the candidate rows are simply replaced.
        const { error: clearError } = await db
          .from("data_migration_rows")
          .delete()
          .eq("batch_id", input.batchId)
          .is("imported_at", null);
        if (clearError) throw clearError;
      } else {
        const { data, error } = await db
          .from("data_migration_batches")
          .insert({
            ...common,
            organization_id: organizationId,
            branch_id: branchId,
            reference: reference("IMP"),
            created_by: user?.id ?? null,
          })
          .select()
          .maybeSingle();
        if (error) throw error;
        batch = data as BatchRow;
      }

      const payload = input.prepared.map((row) => ({
        organization_id: organizationId,
        batch_id: batch["id"],
        row_number: row.rowNumber,
        raw_values: row.raw,
        normalized_values: {
          ...row.values,
          _resolved: Object.fromEntries(
            Object.entries(row.resolutions).map(([field, resolution]) => [
              field,
              resolution.state === "resolved" ? resolution.matchId : null,
            ]),
          ),
        },
        status: row.severity === "blocker" ? "invalid" : row.duplicateOf ? "duplicate" : "valid",
        severity: row.severity,
        action: row.action,
        row_key: row.identity,
        decisions: {},
        errors: row.issues.filter((i) => i.severity === "blocker").map((i) => i.message),
        warnings: row.issues.filter((i) => i.severity !== "blocker").map((i) => i.message),
        duplicate_of: row.duplicateOf,
      }));

      for (let i = 0; i < payload.length; i += 500) {
        const { error: rowError } = await db.from("data_migration_rows").insert(payload.slice(i, i + 500));
        if (rowError) throw rowError;
      }

      await logAudit({
        action: "onboarding.batch_staged",
        module: "administration",
        recordId: String(batch["id"]),
        newValue: {
          data_type: input.domain.key,
          rows: input.prepared.length,
          file: input.filename,
          stage,
        },
      });
      return batch;
    },
    onSuccess: (_batch, input) => {
      void qc.invalidateQueries({ queryKey: [...KEY, "batches"] });
      void qc.invalidateQueries({ queryKey: [...KEY, "drafts"] });
      toast.success(
        input.ready
          ? "Batch prepared and ready — review the plan, then import"
          : "Work saved. The import stays locked until every decision is made.",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

// ---------------------------------------------------------------- execution

type ExecuteResult = { imported: number; failed: number; remaining: number };

/**
 * Runs the batch in chunks against the caller's own permissions, so tenant and
 * property isolation and row-level security apply exactly as they do for
 * manual entry. Only pending rows are touched, so a retry is always safe.
 */
export function useRunImport() {
  const { organizationId, user } = useAuth();
  const branchId = useWriteBranchId();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: { batchId: string; generateIdentifiers: boolean }): Promise<ExecuteResult> => {
      const { data: batchData, error: batchError } = await db
        .from("data_migration_batches")
        .select("*")
        .eq("id", input.batchId)
        .maybeSingle();
      if (batchError) throw batchError;
      const batch = batchData as BatchRow | null;
      if (!batch) throw new Error("That import batch no longer exists.");
      if (batch["reversed_at"]) throw new Error("This batch was reversed and cannot be re-run.");
      // The readiness gate is enforced here as well as in the wizard, so no
      // route, retry or refresh can import a batch with decisions still open.
      const currentStage = String(batch["stage"] ?? "");
      if (!["ready", "importing", "completed_with_exceptions", "failed"].includes(currentStage)) {
        throw new Error(
          currentStage === "draft" || currentStage === "prepared"
            ? "This batch still has open decisions. Finish resolving it, then import."
            : "This batch is not in a state that can be imported.",
        );
      }
      const domain = domainByKey(String(batch["data_type"] ?? ""));
      const adapter = domain ? adapterFor(domain.key) : undefined;
      if (!domain || !adapter) {
        throw new Error("This data type cannot be imported yet — it has no destination configured in NEØ.");
      }
      if (adapter.branchRequired && !branchId) {
        throw new Error(`${domain.label} records belong to a specific property. Select a property, then run the import.`);
      }
      const identifierPolicy = adapter.generated ? domain.identifierPolicies?.[adapter.generated.field] : undefined;

      await db
        .from("data_migration_batches")
        .update({ stage: "importing", status: "importing" })
        .eq("id", input.batchId);

      const { data: pendingData, error: pendingError } = await db
        .from("data_migration_rows")
        .select("id, row_number, normalized_values, action, duplicate_of, severity")
        .eq("batch_id", input.batchId)
        .is("imported_at", null)
        .in("action", ["create", "update"])
        .order("row_number", { ascending: true })
        .limit(10000);
      if (pendingError) throw pendingError;
      const pending = (pendingData ?? []) as BatchRow[];

      const generating = input.generateIdentifiers && Boolean(adapter.generated);
      let identifierSeed =
        generating && adapter.generated
          ? await nextIdentifierSeed(adapter.table, adapter.generated.column, branchId, adapter.branchScoped)
          : 0;
      let imported = 0;
      let failed = 0;

      for (let i = 0; i < pending.length; i += 50) {
        const chunk = pending.slice(i, i + 50);
        for (const row of chunk) {
          const values = (row["normalized_values"] ?? {}) as Record<string, unknown>;
          const resolved = (values["_resolved"] ?? {}) as Record<string, string | null>;

          let issuedIdentifier: string | null = null;
          if (generating && adapter.generated) {
            const existing = String(values[adapter.generated.field] ?? "").trim();
            if (!existing) {
              identifierSeed += 1;
              const prefix = identifierPolicy?.prefix ?? "";
              const padding = identifierPolicy?.padding ?? 5;
              issuedIdentifier = `${prefix}${String(identifierSeed).padStart(padding, "0")}`;
            }
          }

          const payload = buildPayload(adapter, values, resolved, issuedIdentifier);

          try {
            let recordId: string | null = null;
            if (adapter.key === "stock_items") {
              // Inventory items are never written straight into the table: the
              // canonical service applies the same permission, property,
              // duplicate and audit rules the Inventory screen applies.
              const { data: savedId, error } = await guardedRpc(db, "neo_stock_item_save", {
                _id: row["action"] === "update" && row["duplicate_of"] ? String(row["duplicate_of"]) : null,
                _branch: branchId,
                _payload: payload,
              } as never);
              if (error) throw error;
              recordId = savedId ? String(savedId) : null;
            } else if (row["action"] === "update" && row["duplicate_of"]) {
              const { error } = await db.from(adapter.table).update(payload).eq("id", row["duplicate_of"]);
              if (error) throw error;
              recordId = String(row["duplicate_of"]);
            } else {
              const { data: created, error } = await db
                .from(adapter.table)
                .insert({
                  ...payload,
                  organization_id: organizationId,
                  ...(adapter.branchScoped ? { branch_id: branchId } : {}),
                  ...(adapter.noCreatedBy ? {} : { created_by: user?.id ?? null }),
                })
                .select("id")
                .maybeSingle();
              if (error) throw error;
              recordId = created ? String((created as Record<string, unknown>)["id"]) : null;
            }
            await db
              .from("data_migration_rows")
              .update({
                imported_record_id: recordId,
                imported_at: new Date().toISOString(),
                status: "imported",
                error_message: null,
              })
              .eq("id", row["id"]);
            imported += 1;
          } catch (error) {
            failed += 1;
            await db
              .from("data_migration_rows")
              .update({
                status: "failed",
                severity: "blocker",
                error_message: error instanceof Error ? error.message : "Unknown failure",
              })
              .eq("id", row["id"]);
          }
        }

        await db
          .from("data_migration_batches")
          .update({
            processed_rows: Number(batch["processed_rows"] ?? 0) + imported + failed,
            imported_rows: Number(batch["imported_rows"] ?? 0) + imported,
            failed_rows: Number(batch["failed_rows"] ?? 0) + failed,
          })
          .eq("id", input.batchId);
      }

      const stage = failed === 0 ? "completed" : imported === 0 ? "failed" : "completed_with_exceptions";
      await db
        .from("data_migration_batches")
        .update({
          stage,
          status: stage === "failed" ? "failed" : "imported",
          processed_rows: Number(batch["processed_rows"] ?? 0) + imported + failed,
          imported_rows: Number(batch["imported_rows"] ?? 0) + imported,
          failed_rows: Number(batch["failed_rows"] ?? 0) + failed,
          import_summary: { imported, failed, attempted: pending.length },
        })
        .eq("id", input.batchId);

      await logAudit({
        action: "onboarding.batch_imported",
        module: "administration",
        recordId: input.batchId,
        newValue: { imported, failed, attempted: pending.length },
      });

      return { imported, failed, remaining: 0 };
    },
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: [...KEY] });
      void qc.invalidateQueries();
      if (result.failed === 0) toast.success(`${result.imported} record(s) imported`);
      else toast.warning(`${result.imported} imported, ${result.failed} could not be created`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Reverses an eligible batch. Records that have since acquired operational
 * dependencies are refused rather than deleted, and the batch keeps its full
 * lineage afterwards.
 */
export function useReverseBatch() {
  const { user } = useAuth();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (batchId: string) => {
      const { data: batchRow } = await db
        .from("data_migration_batches")
        .select("data_type")
        .eq("id", batchId)
        .maybeSingle();
      const adapter = adapterFor(String((batchRow as BatchRow | null)?.["data_type"] ?? ""));
      if (!adapter) throw new Error("This batch's data type has no destination in NEØ, so it cannot be reversed here.");

      const { data, error } = await db
        .from("data_migration_rows")
        .select("id, imported_record_id")
        .eq("batch_id", batchId)
        .not("imported_record_id", "is", null)
        .limit(10000);
      if (error) throw error;
      const rows = (data ?? []) as BatchRow[];
      const ids = rows.map((r) => String(r["imported_record_id"]));
      if (ids.length === 0) throw new Error("This batch created no records, so there is nothing to reverse.");

      const dependent = new Set<string>();
      for (const { table, column } of adapter.dependents ?? []) {
        const { data: deps } = await db.from(table).select(column).in(column, ids).limit(10000);
        for (const dep of (deps ?? []) as Record<string, unknown>[]) {
          if (dep[column]) dependent.add(String(dep[column]));
        }
      }

      const removable = ids.filter((id) => !dependent.has(id));
      if (removable.length) {
        const { error: deleteError } = await db.from(adapter.table).delete().in("id", removable);
        if (deleteError) throw deleteError;
        await db
          .from("data_migration_rows")
          .update({ status: "reversed", imported_record_id: null })
          .eq("batch_id", batchId)
          .in("imported_record_id", removable);
      }

      await db
        .from("data_migration_batches")
        .update({
          stage: "reversed",
          status: "reversed",
          reversed_at: new Date().toISOString(),
          reversed_by: user?.id ?? null,
          import_summary: { reversed: removable.length, retained_with_activity: dependent.size },
        })
        .eq("id", batchId);

      await logAudit({
        action: "onboarding.batch_reversed",
        module: "administration",
        recordId: batchId,
        newValue: { reversed: removable.length, retained_with_activity: dependent.size },
      });

      return { reversed: removable.length, retained: dependent.size };
    },
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: [...KEY] });
      void qc.invalidateQueries();
      toast.success(
        result.retained
          ? `${result.reversed} reversed · ${result.retained} kept because they already have activity`
          : `${result.reversed} imported record(s) reversed`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Convenience for module entry points ("Import Assets" inside a module). */
export function useDomainEntryPoint() {
  return useCallback((domainKey: string) => `/platform/migration?domain=${domainKey}`, []);
}
