/**
 * Phase 11 — Finance, Accounting & Compliance vocabulary and arithmetic.
 *
 * Money never uses floating-point accumulation in the database (numeric(18,2));
 * these helpers only format and derive display values.
 */

import type { Tone } from "@/lib/events";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export const ACCOUNT_CATEGORIES = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "cost_of_sales",
  "operating_expense",
  "other_income",
  "other_expense",
] as const;

export const PERIOD_STATUSES = ["future", "open", "soft_closed", "closed", "locked"] as const;

export const JOURNAL_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "posted",
  "reversed",
  "rejected",
] as const;

export const JOURNAL_TYPES = ["general", "automatic", "adjustment", "reversal", "opening", "closing"] as const;

export const INVOICE_TYPES = [
  "proforma",
  "tax_invoice",
  "simplified_invoice",
  "corporate_invoice",
  "event_invoice",
  "folio_invoice",
] as const;

export const INVOICE_STATUSES = [
  "draft",
  "issued",
  "partially_paid",
  "paid",
  "overdue",
  "cancelled",
  "written_off",
] as const;

/**
 * Supplier payment methods, written in the same canonical spelling as every
 * other payment surface. Older records keep whatever was saved at the time and
 * are matched back to these when read (see normalisePaymentMethod).
 */
export const PAYMENT_METHODS = [
  "cash",
  "mpesa",
  "card",
  "bank-transfer",
  "corporate-credit",
  "voucher",
  "loyalty",
  "complimentary",
] as const;

/**
 * The ways the business actually pays a supplier.
 *
 * Guest-facing tenders (loyalty points, vouchers, complimentary, corporate
 * credit, room charge) are how a guest settles with us — they can never settle
 * our own bill with a supplier, so they are not offered on payables screens.
 */
export const SUPPLIER_PAYMENT_METHODS = [
  "bank-transfer",
  "cheque",
  "cash",
  "mpesa",
  "card",
] as const;

export const PAYMENT_STATUSES = [
  "initiated",
  "pending",
  "successful",
  "confirmed",
  "failed",
  "cancelled",
  "reversed",
  "refunded",
  "partially_refunded",
  "unallocated",
] as const;

export const RECONCILIATION_WORKSPACES = [
  "cash",
  "bank",
  "mpesa",
  "card",
  "ota",
  "corporate_receipts",
  "supplier_payments",
] as const;

export const VCC_STATUSES = [
  "not_available",
  "not_active",
  "ready_to_charge",
  "collected",
  "partially_collected",
  "failed",
  "expired",
  "disputed",
] as const;

export const ETIMS_STATUSES = [
  "not_required",
  "pending",
  "queued",
  "submitted",
  "accepted",
  "rejected",
  "failed",
  "retry_required",
  "cancelled_by_credit_note",
] as const;

export const MATCH_STATUSES = ["matched", "partially_matched", "variance", "on_hold", "approved_exception"] as const;

export const SOURCE_MODULES = [
  "pms",
  "pos",
  "room_service",
  "events",
  "delivery",
  "inventory",
  "procurement",
  "finance",
  "manual",
] as const;

/** Mapping keys that operational modules post through. */
export const MAPPING_EVENTS: { module: string; key: string; label: string; hint: string }[] = [
  { module: "pms", key: "room_charge", label: "Room charge", hint: "Debit folio / AR, credit room revenue and tax." },
  { module: "pms", key: "guest_deposit", label: "Guest deposit", hint: "Debit cash or bank, credit guest deposits." },
  { module: "pos", key: "cash_sale", label: "Restaurant / bar cash sale", hint: "Debit cash, credit revenue and tax." },
  { module: "pos", key: "mpesa_sale", label: "M-Pesa sale", hint: "Debit M-Pesa clearing, credit revenue and tax." },
  { module: "pos", key: "card_sale", label: "Card sale", hint: "Debit card clearing, credit revenue and tax." },
  { module: "pos", key: "room_charge", label: "Charge to room", hint: "Debit guest folio, credit revenue and tax." },
  { module: "events", key: "deposit", label: "Event deposit", hint: "Credit the event deposit liability, not revenue." },
  { module: "events", key: "revenue_recognition", label: "Event revenue recognition", hint: "Release deposit to event revenue." },
  { module: "procurement", key: "grn_credit", label: "Stock received on credit", hint: "Debit inventory, credit payables or GRNI." },
  { module: "inventory", key: "consumption", label: "Inventory consumption", hint: "Debit cost of sales, credit inventory." },
  { module: "finance", key: "refund", label: "Approved refund", hint: "Debit refund account, credit cash or clearing." },
  { module: "finance", key: "expense", label: "Expense payment", hint: "Debit expense, credit cash or bank." },
];

export function titleCase(value: string): string {
  if (!value) return "";
  return value
    .split(/[-_\s]+/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

export function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * In-app figure. The operating currency is a tenant setting, so dashboards,
 * cards and tables render the number alone. Documents use `moneyWithCode`.
 */
export function money(value: unknown, _currency = "KES"): string {
  return num(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Document shape — invoices, folios, statements and exports carry the code. */
export function moneyWithCode(value: unknown, currency = "KES"): string {
  return `${currency} ${money(value)}`;
}

export function shortDate(value: unknown): string {
  if (!value) return "—";
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

export function dateTime(value: unknown): string {
  if (!value) return "—";
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export function statusTone(status: string): Tone {
  switch (status) {
    case "posted":
    case "approved":
    case "paid":
    case "accepted":
    case "reconciled":
    case "collected":
    case "matched":
    case "received":
      return "success";
    case "draft":
    case "future":
    case "pending":
    case "queued":
    case "submitted":
    case "scheduled":
    case "pending_approval":
    case "under_review":
    case "partially_paid":
    case "partially_reconciled":
    case "partially_collected":
    case "partially_matched":
    case "soft_closed":
    case "in_review":
    case "ready_to_charge":
      return "warning";
    case "failed":
    case "rejected":
    case "overdue":
    case "exception":
    case "disputed":
    case "retry_required":
    case "variance":
    case "expired":
    case "written_off":
      return "destructive";
    case "reversed":
    case "cancelled":
    case "closed":
    case "locked":
    case "not_required":
    case "not_available":
      return "default";
    default:
      return "info";
  }
}

/** Ageing bucket for an outstanding document. */
export function ageingBucket(dueDate: unknown): "current" | "d30" | "d60" | "d90" | "over90" {
  if (!dueDate) return "current";
  const due = new Date(String(dueDate)).getTime();
  if (Number.isNaN(due)) return "current";
  const days = Math.floor((Date.now() - due) / 86_400_000);
  if (days <= 0) return "current";
  if (days <= 30) return "d30";
  if (days <= 60) return "d60";
  if (days <= 90) return "d90";
  return "over90";
}

export const AGEING_LABELS: Record<string, string> = {
  current: "Current",
  d30: "1–30 days",
  d60: "31–60 days",
  d90: "61–90 days",
  over90: "Over 90 days",
};

export function ageInvoices(rows: Row[]): Record<string, number> {
  const buckets: Record<string, number> = { current: 0, d30: 0, d60: 0, d90: 0, over90: 0 };
  for (const r of rows) buckets[ageingBucket(r["due_date"])] = (buckets[ageingBucket(r["due_date"])] ?? 0) + num(r["balance"]);
  return buckets;
}

/** Three-way match evaluation between PO, GRN and supplier invoice values. */
export function evaluateMatch(input: {
  orderedValue: number;
  receivedValue: number;
  invoicedValue: number;
  tolerance?: number;
}): { status: (typeof MATCH_STATUSES)[number]; variance: number; variancePct: number } {
  const tol = input.tolerance ?? 0.02;
  const base = input.receivedValue || input.orderedValue;
  const variance = num(input.invoicedValue) - num(base);
  const variancePct = base === 0 ? (variance === 0 ? 0 : 1) : variance / base;
  if (Math.abs(variancePct) <= 0.0001) return { status: "matched", variance, variancePct };
  if (Math.abs(variancePct) <= tol) return { status: "partially_matched", variance, variancePct };
  return { status: "variance", variance, variancePct };
}

/** Balanced-journal check used by the journal form before submission. */
export function journalTotals(lines: { debit?: unknown; credit?: unknown }[]) {
  const debit = lines.reduce((s, l) => s + num(l.debit), 0);
  const credit = lines.reduce((s, l) => s + num(l.credit), 0);
  return { debit, credit, balanced: Math.abs(debit - credit) < 0.005 && debit > 0 };
}

/** Advisory-only AI heuristics. Never posts, approves or submits anything. */
export function financeInsights(input: {
  metrics: Record<string, unknown>;
  invoices: Row[];
  otaReceivables: Row[];
}): { tone: Tone; title: string; detail: string }[] {
  const out: { tone: Tone; title: string; detail: string }[] = [];
  const overdue = input.invoices.filter((i) => ageingBucket(i["due_date"]) !== "current");
  const overdueTotal = overdue.reduce((s, i) => s + num(i["balance"]), 0);
  if (overdue.length > 0) {
    out.push({
      tone: "warning",
      title: "Overdue receivables detected",
      detail: `${overdue.length} invoice(s) totalling ${money(overdueTotal)} are past their due date. Prioritise the oldest balances for collection follow-up.`,
    });
  }
  const uncollected = input.otaReceivables
    .filter((o) => o["collection_status"] !== "collected")
    .reduce((s, o) => s + (num(o["net_expected"]) - num(o["collected_amount"])), 0);
  if (uncollected > 0) {
    out.push({
      tone: "warning",
      title: "OTA collections outstanding",
      detail: `${money(uncollected)} of OTA settlements and virtual card charges remain uncollected. Review cards nearing expiry first.`,
    });
  }
  if (num(input.metrics["etims_failed"]) > 0) {
    out.push({
      tone: "destructive",
      title: "Tax submissions need attention",
      detail: `${num(input.metrics["etims_failed"])} eTIMS submission(s) are failed or awaiting retry. Resolve them before the filing deadline.`,
    });
  }
  if (num(input.metrics["unreconciled"]) > 0) {
    out.push({
      tone: "info",
      title: "Unreconciled bank activity",
      detail: `${num(input.metrics["unreconciled"])} statement line(s) have not been matched. Reconcile before closing the period.`,
    });
  }
  if (num(input.metrics["draft_journals"]) > 0) {
    out.push({
      tone: "info",
      title: "Journals awaiting posting",
      detail: `${num(input.metrics["draft_journals"])} journal(s) are still draft or awaiting approval and are not yet in the ledger.`,
    });
  }
  return out;
}
