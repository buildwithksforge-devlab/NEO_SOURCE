/**
 * The single authoritative financial lifecycle.
 *
 * NEØ has two records of a transaction's money: `canonical_transaction_states`,
 * written by the module as work happens, and `financial_states`, written by the
 * posting engine as accounting happens. Read separately they can disagree — one
 * screen says "Paid", another says "Pending". They are matched here, once, in
 * `neo_financial_lifecycle_register`:
 *
 *  - the accounting record decides the FINANCIAL status (it owns the journal);
 *  - the canonical record decides the OPERATIONAL status (it owns the workflow);
 *  - a row where the two disagree is flagged, never silently reconciled.
 *
 * Operational words (new, preparing, ready, served) and financial words
 * (pending, eligible, posted, reversed) stay in separate columns and are never
 * translated into each other.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import type { FinancialStatus } from "@/lib/financial-state";

/* eslint-disable @typescript-eslint/no-explicit-any */
const rpc = (fn: string, args: Record<string, unknown>) =>
  (supabase as any).rpc(fn, args) as Promise<{ data: any; error: { message: string } | null }>;

export type LifecycleRow = {
  family: string;
  sourceId: string;
  branchId: string | null;
  reference: string | null;
  operationalState: string | null;
  financialStatus: FinancialStatus;
  /** Which register supplied the financial status. */
  statusOrigin: "accounting" | "canonical";
  /** True when the two registers hold different financial statuses. */
  disagreement: boolean;
  canonicalFinancialState: string | null;
  amount: number;
  currency: string;
  accountingDate: string | null;
  journalId: string | null;
  journalNumber: string | null;
  receiptId: string | null;
  attempts: number;
  lastError: string | null;
  blocker: string | null;
  nextAction: string | null;
  owner: string | null;
  postedAt: string | null;
  reversedAt: string | null;
  occurredAt: string | null;
  updatedAt: string | null;
};

function mapRow(r: Record<string, unknown>): LifecycleRow {
  return {
    family: String(r["family"] ?? ""),
    sourceId: String(r["source_id"] ?? ""),
    branchId: (r["branch_id"] as string) ?? null,
    reference: (r["source_reference"] as string) ?? null,
    operationalState: (r["operational_state"] as string) ?? null,
    financialStatus: (String(r["financial_status"] ?? "pending") as FinancialStatus),
    statusOrigin: r["status_origin"] === "accounting" ? "accounting" : "canonical",
    disagreement: Boolean(r["disagreement"]),
    canonicalFinancialState: (r["canonical_financial_state"] as string) ?? null,
    amount: Number(r["amount"] ?? 0),
    currency: String(r["currency"] ?? "KES"),
    accountingDate: (r["accounting_date"] as string) ?? null,
    journalId: (r["journal_id"] as string) ?? null,
    journalNumber: (r["journal_number"] as string) ?? null,
    receiptId: (r["receipt_id"] as string) ?? null,
    attempts: Number(r["attempts"] ?? 0),
    lastError: (r["last_error"] as string) ?? null,
    blocker: (r["blocking_reason"] as string) ?? null,
    nextAction: (r["next_action"] as string) ?? null,
    owner: (r["current_owner"] as string) ?? null,
    postedAt: (r["posted_at"] as string) ?? null,
    reversedAt: (r["reversed_at"] as string) ?? null,
    occurredAt: (r["occurred_at"] as string) ?? null,
    updatedAt: (r["updated_at"] as string) ?? null,
  };
}

export type LifecycleScope = {
  branchId?: string | null;
  from?: string | null;
  to?: string | null;
  family?: string | null;
  status?: string | null;
};

/** The register behind the finance dashboard, the day view and every drilldown. */
export function useFinancialLifecycle(scope: LifecycleScope = {}, enabled = true) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: [
      "financial-lifecycle",
      organizationId,
      scope.branchId ?? "all",
      scope.from ?? null,
      scope.to ?? null,
      scope.family ?? "all",
      scope.status ?? "all",
    ],
    enabled: enabled && Boolean(organizationId),
    queryFn: async (): Promise<LifecycleRow[]> => {
      const { data, error } = await rpc("neo_financial_lifecycle_register", {
        _branch: scope.branchId ?? null,
        _from: scope.from ?? null,
        _to: scope.to ?? null,
        _family: scope.family ?? null,
        _status: scope.status ?? null,
      });
      if (error) throw new Error(error.message);
      return (data ?? []).map(mapRow);
    },
  });
}

/** The lifecycle of one record, for a detail screen. */
export function useRecordLifecycle(family: string, sourceId: string | null | undefined) {
  const register = useFinancialLifecycle({ family }, Boolean(sourceId));
  const row = register.data?.find((r) => r.sourceId === sourceId) ?? null;
  return { ...register, row };
}

export const FAMILY_LABELS: Record<string, string> = {
  folio: "Folios",
  folio_charge: "Folio charges",
  folio_payment: "Receipts",
  room: "Rooms",
  reservation: "Reservations",
  pos: "Point of sale",
  procurement: "Purchase orders",
  inventory: "Goods received",
  supplier_invoice: "Supplier invoices",
  supplier_payment: "Supplier payments",
  payment: "Receipts",
  deposit: "Deposits",
  event: "Events",
  delivery: "Delivery",
  laundry: "Laundry",
  requisition: "Requisitions",
  maintenance: "Maintenance",
  refund: "Refunds",
  adjustment: "Adjustments",
};

/** Totals a tile and its drilldown share, so they cannot disagree. */
export function summariseLifecycle(rows: LifecycleRow[]) {
  const sum = (pred: (r: LifecycleRow) => boolean) =>
    rows.filter(pred).reduce((a, r) => a + r.amount, 0);
  const stuck = (r: LifecycleRow) =>
    r.financialStatus === "blocked" || r.financialStatus === "failed";
  return {
    count: rows.length,
    recorded: sum(() => true),
    posted: sum((r) => r.financialStatus === "posted"),
    awaiting: sum((r) => r.financialStatus === "eligible"),
    stuck: sum(stuck),
    stuckCount: rows.filter(stuck).length,
    reversed: sum((r) => r.financialStatus === "reversed"),
    disagreements: rows.filter((r) => r.disagreement).length,
  };
}
