import { describe, expect, it } from "vitest";
import { payableBlocked } from "@/lib/ap-matching";
import { describePolicy } from "@/lib/deposit-policies";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";

describe("AP matching and deposit policy contracts", () => {
  it("blocks payable creation only while an invoice is held", () => {
    expect(payableBlocked({ match_status: "held" })).toBe(true);
    expect(payableBlocked({ match_status: "matched" })).toBe(false);
    expect(payableBlocked(null)).toBe(false);
  });

  it("describes each deposit basis in the words the desk reads", () => {
    const base = {
      id: "p",
      branch_id: null,
      name: "Standard",
      minimum_amount: 0,
      reason: "r",
      priority: 100,
      active: true,
    };
    expect(describePolicy({ ...base, basis: "percentage", value: 30 })).toMatch(/30/);
    expect(describePolicy({ ...base, basis: "flat", value: 5000 })).toMatch(/5,?000/);
    expect(describePolicy({ ...base, basis: "nights", value: 1 })).toMatch(/night/i);
  });

  it("declares the new reporting routines as authenticated", () => {
    for (const fn of [
      "neo_ap_match_lines",
      "neo_ap_journal_register",
      "neo_deposit_reconciliation",
      "neo_deposit_post",
    ]) {

      expect(RPC_MANIFEST[fn as string]).toBe("authenticated");
    }
  });
});
