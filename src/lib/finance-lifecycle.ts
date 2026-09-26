/**
 * The canonical operational → finance posting lifecycle.
 *
 * This is the front-end mirror of `public.neo_finance_post_txn` and
 * `public.neo_finance_eligible_sources`. It exists so the UI can explain, and
 * the test-suite can prove, exactly which operational states become accounting
 * entries — and which never do. `finance-lifecycle.test.ts` asserts every entry
 * here against the deployed SQL fixture, so drift fails the build instead of
 * silently mis-stating revenue.
 */

export type PostingType =
  | "revenue"
  | "room_charge"
  | "collection"
  | "deposit"
  | "invoice"
  | "earned"
  | "cancellation"
  | "payable"
  | "payable_payment"
  | "folio_charge";

export type LifecycleRule = {
  /** `_source_type` accepted by neo_finance_post_txn. */
  source: string;
  label: string;
  module: string;
  /** Default posting_type used to build the idempotency key. */
  posting: PostingType;
  /** Operational states that are eligible for posting. */
  eligible: string[];
  /** States that are explicitly NOT accounting revenue / payables. */
  ineligible: string[];
  /** Why the ineligible states are excluded, in plain language. */
  exclusion: string;
};

export const LIFECYCLE_RULES: LifecycleRule[] = [
  {
    source: "pos_order",
    label: "Point of sale order",
    module: "pos",
    posting: "revenue",
    eligible: ["closed", "paid", "settled", "completed"],
    ineligible: ["draft", "open", "sent", "ready", "served", "void", "cancelled"],
    exclusion:
      "Draft, open, sent, ready and served orders are operational value only. They are never counted as revenue. Orders routed to a folio recognise revenue on the folio charge instead.",
  },
  {
    source: "folio_charge",
    label: "Folio charge",
    module: "folio",
    posting: "revenue",
    eligible: ["posted"],
    ineligible: ["draft", "pending", "void", "reversed"],
    exclusion:
      "Only posted folio charges are recognised. Payment lines are collections, not revenue.",
  },
  {
    source: "folio_payment",
    label: "Receipt / collection",
    module: "folio",
    posting: "collection",
    eligible: ["confirmed", "completed", "paid", "succeeded", "captured"],
    ineligible: ["pending", "failed", "cancelled", "refunded"],
    exclusion:
      "Only confirmed receipts reduce the outstanding balance. Pending and failed attempts are not collections.",
  },
  {
    source: "event_deposit",
    label: "Event deposit",
    module: "event",
    posting: "deposit",
    eligible: ["confirmed", "provisional", "completed", "closed"],
    ineligible: ["cancelled"],
    exclusion:
      "A deposit is a liability, not revenue, and only posts when money has actually been received. Forecast is never revenue.",
  },
  {
    source: "event_invoice",
    label: "Invoice (receivable)",
    module: "event",
    posting: "invoice",
    eligible: ["issued", "sent", "partially_paid", "paid", "overdue"],
    ineligible: ["draft", "cancelled", "void"],
    exclusion: "Draft and cancelled invoices are not receivables.",
  },
  {
    source: "event_earned",
    label: "Event revenue earned",
    module: "event",
    posting: "earned",
    eligible: ["completed", "closed"],
    ineligible: ["enquiry", "provisional", "confirmed", "cancelled"],
    exclusion:
      "Confirmed and provisional bookings are forecast, not revenue. Revenue is earned when the event is delivered.",
  },
  {
    source: "event_cancellation",
    label: "Event cancellation",
    module: "event",
    posting: "cancellation",
    eligible: ["cancelled"],
    ineligible: ["confirmed", "completed", "closed"],
    exclusion:
      "Cancellation reverses any earned posting, recognises the cancellation fee only, and refunds the deposit remainder.",
  },
  {
    source: "delivery_order",
    label: "Delivery order",
    module: "delivery",
    posting: "revenue",
    eligible: ["delivered", "completed"],
    ineligible: ["placed", "accepted", "preparing", "dispatched", "cancelled", "failed"],
    exclusion: "Only completed deliveries are recognised.",
  },
  {
    source: "laundry_order",
    label: "Guest laundry order",
    module: "laundry",
    posting: "revenue",
    eligible: ["delivered", "completed", "closed"],
    ineligible: ["received", "processing", "ready", "cancelled"],
    exclusion:
      "Only completed laundry orders are recognised. Orders charged to a folio recognise revenue on the folio charge.",
  },
  {
    source: "supplier_invoice",
    label: "Supplier invoice (payable)",
    module: "supplier",
    posting: "payable",
    eligible: ["approved", "matched", "partially_paid", "paid"],
    ineligible: ["draft", "pending_approval", "disputed", "cancelled"],
    exclusion:
      "Only approved supplier invoices become payables. Purchase requests and purchase orders do not.",
  },
  {
    source: "supplier_payment",
    label: "Supplier payment",
    module: "supplier",
    posting: "payable_payment",
    eligible: ["paid", "completed", "settled"],
    ineligible: ["draft", "pending", "failed", "cancelled"],
    exclusion: "Only settled supplier payments reduce payables.",
  },
];

export const LIFECYCLE_BY_SOURCE: Record<string, LifecycleRule> = Object.fromEntries(
  LIFECYCLE_RULES.map((r) => [r.source, r]),
);

/** Mirrors the key built in neo_gl_post / neo_finance_post_txn. */
export const idempotencyKey = (source: string, id: string, posting: string) =>
  `${source}:${id}:${posting}`;

/** Mirrors the key neo_finance_reverse_posting writes for the reversal journal. */
export const reversalKey = (source: string, id: string, posting: string) =>
  idempotencyKey(source, id, `${posting}:reversal`);

export type PostingLine = { code: string; debit?: number; credit?: number };

/** A journal only posts when it balances to the cent — the SQL raises otherwise. */
export function journalBalances(lines: PostingLine[]): boolean {
  const round = (n: number) => Math.round(n * 100) / 100;
  const debit = round(lines.reduce((a, l) => a + (l.debit ?? 0), 0));
  const credit = round(lines.reduce((a, l) => a + (l.credit ?? 0), 0));
  return debit === credit && lines.some((l) => (l.debit ?? 0) !== 0 || (l.credit ?? 0) !== 0);
}

/** Decide, without calling the database, whether a source state may post. */
export function eligibility(
  source: string,
  status: string,
  amount = 1,
): { eligible: boolean; reason: string } {
  const rule = LIFECYCLE_BY_SOURCE[source];
  if (!rule) return { eligible: false, reason: "unknown_source_type" };
  if (!rule.eligible.includes(status))
    return { eligible: false, reason: "ineligible_lifecycle" };
  if (amount <= 0) return { eligible: false, reason: "zero_amount" };
  return { eligible: true, reason: "eligible" };
}
