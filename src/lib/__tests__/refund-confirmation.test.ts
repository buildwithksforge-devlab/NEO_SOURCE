import { describe, it, expect } from "vitest";
import {
  requireRefundRequest,
  requireRefundDecision,
  requireRefundPayout,
  validateRefundAmount,
} from "@/lib/refund-command-result";
describe("refund saved-evidence boundaries", () => {
  it.each([null, {}, { ok: true }, { ok: false, request_id: "r", status: "pending" }])(
    "rejects unsaved request %j",
    (v) => expect(() => requireRefundRequest(v)).toThrow(),
  );
  it("keeps approval distinct from payout", () => {
    expect(
      requireRefundDecision({ ok: true, request_id: "r", status: "approved" }, "r", true)["status"],
    ).toBe("approved");
    expect(() => requireRefundPayout({ ok: true, request_id: "r", status: "approved" })).toThrow();
  });
  it("rejects mismatched decisions", () => {
    expect(() =>
      requireRefundDecision({ ok: true, request_id: "other", status: "approved" }, "r", true),
    ).toThrow();
    expect(() =>
      requireRefundDecision({ ok: true, request_id: "r", status: "approved" }, "r", false),
    ).toThrow();
  });
  it("requires the refund receipt and posted journal", () => {
    const r = {
      ok: true,
      refund_id: "r",
      payment_id: "p",
      refund_receipt_number: "RF-1",
      journal_id: "j",
      status: "settled",
    };
    expect(requireRefundPayout(r)).toEqual(r);
    for (const key of ["payment_id", "refund_receipt_number", "journal_id"])
      expect(() => requireRefundPayout({ ...r, [key]: null })).toThrow();
  });
  it.each([NaN, Infinity, -1, 0, 0.001])("rejects unsafe amount %s", (amount) =>
    expect(() => validateRefundAmount(amount, "Guest return")).toThrow(),
  );
  it("accepts cents with a reason", () =>
    expect(() => validateRefundAmount(12.34, "Guest return")).not.toThrow());
});
