import { describe, expect, it } from "vitest";

import {
  summarizeCashierCollections,
  collectionStatusGroup,
  cashierDateRange,
  type CashierCollectionRow,
} from "../cashier-collection-analysis";

function row(
  id: string,
  amount: number,
  status = "confirmed",
  currency = "KES",
  method = "cash"
): CashierCollectionRow {
  return {
    id,
    amount,
    status,
    currency,
    method,
    created_at: "2026-11-26T08:00:00Z",
  };
}

describe("cashier collection reporting", () => {
  it("totals confirmed collections", () => {
    const result = summarizeCashierCollections([
      row("a", 500),
      row("b", 1500),
    ]);

    expect(result[0]?.confirmed).toBe(2000);
    expect(result[0]?.confirmedCount).toBe(2);
  });

  it("separates pending money from confirmed collections", () => {
    const result = summarizeCashierCollections([
      row("a", 1000),
      row("b", 500, "pending"),
    ]);

    expect(result[0]?.confirmed).toBe(1000);
    expect(result[0]?.pending).toBe(500);
  });

  it("does not add reversed records to confirmed collections", () => {
    const result = summarizeCashierCollections([
      row("a", 1000),
      row("b", 400, "refunded"),
    ]);

    expect(result[0]?.confirmed).toBe(1000);
    expect(result[0]?.refunded).toBe(400);
  });

  it("separates currencies", () => {
    const result = summarizeCashierCollections([
      row("a", 1000, "confirmed", "KES"),
      row("b", 100, "confirmed", "USD"),
    ]);

    expect(result).toHaveLength(2);
    expect(result.find((r) => r.currency === "KES")?.confirmed)
      .toBe(1000);
    expect(result.find((r) => r.currency === "USD")?.confirmed)
      .toBe(100);
  });

  it("deduplicates repeated payment identities", () => {
    expect(
      summarizeCashierCollections([
        row("a", 500),
        row("a", 500),
      ])[0]?.confirmed
    ).toBe(500);
  });

  it("rejects invalid numerical values from summaries", () => {
    expect(
      summarizeCashierCollections([
        row("a", Number.NaN),
        row("b", Infinity),
        row("c", -500),
      ])
    ).toEqual([]);
  });

  it("calculates average confirmed collection", () => {
    expect(
      summarizeCashierCollections([
        row("a", 500),
        row("b", 1000),
      ])[0]?.averageCollection
    ).toBe(750);
  });

  it("groups confirmed collections by payment method", () => {
    const result = summarizeCashierCollections([
      row("a", 500, "confirmed", "KES", "cash"),
      row("b", 1500, "confirmed", "KES", "mpesa"),
    ]);

    expect(result[0]?.methods).toEqual([
      { method: "mpesa", count: 1, amount: 1500 },
      { method: "cash", count: 1, amount: 500 },
    ]);
  });

  it("keeps unrecognized statuses outside confirmed totals", () => {
    expect(collectionStatusGroup("unknown")).toBe("other");

    const result = summarizeCashierCollections([
      row("a", 500, "failed"),
    ]);

    expect(result[0]?.confirmed).toBe(0);
    expect(result[0]?.other).toBe(500);
  });

  it("normalizes known settlement states", () => {
    expect(collectionStatusGroup(" CONFIRMED "))
      .toBe("confirmed");

    expect(collectionStatusGroup("settled"))
      .toBe("confirmed");
  });

  it("returns an empty report for no collections", () => {
    expect(summarizeCashierCollections([])).toEqual([]);
  });

  it("produces a valid daily reporting range", () => {
    const result = cashierDateRange(
      "today",
      new Date("2026-11-26T10:00:00")
    );

    expect(result.from < result.to).toBe(true);
  });

  it("does not label missing currency as KES", () => {
    const result = summarizeCashierCollections([
      { ...row("a", 500), currency: null },
    ]);

    expect(result[0]?.currency).toBe("UNSPECIFIED");
  });
});

describe("cashier amount integrity", () => {

  it("does not treat an empty amount as a zero collection", () => {
    expect(
      summarizeCashierCollections([
        { ...row("blank", 500), amount: "" },
      ])
    ).toEqual([]);
  });

  it("does not treat whitespace as a valid collection", () => {
    expect(
      summarizeCashierCollections([
        { ...row("blank", 500), amount: "   " },
      ])
    ).toEqual([]);
  });

  it("accepts valid decimal amounts from database records", () => {
    const result = summarizeCashierCollections([
      { ...row("decimal", 500), amount: "125.50" },
    ]);

    expect(result[0]?.confirmed).toBe(125.50);
  });

  it("does not combine confirmed and pending currencies", () => {
    const result = summarizeCashierCollections([
      row("a", 500, "confirmed", "KES"),
      row("b", 100, "pending", "USD"),
    ]);

    expect(result.find((r) => r.currency === "KES")?.confirmed)
      .toBe(500);

    expect(result.find((r) => r.currency === "USD")?.confirmed)
      .toBe(0);

    expect(result.find((r) => r.currency === "USD")?.pending)
      .toBe(100);
  });

});