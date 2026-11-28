import { describe, expect, it } from "vitest";

import {
  customerFinancialPosition,
} from "../customer-financial-position";

const invoice = {
  status: "issued",
  currency: "KES",
  total: 5000,
  balance: 3000,
  due_date: "2026-11-01",
};

const asOf = new Date("2026-11-26T00:00:00Z");

describe("customer financial position", () => {
  it("reports outstanding invoice balances", () => {
    const result = customerFinancialPosition(
      [invoice], [], [], asOf
    );

    expect(result[0]?.outstanding).toBe(3000);
    expect(result[0]?.billed).toBe(5000);
  });

  it("excludes cancelled invoices", () => {
    expect(customerFinancialPosition(
      [{ ...invoice, status: "cancelled" }],
      [],
      [],
      asOf
    )).toEqual([]);
  });

  it("excludes draft invoices", () => {
    expect(customerFinancialPosition(
      [{ ...invoice, status: "draft" }],
      [],
      [],
      asOf
    )).toEqual([]);
  });

  it("separates pending receipts from posted receipts", () => {
    const result = customerFinancialPosition(
      [],
      [
        {
          amount: 500,
          currency: "KES",
          status: "confirmed",
          posted_journal_id: "journal",
        },
        {
          amount: 200,
          currency: "KES",
          status: "pending",
        },
      ],
      [],
      asOf
    );

    expect(result[0]?.postedReceipts).toBe(500);
    expect(result[0]?.pendingReceipts).toBe(200);
  });

  it("does not count failed payments", () => {
    expect(customerFinancialPosition(
      [],
      [{
        amount: 1000,
        currency: "KES",
        status: "failed",
      }],
      [],
      asOf
    )).toEqual([]);
  });

  it("does not report unposted payments as posted receipts", () => {
    const result = customerFinancialPosition(
      [],
      [{
        amount: 1000,
        currency: "KES",
        status: "confirmed",
      }],
      [],
      asOf
    );

    expect(result[0]?.postedReceipts).toBe(0);
    expect(result[0]?.pendingReceipts).toBe(1000);
  });

  it("does not combine currencies", () => {
    const result = customerFinancialPosition(
      [
        invoice,
        { ...invoice, currency: "USD" },
      ],
      [],
      [],
      asOf
    );

    expect(result).toHaveLength(2);
  });

  it("calculates 1 to 30 day aging", () => {
    const result = customerFinancialPosition(
      [invoice], [], [], asOf
    );

    expect(result[0]?.overdue30).toBe(3000);
  });

  it("calculates 31 to 60 day aging", () => {
    const result = customerFinancialPosition(
      [{ ...invoice, due_date: "2026-10-10" }],
      [],
      [],
      asOf
    );

    expect(result[0]?.overdue60).toBe(3000);
  });

  it("calculates overdue balances beyond 90 days", () => {
    const result = customerFinancialPosition(
      [{ ...invoice, due_date: "2026-01-01" }],
      [],
      [],
      asOf
    );

    expect(result[0]?.overdueBeyond90).toBe(3000);
  });

  it("flags invalid financial records", () => {
    const result = customerFinancialPosition(
      [{ ...invoice, balance: Number.NaN }],
      [],
      [],
      asOf
    );

    expect(result[0]?.invalidRecords).toBe(1);
  });

  it("does not treat cancelled credit notes as credits", () => {
    expect(customerFinancialPosition(
      [],
      [],
      [{
        currency: "KES",
        status: "cancelled",
        total: 500,
      }],
      asOf
    )).toEqual([]);
  });

  it("reports issued credit notes", () => {
    const result = customerFinancialPosition(
      [],
      [],
      [{
        currency: "KES",
        status: "issued",
        total: 500,
      }],
      asOf
    );

    expect(result[0]?.credited).toBe(500);
  });
});