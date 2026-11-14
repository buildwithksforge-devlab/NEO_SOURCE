import { describe, expect, it } from "vitest";
import { journalTotals } from "@/lib/finance-subledger";

describe("journal numeric integrity", () => {
  it.each([Infinity, NaN, -1, 0.001])("refuses invalid posted line amounts: %s", (amount) => {
    expect(journalTotals({ lines: [
      { accountCode: "A", debit: amount }, { accountCode: "B", credit: amount },
    ] }).balanced).toBe(false);
  });
  it("refuses a line with both debit and credit even if total sums match", () => {
    expect(journalTotals({ lines: [{ accountCode: "A", debit: 100, credit: 100 }] }).balanced).toBe(false);
  });
  it("retains a balanced split-cent-total journal", () => {
    expect(journalTotals({ lines: [
      { accountCode: "A", debit: 0.1 }, { accountCode: "A", debit: 0.2 },
      { accountCode: "B", credit: 0.3 },
    ] }).balanced).toBe(true);
  });
});
