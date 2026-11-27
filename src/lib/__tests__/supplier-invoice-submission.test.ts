import {describe,expect,it} from "vitest";

import {
  validateSupplierInvoiceSubmission,
  assertSupplierInvoiceSubmission,
} from "../supplier-invoice-submission";

const draft = {
  orderNumber:"LPO-001",
  invoiceNumber:"INV-001",
  invoiceDate:"2026-11-26",
  amount:"12500.00",
  deliveryReference:"GRN-001",
  notes:"",
};

describe("supplier invoice submissions", () => {

  it("validates a commercial invoice", () => {
    expect(
      validateSupplierInvoiceSubmission(draft).amount
    ).toBe(12500);
  });

  it("requires an existing purchase order reference", () => {
    expect(() =>
      validateSupplierInvoiceSubmission({
        ...draft,
        orderNumber:"",
      })
    ).toThrow();
  });

  it("requires an invoice number", () => {
    expect(() =>
      validateSupplierInvoiceSubmission({
        ...draft,
        invoiceNumber:" ",
      })
    ).toThrow();
  });

  it("rejects zero invoice amounts", () => {
    expect(() =>
      validateSupplierInvoiceSubmission({
        ...draft,
        amount:"0",
      })
    ).toThrow();
  });

  it("rejects negative invoice amounts", () => {
    expect(() =>
      validateSupplierInvoiceSubmission({
        ...draft,
        amount:"-100",
      })
    ).toThrow();
  });

  it("rejects excessive monetary precision", () => {
    expect(() =>
      validateSupplierInvoiceSubmission({
        ...draft,
        amount:"10.123",
      })
    ).toThrow();
  });

  it("rejects nonfinite amounts", () => {
    expect(() =>
      validateSupplierInvoiceSubmission({
        ...draft,
        amount:"Infinity",
      })
    ).toThrow();
  });

  it("rejects invalid calendar dates", () => {
    expect(() =>
      validateSupplierInvoiceSubmission({
        ...draft,
        invoiceDate:"2026-02-30",
      })
    ).toThrow();
  });

  it("retains delivery evidence references", () => {
    expect(
      validateSupplierInvoiceSubmission(draft)
        .deliveryReference
    ).toBe("GRN-001");
  });

  it("rejects excessive notes", () => {
    expect(() =>
      validateSupplierInvoiceSubmission({
        ...draft,
        notes:"a".repeat(4001),
      })
    ).toThrow();
  });

  it("requires a persisted submission identity", () => {
    expect(() =>
      assertSupplierInvoiceSubmission({ok:true})
    ).toThrow();
  });

  it("recognizes confirmed submissions", () => {
    expect(
      assertSupplierInvoiceSubmission({
        ok:true,
        submission_id:"submission-1",
      })
    ).toBe("submission-1");
  });

});