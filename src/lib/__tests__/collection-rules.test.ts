import { describe, expect, it } from "vitest";
import { collectionKey, evaluateCollection } from "@/lib/collection-rules";

const base = {
  balance: 3250,
  amount: "",
  tendered: "",
  method: "cash",
  openShiftId: "till-1",
  pending: false,
};

describe("cashier collection rules", () => {
  it("collects the whole balance when no amount is typed", () => {
    const v = evaluateCollection(base);
    expect(v.value).toBe(3250);
    expect(v.blocked).toBe(false);
    expect(v.reason).toBeNull();
  });

  it("refuses cash when the cashier has no open till", () => {
    const v = evaluateCollection({ ...base, openShiftId: null });
    expect(v.tillMissing).toBe(true);
    expect(v.blocked).toBe(true);
    expect(v.reason).toMatch(/Open your till/);
  });

  it("allows a card payment without an open till", () => {
    const v = evaluateCollection({ ...base, method: "card", openShiftId: null });
    expect(v.tillMissing).toBe(false);
    expect(v.blocked).toBe(false);
  });

  it("computes change from cash tendered", () => {
    const v = evaluateCollection({ ...base, tendered: "4000" });
    expect(v.change).toBe(750);
    expect(v.blocked).toBe(false);
  });

  it("blocks a tender smaller than the amount collected", () => {
    const v = evaluateCollection({ ...base, tendered: "3000" });
    expect(v.shortTender).toBe(true);
    expect(v.blocked).toBe(true);
  });

  it("blocks an overpayment rather than creating a credit by hand", () => {
    const v = evaluateCollection({ ...base, amount: "4000" });
    expect(v.overpaid).toBe(true);
    expect(v.reason).toMatch(/refund/);
  });

  it("blocks a zero or unreadable amount", () => {
    expect(evaluateCollection({ ...base, amount: "0" }).blocked).toBe(true);
    expect(evaluateCollection({ ...base, amount: "abc" }).blocked).toBe(true);
  });

  it("blocks while a collection is already in flight", () => {
    expect(evaluateCollection({ ...base, pending: true }).blocked).toBe(true);
  });

  it("gives one stable key per bill and amount, so a double click is one collection", () => {
    expect(collectionKey("front-office", "folio-1", 3250)).toBe(
      collectionKey("front-office", "folio-1", 3250.0),
    );
    expect(collectionKey("front-office", "folio-1", 3250)).not.toBe(
      collectionKey("front-office", "folio-1", 3200),
    );
  });

  it("keeps no change on a non-cash method", () => {
    expect(evaluateCollection({ ...base, method: "mpesa", tendered: "4000" }).change).toBe(0);
  });
});
