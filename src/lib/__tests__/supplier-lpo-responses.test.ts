import { describe,expect,it } from "vitest";

import {
  validateSupplierLpoResponse,
  assertSupplierLpoResult,
  supplierLpoResponseLabel,
} from "../supplier-lpo-responses";

describe("supplier LPO responses", () => {
  const base = {
    response:"accepted" as const,
    deliveryDate:"2026-12-01",
    notes:"",
  };

  it("accepts a dated delivery commitment", () => {
    expect(
      validateSupplierLpoResponse(base).response
    ).toBe("accepted");
  });

  it("requires a delivery date when accepting", () => {
    expect(() =>
      validateSupplierLpoResponse({
        ...base,
        deliveryDate:"",
      })
    ).toThrow();
  });

  it("requires a reason for declining", () => {
    expect(() =>
      validateSupplierLpoResponse({
        ...base,
        response:"declined",
      })
    ).toThrow();
  });

  it("allows a decline with a reason", () => {
    expect(
      validateSupplierLpoResponse({
        response:"declined",
        deliveryDate:"",
        notes:"Stock unavailable",
      }).response
    ).toBe("declined");
  });

  it("supports a requested change", () => {
    expect(
      validateSupplierLpoResponse({
        response:"changes-requested",
        deliveryDate:"2026-12-05",
        notes:"Supplier requires additional lead time",
      }).response
    ).toBe("changes-requested");
  });

  it("rejects changes without explanation", () => {
    expect(() =>
      validateSupplierLpoResponse({
        ...base,
        response:"changes-requested",
      })
    ).toThrow();
  });

  it("rejects invalid calendar dates", () => {
    expect(() =>
      validateSupplierLpoResponse({
        ...base,
        deliveryDate:"2026-02-30",
      })
    ).toThrow();
  });

  it("rejects invalid date formats", () => {
    expect(() =>
      validateSupplierLpoResponse({
        ...base,
        deliveryDate:"tomorrow",
      })
    ).toThrow();
  });

  it("rejects excessive response notes", () => {
    expect(() =>
      validateSupplierLpoResponse({
        ...base,
        notes:"x".repeat(4001),
      })
    ).toThrow();
  });

  it("does not accept unconfirmed submissions", () => {
    expect(() =>
      assertSupplierLpoResult({ok:true})
    ).toThrow();
  });

  it("requires a persisted response identity", () => {
    expect(
      assertSupplierLpoResult({
        ok:true,
        response_id:"response-1",
      })
    ).toBe("response-1");
  });

  it("distinguishes acceptance from purchase approval", () => {
    expect(
      supplierLpoResponseLabel("accepted")
    ).toBe("Accepted by supplier");
  });

  it("does not fabricate a known response status", () => {
    expect(
      supplierLpoResponseLabel("unexpected")
    ).toBe("Unrecognized response");
  });
});