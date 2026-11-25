import { describe, expect, it } from "vitest";

import {
  reconcilePosFinance,
  type PosFinanceEvidence,
} from "../pos-finance-reconciliation";

function evidence(
  overrides: Partial<PosFinanceEvidence> = {},
): PosFinanceEvidence {
  return {
    orderId: "test-order",
    orderStatus: "charged-to-room",
    currency: "KES",

    billTotal: 5000,
    directCollectionAmount: 0,
    transferredCollectionAmount: 0,
    roomTransferPaidTotal: 0,

    folioState: "verified",
    folioAmount: 5000,

    folioJournalState: "verified",
    folioJournalDebit: 5000,
    folioJournalCredit: 5000,

    directPosJournalCount: 0,

    transferAllocationState: "verified",
    transferAllocationAmount: 0,

    ...overrides,
  };
}

describe("NEO POS-to-Finance reconciliation", () => {
  it("matches an ordinary transferred room charge", () => {
    const result = reconcilePosFinance(evidence());

    expect(result.status).toBe("matched");
    expect(result.revenueRecognitionVerified).toBe(true);
  });

  it("does not double count a partial room transfer", () => {
    const result = reconcilePosFinance(
      evidence({
        directCollectionAmount: 2000,
        transferredCollectionAmount: 2000,
        roomTransferPaidTotal: 2000,
        transferAllocationAmount: 2000,
      }),
    );

    expect(result.status).toBe("matched");
    expect(result.billValue).toBe(5000);
    expect(result.outstandingTransferAllocation).toBe(3000);
  });

  it("flags a missing folio charge", () => {
    expect(
      reconcilePosFinance(
        evidence({ folioState: "missing" }),
      ).status,
    ).toBe("missing-folio");
  });

  it("does not classify inaccessible folios as missing", () => {
    expect(
      reconcilePosFinance(
        evidence({ folioState: "unavailable" }),
      ).status,
    ).toBe("unverified");
  });

  it("flags missing posted journals", () => {
    expect(
      reconcilePosFinance(
        evidence({ folioJournalState: "missing" }),
      ).status,
    ).toBe("missing-journal");
  });

  it("detects folio amount mismatches", () => {
    expect(
      reconcilePosFinance(
        evidence({ folioAmount: 4900 }),
      ).status,
    ).toBe("amount-mismatch");
  });

  it("detects journal amount mismatches", () => {
    expect(
      reconcilePosFinance(
        evidence({ folioJournalDebit: 4900 }),
      ).status,
    ).toBe("amount-mismatch");
  });

  it("detects duplicate direct POS revenue journals", () => {
    expect(
      reconcilePosFinance(
        evidence({ directPosJournalCount: 1 }),
      ).status,
    ).toBe("duplicate-posting-risk");
  });

  it("requires allocation evidence for partially paid transfers", () => {
    const result = reconcilePosFinance(
      evidence({
        roomTransferPaidTotal: 2000,
        transferAllocationState: "missing",
      }),
    );

    expect(result.status).toBe("partial-payment-review");
  });

  it("detects partial-payment allocation mismatches", () => {
    const result = reconcilePosFinance(
      evidence({
        roomTransferPaidTotal: 2000,
        transferAllocationAmount: 1500,
      }),
    );

    expect(result.status).toBe("partial-payment-review");
  });

  it("does not treat missing refund evidence as verified", () => {
    const result = reconcilePosFinance(
      evidence({
        refundStatus: "processed",
        refundJournalState: "missing",
      }),
    );

    expect(result.status).toBe("unverified");
    expect(result.refundPostingVerified).toBe(false);
  });

  it("accepts a verified processed refund", () => {
    const result = reconcilePosFinance(
      evidence({
        refundStatus: "processed",
        refundJournalState: "verified",
      }),
    );

    expect(result.status).toBe("matched");
    expect(result.refundPostingVerified).toBe(true);
  });

  it("rejects invalid negative financial values", () => {
    expect(() =>
      reconcilePosFinance(
        evidence({ billTotal: -500 }),
      ),
    ).toThrow("Invalid non-negative financial amount");
  });

  it("does not recognize non-finalized orders", () => {
    const result = reconcilePosFinance(
      evidence({ orderStatus: "draft" }),
    );

    expect(result.status).toBe("unverified");
    expect(result.revenueRecognitionVerified).toBe(false);
  });

  it("handles financial values in cents", () => {
    const result = reconcilePosFinance(
      evidence({
        billTotal: 5000.25,
        folioAmount: 5000.25,
        folioJournalDebit: 5000.25,
        folioJournalCredit: 5000.25,
      }),
    );

    expect(result.status).toBe("matched");
    expect(result.billValue).toBe(5000.25);
  });
});
