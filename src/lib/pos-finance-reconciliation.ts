export type EvidenceState =
  | "verified"
  | "missing"
  | "unavailable";

export type ReconciliationStatus =
  | "matched"
  | "missing-folio"
  | "missing-journal"
  | "amount-mismatch"
  | "duplicate-posting-risk"
  | "partial-payment-review"
  | "unverified";

export type PosFinanceEvidence = {
  orderId: string;
  orderStatus: string;
  currency: string;

  billTotal: number;

  directCollectionAmount: number;
  transferredCollectionAmount: number;

  roomTransferPaidTotal: number;

  folioState: EvidenceState;
  folioAmount: number | null;

  folioJournalState: EvidenceState;
  folioJournalDebit: number | null;
  folioJournalCredit: number | null;

  directPosJournalCount: number | null;

  transferAllocationState: EvidenceState;
  transferAllocationAmount: number | null;

  refundStatus?: string | null;
  refundJournalState?: EvidenceState;
};

export type PosFinanceReconciliationResult = {
  orderId: string;
  status: ReconciliationStatus;
  reasons: string[];

  billValue: number;
  directCollections: number;
  transferredCollections: number;
  outstandingTransferAllocation: number;

  revenueRecognitionVerified: boolean;
  refundPostingVerified: boolean | null;
};

const FINALIZED = new Set([
  "paid",
  "closed",
  "charged-to-room",
  "credit",
]);

function cents(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Invalid non-negative financial amount");
  }

  return Math.round((value + Number.EPSILON) * 100);
}

function safeAmount(value: number | null): number | null {
  return value === null ? null : cents(value);
}

export function reconcilePosFinance(
  input: PosFinanceEvidence,
): PosFinanceReconciliationResult {
  const reasons: string[] = [];

  const bill = cents(input.billTotal);
  const direct = cents(input.directCollectionAmount);
  const transferred = cents(input.transferredCollectionAmount);
  const previouslyPaid = cents(input.roomTransferPaidTotal);

  const expectedTransfer = Math.max(0, bill - previouslyPaid);

  const result = (
    status: ReconciliationStatus,
    revenueRecognitionVerified = false,
  ): PosFinanceReconciliationResult => ({
    orderId: input.orderId,
    status,
    reasons,
    billValue: bill / 100,
    directCollections: direct / 100,
    transferredCollections: transferred / 100,
    outstandingTransferAllocation: expectedTransfer / 100,
    revenueRecognitionVerified,
    refundPostingVerified:
      input.refundStatus === "processed"
        ? input.refundJournalState === "verified"
        : null,
  });

  if (!FINALIZED.has(input.orderStatus)) {
    reasons.push("Order is not finalized");
    return result("unverified");
  }

  if (input.folioState === "unavailable") {
    reasons.push("Folio evidence cannot be accessed");
    return result("unverified");
  }

  if (input.folioJournalState === "unavailable") {
    reasons.push("Finance journal evidence cannot be accessed");
    return result("unverified");
  }

  if (input.directPosJournalCount === null) {
    reasons.push("Direct POS journal evidence is unavailable");
    return result("unverified");
  }

  if (input.directPosJournalCount > 0) {
    reasons.push(
      "Direct POS revenue journal conflicts with room-charge reconciliation",
    );

    return result("duplicate-posting-risk");
  }

  if (input.folioState === "missing") {
    reasons.push("Required posted folio charge is missing");
    return result("missing-folio");
  }

  const folioAmount = safeAmount(input.folioAmount);

  if (folioAmount === null) {
    reasons.push("Posted folio amount has not been verified");
    return result("unverified");
  }

  // NE? room-transfer integrity requires the posted folio
  // charge to represent the original bill amount.
  // Previously collected money is linked separately.
  if (folioAmount !== bill) {
    reasons.push("Folio charge differs from original POS bill");
    return result("amount-mismatch");
  }

  if (input.folioJournalState === "missing") {
    reasons.push("Matching posted folio revenue journal is missing");
    return result("missing-journal");
  }

  const debit = safeAmount(input.folioJournalDebit);
  const credit = safeAmount(input.folioJournalCredit);

  if (debit === null || credit === null) {
    reasons.push("Journal totals could not be verified");
    return result("unverified");
  }

  if (debit !== bill || credit !== bill) {
    reasons.push("Journal totals do not match original bill value");
    return result("amount-mismatch");
  }

  // The folio charge and journal are evidence of the
  // original bill, not additional restaurant revenue.
  if (previouslyPaid > 0) {
    if (input.transferAllocationState === "unavailable") {
      reasons.push("Transfer payment allocation is inaccessible");
      return result("unverified", true);
    }

    if (input.transferAllocationState === "missing") {
      reasons.push("Previously collected money has no verified allocation");
      return result("partial-payment-review", true);
    }

    const allocated = safeAmount(input.transferAllocationAmount);

    if (allocated === null) {
      reasons.push("Transfer allocation amount is unverified");
      return result("unverified", true);
    }

    if (allocated !== previouslyPaid) {
      reasons.push(
        "Transfer allocation differs from previously collected amount",
      );

      return result("partial-payment-review", true);
    }
  }

  if (input.refundStatus === "processed") {
    if (input.refundJournalState !== "verified") {
      reasons.push("Processed refund requires Finance posting verification");
      return result("unverified", true);
    }
  }

  reasons.push("Room-charge financial evidence matches");
  return result("matched", true);
}
