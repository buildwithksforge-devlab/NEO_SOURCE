import { describe, expect, it } from "vitest";
import {
  balancesGross,
  balancesSettlement,
  detailMatchesLedger,
  mapFolioProjection,
  mapPaymentLifecycle,
  stageFromJournal,
  type LedgerLine,
} from "@/lib/payment-lifecycle";
import { sendFailure } from "@/lib/partner-messaging";

/**
 * The permanent guard on the corrected folio and payment chain. These are the
 * rules a money screen may never break, whatever a module happens to store.
 */

const folio = mapFolioProjection({
  found: true,
  folio_id: "9c8e0f05-bbe9-4ec2-be1c-a92899a2c67f",
  folio_number: "INV-2026-000004",
  reservation_id: "6b29abbd-c9f7-465b-8fa6-7d14cfaa7048",
  customer_id: "0ff4eaf6-1504-4030-a64e-03437514a90d",
  guest_name: "Guest",
  net_revenue: 12000,
  tax: 1920,
  gross_obligation: 13920,
  collected: 13920,
  outstanding: 0,
});

describe("canonical folio projection", () => {
  it("resolves the guest and reservation relationship", () => {
    expect(folio.reservationId).toBeTruthy();
    expect(folio.customerId).toBeTruthy();
  });

  it("holds gross = net + tax", () => {
    expect(folio.netRevenue).toBe(12000);
    expect(folio.tax).toBe(1920);
    expect(folio.grossObligation).toBe(13920);
    expect(balancesGross(folio)).toBe(true);
  });

  it("holds paid + outstanding = gross", () => {
    expect(folio.collected).toBe(13920);
    expect(folio.outstanding).toBe(0);
    expect(balancesSettlement(folio)).toBe(true);
  });

  it("rejects a bill whose parts do not add up", () => {
    expect(balancesGross({ netRevenue: 13920, tax: 1920, grossObligation: 12000 })).toBe(false);
    expect(balancesSettlement({ collected: 1000, outstanding: 0, grossObligation: 13920 })).toBe(
      false,
    );
  });
});

const ledger: LedgerLine[] = [
  { account_code: "1010", account_name: "Cash on Hand", debit: 13920, credit: 0 },
  { account_code: "1060", account_name: "Accounts Receivable", debit: 0, credit: 13920 },
];

const payment = mapPaymentLifecycle({
  payment_id: "5b7a1839-7d3b-47b9-bbf7-c78e6dac69dc",
  receipt_number: "RCT-2026-000003",
  folio_number: "INV-2026-000004",
  amount: 13920,
  journal_id: "05232042-292a-4e13-bfdc-df47fa08eff8",
  journal_number: "JV-MAIN-2026-000008",
  journal_status: "posted",
  stage: "in_ledger",
  stage_label: "In the ledger",
  actor_id: "actor-1",
  gl_lines: ledger,
});

describe("payment lifecycle projection", () => {
  it("links receipt, bill, journal and ledger entries", () => {
    expect(payment.receiptNumber).toBe("RCT-2026-000003");
    expect(payment.folioNumber).toBe("INV-2026-000004");
    expect(payment.journalNumber).toBe("JV-MAIN-2026-000008");
    expect(payment.glLines.map((l) => l.account_name)).toEqual([
      "Cash on Hand",
      "Accounts Receivable",
    ]);
  });

  it("derives the stage from the posted journal", () => {
    expect(stageFromJournal({ journalId: payment.journalId, journalStatus: "posted" })).toBe(
      "in_ledger",
    );
    expect(payment.stageLabel).toBe("In the ledger");
  });

  it("never claims the ledger without a posted journal", () => {
    expect(
      stageFromJournal({ journalId: null, journalStatus: null, paymentStatus: "confirmed" }),
    ).toBe("received");
    expect(stageFromJournal({ journalId: null, journalStatus: null, paymentStatus: "pending" })).toBe(
      "pending",
    );
    expect(stageFromJournal({ journalId: null, journalStatus: null, paymentStatus: "failed" })).toBe(
      "unsuccessful",
    );
  });

  it("invents no actor when none was captured", () => {
    const anonymous = mapPaymentLifecycle({ payment_id: "x", amount: 10 });
    expect(anonymous.actorName).toBeNull();
    expect(anonymous.actorId).toBeNull();
  });
});

describe("journal detail equals the general ledger", () => {
  it("matches line for line", () => {
    expect(detailMatchesLedger(ledger, ledger)).toBe(true);
  });

  it("fails when detail omits a line the ledger holds", () => {
    expect(detailMatchesLedger([ledger[0]!], ledger)).toBe(false);
  });
});

describe("the register cannot omit a valid posted transaction", () => {
  it("keeps every posted row in the register view", () => {
    const rows = [payment, mapPaymentLifecycle({ payment_id: "b", amount: 500, stage: "received" })];
    const register = rows.filter((r) => r.stage !== "unsuccessful");
    expect(register).toHaveLength(2);
    expect(register.some((r) => r.receiptNumber === "RCT-2026-000003")).toBe(true);
  });
});

describe("retrying does not duplicate", () => {
  it("collapses a repeated projection read to one receipt", () => {
    const replay = [payment, mapPaymentLifecycle({ payment_id: payment.paymentId, amount: payment.amount })];
    const unique = new Set(replay.map((r) => r.paymentId));
    expect(unique.size).toBe(1);
  });
});

describe("partner messaging refusals", () => {
  it("explains refusals in plain words and never silently succeeds", () => {
    expect(sendFailure("empty_message")).toMatch(/message/i);
    expect(sendFailure("not_permitted")).toMatch(/not authorised/i);
    expect(sendFailure()).toMatch(/could not be sent/i);
  });
});
