/**
 * Finance as an immutable subledger.
 *
 * Finance is not a dashboard that decides what looks posted. It is a subledger
 * with one road in:
 *
 *   Operational source event → Eligibility result → Posting receipt → Journal → Reconciliation
 *
 * Two rules follow, and this module exists to make them impossible to bypass:
 *
 *  1. A source event may only be consumed once its eligibility rules pass, and
 *     exactly one posting receipt and one balanced journal exist per financial
 *     source event. Retries reuse the same posting identity.
 *  2. Nothing is "posted" because a page says so. Posted means a persisted,
 *     balanced journal is linked to the receipt — anything else is pending,
 *     blocked or failed, and reports as such.
 */

export type SourceFamily =
  | "pos"
  | "folio"
  | "payment"
  | "deposit"
  | "grn"
  | "supplier_invoice"
  | "supplier_payment"
  | "night_audit";

export type SourceEvent = {
  family: SourceFamily;
  sourceId: string;
  organizationId: string | null;
  propertyId: string | null;
  reference: string | null;
  /** Gross amount in the source's own currency. */
  amount: number | null;
  currency: string | null;
  businessDate: string | null;
  /** Operational state the source module holds. */
  operationalState: string | null;
  /** Set when the source is already known to be void/cancelled. */
  voided?: boolean;
};

/** The single posting identity — retries must reproduce it exactly. */
export const postingIdentity = (e: Pick<SourceEvent, "family" | "sourceId">) =>
  `${e.family}:${e.sourceId}`;

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export type EligibilityFailure = { code: string; detail: string };

export type EligibilityResult =
  | { eligible: true; identity: string; amount: number; currency: string }
  | { eligible: false; identity: string; failures: EligibilityFailure[] };

/** States that mean the operational record has reached a postable end state. */
const POSTABLE_STATE: Record<SourceFamily, readonly string[]> = {
  pos: ["closed", "settled", "billed"],
  folio: ["closed", "settled"],
  payment: ["captured", "confirmed", "settled"],
  deposit: ["held", "paid", "captured"],
  grn: ["accepted", "posted"],
  supplier_invoice: ["accepted", "matched"],
  supplier_payment: ["released", "paid"],
  night_audit: ["completed"],
};

export function evaluateEligibility(event: SourceEvent): EligibilityResult {
  const identity = postingIdentity(event);
  const failures: EligibilityFailure[] = [];

  if (!event.organizationId) failures.push({ code: "no_organisation", detail: "Source has no workspace." });
  if (!event.propertyId) failures.push({ code: "no_property", detail: "Source has no property." });
  if (!event.businessDate) failures.push({ code: "no_business_date", detail: "Source has no business date." });
  if (event.voided) failures.push({ code: "voided", detail: "Voided sources are never posted." });

  const amount = event.amount ?? 0;
  if (!Number.isFinite(amount) || Math.round(amount * 100) === 0)
    failures.push({ code: "zero_amount", detail: "Nothing to post — the source carries no value." });
  if (amount < 0) failures.push({ code: "negative_amount", detail: "Reversals post through a reversal, not a negative." });

  if (!event.currency) failures.push({ code: "no_currency", detail: "Source has no currency." });

  const state = (event.operationalState ?? "").toLowerCase();
  if (!POSTABLE_STATE[event.family].includes(state))
    failures.push({
      code: "not_final",
      detail: `${event.family} is "${event.operationalState ?? "unknown"}" — not a postable state.`,
    });

  if (failures.length) return { eligible: false, identity, failures };
  return { eligible: true, identity, amount, currency: event.currency! };
}

// ---------------------------------------------------------------------------
// Receipt + journal
// ---------------------------------------------------------------------------

export type JournalLine = { accountCode: string; debit?: number; credit?: number; description?: string };

export type JournalRecord = {
  id: string;
  journalNumber: string | null;
  lines: JournalLine[];
  /** Persisted means the database returned it, not that we intend to write it. */
  persisted: boolean;
};

export type PostingReceipt = {
  identity: string;
  receiptId: string | null;
  journal: JournalRecord | null;
  attempts: number;
  lastError?: string | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function journalTotals(journal: Pick<JournalRecord, "lines">) {
  const debit = round2(journal.lines.reduce((s, l) => s + (l.debit ?? 0), 0));
  const credit = round2(journal.lines.reduce((s, l) => s + (l.credit ?? 0), 0));
  return { debit, credit, balanced: debit === credit && debit > 0 };
}

export function journalBalanced(journal: Pick<JournalRecord, "lines">) {
  return journalTotals(journal).balanced;
}

export type PostingStatus = "pending" | "posted" | "blocked" | "failed" | "unbalanced";

export type PostingVerdict = {
  identity: string;
  status: PostingStatus;
  detail: string;
  journalId: string | null;
  amount: number | null;
};

/**
 * The only definition of "posted" in the product: eligibility passed, a receipt
 * exists, and a persisted balanced journal is linked to it.
 */
export function postingVerdict(
  event: SourceEvent,
  eligibility: EligibilityResult,
  receipt: PostingReceipt | null,
): PostingVerdict {
  const identity = postingIdentity(event);

  if (!eligibility.eligible) {
    return {
      identity,
      status: "blocked",
      detail: eligibility.failures.map((f) => f.detail).join(" "),
      journalId: null,
      amount: event.amount ?? null,
    };
  }
  if (!receipt || !receipt.receiptId) {
    return {
      identity,
      status: receipt?.lastError ? "failed" : "pending",
      detail: receipt?.lastError ?? "Awaiting posting.",
      journalId: null,
      amount: eligibility.amount,
    };
  }
  const journal = receipt.journal;
  if (!journal || !journal.persisted) {
    return {
      identity,
      status: receipt.lastError ? "failed" : "pending",
      detail: receipt.lastError ?? "Receipt recorded, journal not yet persisted.",
      journalId: null,
      amount: eligibility.amount,
    };
  }
  const totals = journalTotals(journal);
  if (!totals.balanced) {
    return {
      identity,
      status: "unbalanced",
      detail: `Journal ${journal.journalNumber ?? journal.id} does not balance (${totals.debit} debit vs ${totals.credit} credit).`,
      journalId: journal.id,
      amount: eligibility.amount,
    };
  }
  if (round2(totals.debit) !== round2(eligibility.amount)) {
    return {
      identity,
      status: "unbalanced",
      detail: `Journal ${journal.journalNumber ?? journal.id} posts ${totals.debit} against a source of ${eligibility.amount}.`,
      journalId: journal.id,
      amount: eligibility.amount,
    };
  }
  return {
    identity,
    status: "posted",
    detail: `Posted to journal ${journal.journalNumber ?? journal.id}.`,
    journalId: journal.id,
    amount: eligibility.amount,
  };
}

/** Guard against a second receipt or a second journal for one source. */
export function assertSinglePosting(identity: string, receipts: PostingReceipt[]) {
  const mine = receipts.filter((r) => r.identity === identity);
  if (mine.length > 1)
    throw new Error(`Duplicate posting receipts for ${identity} — posting identity must be unique.`);
  const journals = new Set(mine.map((r) => r.journal?.id).filter(Boolean));
  if (journals.size > 1)
    throw new Error(`Multiple journals for ${identity} — a source event posts exactly one journal.`);
}

// ---------------------------------------------------------------------------
// Reconciliation counters
// ---------------------------------------------------------------------------

export type SubledgerCounters = {
  posted: number;
  pending: number;
  blocked: number;
  failed: number;
  unbalanced: number;
  postedValue: number;
  /** True only when every source resolved and nothing is blocked/failed. */
  clean: boolean;
};

/** Counters are derived from verdicts only — never from page state. */
export function subledgerCounters(verdicts: PostingVerdict[]): SubledgerCounters {
  const count = (s: PostingStatus) => verdicts.filter((v) => v.status === s).length;
  const postedValue = round2(
    verdicts.filter((v) => v.status === "posted").reduce((s, v) => s + (v.amount ?? 0), 0),
  );
  const blocked = count("blocked");
  const failed = count("failed");
  const unbalanced = count("unbalanced");
  const pending = count("pending");
  return {
    posted: count("posted"),
    pending,
    blocked,
    failed,
    unbalanced,
    postedValue,
    clean: blocked === 0 && failed === 0 && unbalanced === 0 && pending === 0,
  };
}
