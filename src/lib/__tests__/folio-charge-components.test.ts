import { describe, expect, it } from "vitest";
import { readFolioChargeComponents } from "@/lib/folio-charge-components";
import { balancesGross, mapFolioProjection } from "@/lib/payment-lifecycle";

describe("folio obligation components", () => {
  it("accepts the older projection without inventing charges", () => {
    expect(readFolioChargeComponents({})).toEqual({ otherCharges: 0, chargeComponents: [] });
  });
  it("keeps payable tips separate from net revenue while reconciling the bill", () => {
    const p = mapFolioProjection({ net_revenue: 100, tax: 16, service_charge: 10,
      other_charges: 7, charge_components: [{ key: "gratuity", label: "Staff tips", amount: "7", classification: "liability" }],
      gross_obligation: 133 });
    expect(p.netRevenue).toBe(100);
    expect(p.chargeComponents[0]?.amount).toBe(7);
    expect(balancesGross(p)).toBe(true);
  });
  it("accommodates more than one named component and negative reversals", () => {
    expect(readFolioChargeComponents({ other_charges: 5, charge_components: [
      { key: "tip", label: "Staff tips", amount: 7 }, { key: "reversal", label: "Tip reversal", amount: -2 },
    ] }).otherCharges).toBe(5);
  });
  it.each([
    { other_charges: 7 },
    { other_charges: "Infinity" },
    { other_charges: null },
    { other_charges: true },
    { other_charges: 1, charge_components: [] },
    { other_charges: 0, charge_components: [{ key: "a", label: "A", amount: null }] },
    { other_charges: 0, charge_components: [{ key: "a", label: "A", amount: "NaN" }] },
    { other_charges: 0, charge_components: [{ key: "a", label: "A", amount: false }] },
    { other_charges: 2, charge_components: [{ key: "a", label: "A", amount: 1 }, { key: "a", label: "A", amount: 1 }] },
  ])("refuses an unverifiable breakdown: %j", (raw) => {
    expect(() => readFolioChargeComponents(raw)).toThrow();
  });
});
