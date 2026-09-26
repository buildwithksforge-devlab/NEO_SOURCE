import { describe, expect, it } from "vitest";
import {
  LEGACY_PAYMENT_METHOD_ALIASES,
  PAYMENT_METHOD_CATALOGUE,
  normalisePaymentMethod,
  paymentMethodLabel,
} from "@/lib/payment-methods";
import { checkCallbackBase, isTemporaryHost } from "@/lib/mpesa-callback";
import { PAYMENT_METHODS as POS_METHODS } from "@/lib/pos";
import { PAYMENT_METHODS as AP_METHODS } from "@/lib/finance";

const canonical = new Set(PAYMENT_METHOD_CATALOGUE.map((m) => m.value));

describe("payment method catalogue", () => {
  it("has no duplicate entries", () => {
    expect(canonical.size).toBe(PAYMENT_METHOD_CATALOGUE.length);
  });

  it("maps every old spelling onto a method that still exists", () => {
    for (const [legacy, target] of Object.entries(LEGACY_PAYMENT_METHOD_ALIASES)) {
      expect(canonical.has(target), `${legacy} -> ${target}`).toBe(true);
      expect(canonical.has(legacy), `${legacy} should not also be canonical`).toBe(false);
    }
  });

  it("reads records saved with older spellings as the right method", () => {
    expect(normalisePaymentMethod("bank_transfer")).toBe("bank-transfer");
    expect(normalisePaymentMethod("Debit-Card")).toBe("card");
    expect(normalisePaymentMethod("credit_card")).toBe("card");
    expect(normalisePaymentMethod("city-ledger")).toBe("corporate-credit");
    expect(normalisePaymentMethod("cash-on-delivery")).toBe("cash");
    expect(normalisePaymentMethod("M-PESA")).toBe("mpesa");
    expect(normalisePaymentMethod(null)).toBe("");
  });

  it("never invents a method that is not in the catalogue", () => {
    expect(normalisePaymentMethod("barter")).toBe("barter");
    expect(paymentMethodLabel("barter")).toBe("Barter");
    expect(paymentMethodLabel(null)).toBe("—");
  });

  it("offers only canonical choices on the till and supplier screens", () => {
    for (const m of POS_METHODS) {
      if (m === "complimentary" || m === "other") continue;
      expect(canonical.has(m), `POS offers ${m}`).toBe(true);
    }
    for (const m of AP_METHODS) {
      if (m === "complimentary" || m === "loyalty") continue;
      expect(canonical.has(m), `Supplier payments offer ${m}`).toBe(true);
    }
  });
});

describe("M-Pesa confirmation address", () => {
  it("accepts a plain secure address and trims trailing slashes", () => {
    expect(checkCallbackBase("https://book.hotel.co.ke/")).toEqual({ ok: true, value: "https://book.hotel.co.ke" });
  });

  it("treats a blank entry as nothing saved rather than an error", () => {
    expect(checkCallbackBase("")).toEqual({ ok: true, value: null });
  });

  it("refuses insecure, incomplete or query-laden addresses", () => {
    expect(checkCallbackBase("http://book.hotel.co.ke").ok).toBe(false);
    expect(checkCallbackBase("book.hotel.co.ke").ok).toBe(false);
    expect(checkCallbackBase("https://book.hotel.co.ke/?x=1").ok).toBe(false);
  });

  it("recognises temporary preview addresses", () => {
    expect(isTemporaryHost("https://id-preview--abc.lovable.app/api/x")).toBe(true);
    expect(isTemporaryHost("https://horizon-prime-os-dev.lovable.app")).toBe(true);
    expect(isTemporaryHost("http://localhost:8080")).toBe(true);
    expect(isTemporaryHost("https://book.hotel.co.ke")).toBe(false);
  });
});
