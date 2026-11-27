import { describe, expect, it } from "vitest";

import {
  invoiceRepaymentEligible,
  validateCustomerRepayment,
  assertCustomerRepaymentResult,
} from "../customer-repayment";

const invoice = {
  id: "invoice-1",
  status: "issued",
  balance: 3000,
};

const input = {
  invoiceId: "invoice-1",
  amount: "1500",
  method: "cash",
  reference: "",
  notes: "",
  accountId: "account-1",
  intentKey: "attempt-1",
};

describe("customer invoice repayment", () => {
  it("accepts a partial repayment", () => {
    expect(validateCustomerRepayment(input, invoice))
      .toBe(1500);
  });

  it("accepts full settlement", () => {
    expect(validateCustomerRepayment(
      { ...input, amount: "3000" },
      invoice
    )).toBe(3000);
  });

  it("rejects overpayment", () => {
    expect(() => validateCustomerRepayment(
      { ...input, amount: "3000.01" },
      invoice
    )).toThrow();
  });

  it("rejects negative repayments", () => {
    expect(() => validateCustomerRepayment(
      { ...input, amount: "-100" },
      invoice
    )).toThrow();
  });

  it("rejects nonfinite amounts", () => {
    expect(() => validateCustomerRepayment(
      { ...input, amount: "Infinity" },
      invoice
    )).toThrow();
  });

  it("rejects excess decimal precision", () => {
    expect(() => validateCustomerRepayment(
      { ...input, amount: "100.001" },
      invoice
    )).toThrow();
  });

  it("rejects settled invoices", () => {
    expect(invoiceRepaymentEligible({
      ...invoice,
      status: "paid",
    })).toBe(false);
  });

  it("rejects draft invoices", () => {
    expect(invoiceRepaymentEligible({
      ...invoice,
      status: "draft",
    })).toBe(false);
  });

  it("accepts partially paid invoices", () => {
    expect(invoiceRepaymentEligible({
      ...invoice,
      status: "partially_paid",
    })).toBe(true);
  });

  it("rejects a missing transaction identity", () => {
    expect(() => validateCustomerRepayment(
      { ...input, intentKey: "" },
      invoice
    )).toThrow();
  });

  it("rejects a missing financial account", () => {
    expect(() => validateCustomerRepayment(
      { ...input, accountId: "" },
      invoice
    )).toThrow();
  });

  it("requires a noncash payment reference", () => {
    expect(() => validateCustomerRepayment(
      { ...input, method: "mpesa" },
      invoice
    )).toThrow();
  });

  it("rejects mismatched invoice identity", () => {
    expect(() => validateCustomerRepayment(
      { ...input, invoiceId: "other-invoice" },
      invoice
    )).toThrow();
  });

  it("requires receipt and journal evidence", () => {
    expect(() => assertCustomerRepaymentResult({
      ok: true,
      payment_id: "payment",
    })).toThrow();
  });

  it("confirms a persisted repayment", () => {
    expect(assertCustomerRepaymentResult({
      ok: true,
      payment_id: "payment",
      journal_id: "journal",
      receipt_number: "REC-001",
    }).receiptNumber).toBe("REC-001");
  });

  it("recognizes an idempotent repayment response", () => {
    expect(assertCustomerRepaymentResult({
      ok: true,
      payment_id: "payment",
      journal_id: "journal",
      receipt_number: "REC-001",
      duplicate_prevented: true,
    }).duplicatePrevented).toBe(true);
  });
});