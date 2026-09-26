/**
 * Phase 17 — Platform readiness data layer.
 *
 * Every read and write is organization-scoped by RLS; this module never
 * assumes tenancy on its own. Integration records store secret *names* and a
 * masked identifier only — never credentials.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { reference } from "@/lib/platform";

type Row = Record<string, any>;

const sb = supabase as unknown as {
  from: (t: string) => any;
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

const KEY = "platform";

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: [KEY] });
}

export function usePlatformAudit() {
  const { user, organizationId, profile } = useAuth();
  return async (action: string, recordId: string | null, newValue?: unknown, reason?: string, previousValue?: unknown) => {
    await logAudit({
      organizationId: organizationId ?? null,
      userId: user?.id ?? null,
      userName: profile?.full_name ?? undefined,
      action,
      module: "platform",
      recordId,
      newValue,
      previousValue,
      reason: reason ?? null,
    });
  };
}

function fail(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

function useList(table: string, options?: { order?: string; ascending?: boolean; filters?: Row; limit?: number }) {
  return useQuery({
    queryKey: [KEY, table, options ?? null],
    queryFn: async () => {
      let q = sb.from(table).select("*");
      for (const [k, v] of Object.entries(options?.filters ?? {})) {
        if (v !== undefined && v !== null && v !== "") q = q.eq(k, v);
      }
      q = q.order(options?.order ?? "created_at", { ascending: options?.ascending ?? false });
      if (options?.limit) q = q.limit(options.limit);
      const { data, error } = await q;
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

// ---------------------------------------------------------------- platform
export function useIsPlatformAdmin() {
  return useQuery({
    queryKey: [KEY, "is-platform-admin"],
    queryFn: async () => {
      const { data, error } = await guardedRpc(sb, "is_platform_admin");
      if (error) return false;
      return Boolean(data);
    },
  });
}

export function useEnvironments() {
  return useList("environment_registry", { order: "key", ascending: true });
}

export function useFeatureFlags() {
  return useList("feature_flags", { order: "key", ascending: true });
}

export function useFeatureFlagOverrides() {
  return useList("feature_flag_overrides");
}

export function useSubscriptionPlans() {
  return useList("subscription_plans", { order: "code", ascending: true });
}

export function useSupportPlans() {
  return useList("support_plans", { order: "code", ascending: true });
}

export function useOrganizationSubscription() {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [KEY, "subscription", organizationId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("organization_subscriptions")
        .select("*")
        .eq("organization_id", organizationId)
        .maybeSingle();
      fail(error);
      return (data ?? null) as Row | null;
    },
  });
}

export function useSubscriptionEvents() {
  return useList("subscription_events");
}

export function useEntitlements() {
  return useList("organization_entitlements", { order: "feature_key", ascending: true });
}

export function useUpsertSubscription() {
  const { organizationId } = useAuth();
  const invalidate = useInvalidate();
  const audit = usePlatformAudit();
  return useMutation({
    mutationFn: async (values: Row) => {
      const payload = { ...values, organization_id: organizationId };
      const { data, error } = await sb
        .from("organization_subscriptions")
        .upsert(payload, { onConflict: "organization_id" })
        .select()
        .maybeSingle();
      fail(error);
      await audit("subscription.updated", (data as Row | null)?.["id"] ?? null, payload);
      return data as Row;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Subscription record updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

// ------------------------------------------------------------ integrations
export function useIntegrationProviders() {
  return useList("integration_providers", { order: "sort_order", ascending: true });
}

export function useIntegrationConnections() {
  return useList("integration_connections", { order: "provider_code", ascending: true });
}

export function useIntegrationEvents(filters?: Row) {
  return useList("integration_events", { filters: filters ?? {}, limit: 200 });
}

export function useWebhookReceipts() {
  return useList("integration_webhook_receipts", { order: "received_at", limit: 100 });
}

export function useIntegrationTestRuns() {
  return useList("integration_test_runs", { limit: 100 });
}

export function useSaveConnection() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = usePlatformAudit();
  return useMutation({
    mutationFn: async (values: Row) => {
      const payload: Row = {
        ...values,
        organization_id: organizationId,
        created_by: values["created_by"] ?? user?.id ?? null,
      };
      const { data, error } = values["id"]
        ? await sb.from("integration_connections").update(payload).eq("id", values["id"]).select().maybeSingle()
        : await sb.from("integration_connections").insert(payload).select().maybeSingle();
      fail(error);
      await audit("integration.connection_saved", (data as Row | null)?.["id"] ?? null, {
        provider_code: payload["provider_code"],
        environment: payload["environment"],
        status: payload["status"],
      });
      return data as Row;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Connection record saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** What a provider declares about itself before anyone may connect to it. */
export type ProviderRequirement = {
  key: string;
  label: string;
  kind: "secret" | "setting" | "evidence";
  required?: boolean;
  help?: string | null;
};

export type ProviderDeclaration = {
  code: string;
  name: string;
  category: string;
  purpose?: string | null;
  capabilities: string[];
  requirements: ProviderRequirement[];
  requiredSecretNames?: string[];
  documentationUrl?: string | null;
  supportContact?: string | null;
  supportsWebhooks?: boolean;
  supportsSandbox?: boolean;
  requiresPartnerApproval?: boolean;
};

/**
 * A provider declares itself into the registry. The database refuses a
 * declaration with no category, no capability or no stated requirement, so an
 * undeclared provider can never be presented as connectable.
 */
export function useDeclareProvider() {
  const invalidate = useInvalidate();
  const audit = usePlatformAudit();
  return useMutation({
    mutationFn: async (input: ProviderDeclaration) => {
      const { data, error } = await guardedRpc(sb, "neo_provider_declare", {
        _code: input.code,
        _name: input.name,
        _category: input.category,
        _purpose: input.purpose ?? null,
        _capabilities: input.capabilities,
        _requirements: input.requirements,
        _required_secret_names: input.requiredSecretNames ?? [],
        _documentation_url: input.documentationUrl ?? null,
        _support_contact: input.supportContact ?? null,
        _supports_webhooks: input.supportsWebhooks ?? false,
        _supports_sandbox: input.supportsSandbox ?? false,
        _requires_partner_approval: input.requiresPartnerApproval ?? false,
      });
      fail(error);
      await audit("integration.provider_declared", (data as Row | null)?.["id"] ?? null, {
        provider_code: input.code,
        category: input.category,
        capabilities: input.capabilities,
      });
      return data as Row;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Provider declaration recorded");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Records the outcome of a connection test. It does not fabricate a result:
 * the caller supplies what actually happened, and an untested provider stays
 * "not configured".
 */
export function useRecordConnectionTest() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = usePlatformAudit();
  return useMutation({
    mutationFn: async (input: {
      connection_id: string;
      provider_code: string;
      environment: string;
      test_type: string;
      status: string;
      response_summary?: string | undefined;
      error_message?: string | undefined;
    }) => {
      const { error } = await sb.from("integration_test_runs").insert({
        organization_id: organizationId,
        connection_id: input.connection_id,
        provider_code: input.provider_code,
        environment: input.environment,
        test_type: input.test_type,
        status: input.status,
        response_summary: input.response_summary ?? null,
        error_message: input.error_message ?? null,
        run_by: user?.id ?? null,
      });
      fail(error);

      const patch: Row =
        input.status === "passed"
          ? { sandbox_test_passed_at: new Date().toISOString(), last_error: null, last_error_at: null }
          : { last_error: input.error_message ?? "Test did not pass", last_error_at: new Date().toISOString() };
      const { error: upErr } = await sb.from("integration_connections").update(patch).eq("id", input.connection_id);
      fail(upErr);
      await audit("integration.test_recorded", input.connection_id, input);
      return true;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Test result recorded");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

// -------------------------------------------------------------- migration
export function useMigrationBatches() {
  return useList("data_migration_batches");
}

export function useMigrationRows(batchId: string | null) {
  return useQuery({
    queryKey: [KEY, "migration-rows", batchId],
    enabled: Boolean(batchId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("data_migration_rows")
        .select("*")
        .eq("batch_id", batchId)
        .order("row_number", { ascending: true })
        .limit(500);
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useCreateMigrationBatch() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = usePlatformAudit();
  return useMutation({
    mutationFn: async (input: { data_type: string; source_filename: string; rows: Row[]; summary: Row; mapping: Row }) => {
      const { data, error } = await sb
        .from("data_migration_batches")
        .insert({
          organization_id: organizationId,
          reference: reference("MIG"),
          data_type: input.data_type,
          source_filename: input.source_filename,
          status: "dry_run",
          row_count: input.rows.length,
          valid_rows: Number(input.summary["valid"] ?? 0),
          invalid_rows: Number(input.summary["invalid"] ?? 0),
          column_mapping: input.mapping,
          dry_run_summary: input.summary,
          validation_summary: input.summary,
          created_by: user?.id ?? null,
        })
        .select()
        .maybeSingle();
      fail(error);
      const batch = data as Row;
      if (input.rows.length) {
        const chunk = input.rows.slice(0, 500).map((r) => ({
          organization_id: organizationId,
          batch_id: batch["id"],
          row_number: Number(r["row_number"]),
          raw_values: r["raw"] ?? {},
          normalized_values: r["normalized"] ?? {},
          status: r["status"],
          errors: r["errors"] ?? [],
          warnings: r["warnings"] ?? [],
        }));
        const { error: rowErr } = await sb.from("data_migration_rows").insert(chunk);
        fail(rowErr);
      }
      await audit("migration.dry_run", batch["id"], { data_type: input.data_type, summary: input.summary });
      return batch;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Dry run recorded — review before approving");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useUpdateMigrationBatch() {
  const invalidate = useInvalidate();
  const audit = usePlatformAudit();
  return useMutation({
    mutationFn: async (input: { id: string; patch: Row; action: string }) => {
      const { error } = await sb.from("data_migration_batches").update(input.patch).eq("id", input.id);
      fail(error);
      await audit(`migration.${input.action}`, input.id, input.patch);
      return true;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Migration batch updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

// ---------------------------------------------------------------- quality
export function useTestSuites() {
  return useList("test_suites", { order: "code", ascending: true });
}
export function useTestCases() {
  return useList("test_cases", { order: "sort_order", ascending: true });
}
export function useTestRuns() {
  return useList("test_runs", { limit: 100 });
}
export function useDefects() {
  return useList("defects");
}
export function useUatSignoffs() {
  return useList("uat_signoffs", { order: "role_scope", ascending: true });
}
export function useSecurityFindings() {
  return useList("security_findings_register");
}
export function useServiceIncidents() {
  return useList("service_incidents");
}
export function useReadinessGates() {
  return useList("readiness_gates", { order: "sort_order", ascending: true });
}
export function useReleases() {
  return useList("releases", { order: "created_at" });
}
export function useMonitoringChecks() {
  return useList("monitoring_checks", { order: "code", ascending: true });
}
export function useBackupRecords() {
  return useList("backup_records", { order: "taken_at" });
}

/** Generic organization-scoped writer used by the quality and readiness screens. */
export function useSaveRecord(table: string, action: string) {
  const { organizationId } = useAuth();
  const invalidate = useInvalidate();
  const audit = usePlatformAudit();
  return useMutation({
    mutationFn: async (values: Row) => {
      const { id, ...rest } = values;
      const payload = { ...rest, organization_id: values["organization_id"] ?? organizationId };
      const { data, error } = id
        ? await sb.from(table).update(rest).eq("id", id).select().maybeSingle()
        : await sb.from(table).insert(payload).select().maybeSingle();
      fail(error);
      await audit(action, (data as Row | null)?.["id"] ?? id ?? null, payload);
      return data as Row;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useSeedReadinessGates() {
  const { organizationId } = useAuth();
  const invalidate = useInvalidate();
  const audit = usePlatformAudit();
  return useMutation({
    mutationFn: async (templates: Row[]) => {
      const payload = templates.map((t) => ({
        organization_id: organizationId,
        gate_key: t["gate_key"],
        name: t["name"],
        category: t["category"],
        mandatory: t["mandatory"] ?? true,
        sort_order: t["sort_order"] ?? 100,
        status: "not_started",
      }));
      const { error } = await sb.from("readiness_gates").upsert(payload, { onConflict: "organization_id,gate_key" });
      fail(error);
      await audit("readiness.checklist_created", null, { gates: payload.length });
      return true;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Go-live checklist created for this property");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

// ---------------------------------------------------------------- support
export function useSupportTickets() {
  return useList("support_tickets");
}

export function useTicketMessages(ticketId: string | null) {
  return useQuery({
    queryKey: [KEY, "ticket-messages", ticketId],
    enabled: Boolean(ticketId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("support_ticket_messages")
        .select("*")
        .eq("ticket_id", ticketId)
        .order("created_at", { ascending: true });
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useCreateTicket() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  const audit = usePlatformAudit();
  return useMutation({
    mutationFn: async (values: Row) => {
      const { data, error } = await sb
        .from("support_tickets")
        .insert({
          ...values,
          organization_id: organizationId,
          reference: reference("SUP"),
          created_by: user?.id ?? null,
        })
        .select()
        .maybeSingle();
      fail(error);
      await audit("support.ticket_raised", (data as Row | null)?.["id"] ?? null, {
        module: values["module"],
        severity: values["severity"],
      });
      return data as Row;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Support ticket raised");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAddTicketMessage() {
  const { organizationId, user } = useAuth();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: { ticket_id: string; body: string; internal_only?: boolean }) => {
      const { error } = await sb.from("support_ticket_messages").insert({
        organization_id: organizationId,
        ticket_id: input.ticket_id,
        author_id: user?.id ?? null,
        author_type: "customer",
        body: input.body,
        internal_only: input.internal_only ?? false,
      });
      fail(error);
      return true;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Reply added");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useSupportAccessGrants() {
  return useList("support_access_grants", { order: "granted_at" });
}

export function useKnowledgeArticles() {
  return useList("knowledge_articles", { order: "sort_order", ascending: true });
}
