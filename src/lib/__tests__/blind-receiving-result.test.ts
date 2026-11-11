import { describe, it, expect } from "vitest";
import { requireBlindReceiptResult } from "@/lib/supply-command-result";
const count = "b6000000-0000-4000-8000-000000000050",
  grn = "b6000000-0000-4000-8000-000000000060";
describe("approved receiving screen evidence", () => {
  it.each([
    null,
    {},
    { ok: false, count_id: count, status: "posted", grn_id: grn },
    { ok: true, count_id: "other", status: "posted", grn_id: grn },
    { ok: true, count_id: count, status: "approved", grn_id: grn },
  ])("rejects an unverified posting %j", (v) =>
    expect(() => requireBlindReceiptResult(v, count)).toThrow(),
  );
  it("keeps stock received distinct from pending Finance", () => {
    const v = {
      ok: true,
      count_id: count,
      status: "posted",
      grn_id: grn,
      lifecycle_result: {
        ok: true,
        receipt_id: grn,
        grn_number: "GRN-1",
        posting: { status: "pending-finance" },
      },
    };
    expect(requireBlindReceiptResult(v, count)).toEqual(v);
  });
  it("accepts a durable replay without inventing a new posting", () =>
    expect(
      requireBlindReceiptResult(
        { ok: true, count_id: count, status: "posted", grn_id: grn, replayed: true },
        count,
      )["grn_id"],
    ).toBe(grn));
});
