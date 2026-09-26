/**
 * Canonical financial state.
 *
 * A transaction has two independent lives. Operationally a delivery is
 * received, an order is served, a folio is closed. Financially the same record
 * is pending, eligible, blocked, failed, posted or reversed. NEØ keeps those
 * two lives in separate columns and separate words, because the Owner UAT
 * showed what happens when they are collapsed: a goods receipt could read
 * "Posted" on one screen while Finance considered the same money blocked.
 *
 * Every module writes its outcome into `financial_states` through the database
 * writer, and every Finance surface reads it back through this one module. No
 * screen invents its own meaning of "posted" again.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

/* eslint-disable @typescript-eslint/no-explicit-any */
const rpc = (fn: string, args: Record<string, unknown>) =>
  (supabase as any).rpc(fn, args) as Promise<{ data: any; error: { message: string } | null }>;

export const FINANCIAL_STATUSES = [
  "not-applicable",
  "pending",
  "eligible",
  "blocked",
  "failed",
  "posted",
  "reversed",
] as const;

export type FinancialStatus = (typeof FINANCIAL_STATUSES)[number];

/**
 * Deliberately verbose labels. "Posted" on its own is the ambiguity this whole
 * repair exists to remove, so the financial vocabulary always says so.
 */
export const FINANCIAL_STATUS_LABELS: Record<FinancialStatus, string> = {
  "not-applicable": "No accounting effect",
  pending: "Awaiting completion",
  eligible: "Ready to post",
  blocked: "Blocked",
  failed: "Posting failed",
  posted: "GL posted",
  reversed: "Reversed",
};

export const FINANCIAL_STATUS_MEANING: Record<FinancialStatus, string> = {
  "not-applicable": "This record does not change any asset, liability, revenue, expense, cash or receivable balance.",
  pending: "The operational transaction is not yet complete, so no accounting entry is due.",
  eligible: "The transaction is complete and the accounting entry is due but not yet written.",
  blocked: "A control refused the posting. The reason must be resolved before the entry can exist.",
  failed: "The posting was attempted and errored. It can be retried once the cause is fixed.",
  posted: "A balanced journal exists in the general ledger for this transaction.",
  reversed: "The original posting was reversed. Both entries remain in the ledger.",
};

export type StatusTone = "default" | "success" | "warning" | "info" | "destructive";

export function financialStatusTone(status: string): StatusTone {
  switch (status as FinancialStatus) {
    case "posted":
      return "success";
    case "blocked":
    case "failed":
      return "destructive";
    case "reversed":
      return "warning";
    case "eligible":
      return "info";
    default:
      return "default";
  }
}

export function financialStatusLabel(status: string | null | undefined): string {
  if (!status) return "Unknown";
  return FINANCIAL_STATUS_LABELS[status as FinancialStatus] ?? status;
}

export function financialStatusMeaning(status: string | null | undefined): string {
  if (!status) return "This transaction has no recorded financial state yet.";
  return FINANCIAL_STATUS_MEANING[status as FinancialStatus] ?? "";
}

/** A financial state only ever asks for action when someone can act on it. */
export function financialResolutionAction(status: string | null | undefined): string | null {
  switch (status as FinancialStatus) {
    case "blocked":
      return "Resolve the stated reason, then post again";
    case "failed":
      return "Fix the cause and retry the posting";
    case "eligible":
      return "Post to the general ledger";
    default:
      return null;
  }
}

/** Which side of the transaction a status belongs to — never both at once. */
export function isFinanciallyPosted(status: string | null | undefined): boolean {
  return status === "posted";
}

export type FinancialStateRow = {
  id: string;
  branch_id: string | null;
  source_module: string;
  source_id: string;
  source_reference: string | null;
  operational_status: string | null;
  financial_status: FinancialStatus;
  reason: string | null;
  amount: number;
  currency: string;
  accounting_date: string | null;
  journal_id: string | null;
  journal_number: string | null;
  attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
  posted_at: string | null;
  reversed_at: string | null;
  updated_at: string;
};

export const FINANCIAL_MODULES = [
  { key: "pos", label: "Point of sale" },
  { key: "folio", label: "Folios" },
  { key: "event", label: "Events and banqueting" },
  { key: "laundry", label: "Laundry" },
  { key: "inventory-receipt", label: "Inventory receipts" },
  { key: "supplier-invoice", label: "Supplier invoices" },
  { key: "supplier-payment", label: "Supplier payments" },
  { key: "refund", label: "Refunds" },
  { key: "deposit", label: "Deposits" },
  { key: "adjustment", label: "Adjustments" },
] as const;

export function financialModuleLabel(module: string): string {
  return FINANCIAL_MODULES.find((m) => m.key === module)?.label ?? module;
}

export type FinancialStateFilter = {
  from?: string | null;
  to?: string | null;
  module?: string | null;
  status?: FinancialStatus | null;
};

/** The register behind every Finance tile, list and drilldown. */
export function useFinancialStates(filter: FinancialStateFilter = {}, enabled = true) {
  const { organizationId } = useAuth();
  const { branchId, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: [
      "financial-states",
      organizationId,
      filterKey,
      filter.from ?? null,
      filter.to ?? null,
      filter.module ?? null,
      filter.status ?? null,
    ],
    enabled: enabled && Boolean(organizationId),
    queryFn: async (): Promise<FinancialStateRow[]> => {
      const { data, error } = await rpc("neo_financial_state_register", {
        _branch: branchId ?? null,
        _from: filter.from ?? null,
        _to: filter.to ?? null,
        _module: filter.module ?? null,
        _status: filter.status ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as FinancialStateRow[];
    },
  });
}

/** The financial state of one source record, for a detail screen. */
export function useFinancialState(module: string, sourceId: string | null | undefined) {
  const states = useFinancialStates({ module }, Boolean(sourceId));
  const row = (states.data ?? []).find((r) => r.source_id === sourceId) ?? null;
  return { ...states, state: row };
}

/** Totals by status, so a tile and its drilldown can never disagree. */
export function summariseFinancialStates(rows: FinancialStateRow[]) {
  const counts = {} as Record<FinancialStatus, { count: number; amount: number }>;
  for (const status of FINANCIAL_STATUSES) counts[status] = { count: 0, amount: 0 };
  for (const row of rows) {
    const bucket = counts[row.financial_status] ?? counts.pending;
    bucket.count += 1;
    bucket.amount += Number(row.amount) || 0;
  }
  return counts;
}
