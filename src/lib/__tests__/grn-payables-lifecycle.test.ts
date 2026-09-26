import { describe, expect, it } from "vitest";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";
import { DISCREPANCY_LABELS, outstandingQuantity } from "@/lib/procurement";

/**
 * The receipt → payable trail is a contract, not a convenience: stock value may
 * never rise without an accounting explanation, and a payable may never exist
 * without a supplier invoice that has been matched.
 */
describe("goods receipt and payable surface", () => {
  it("declares every new procurement/finance routine as authenticated-only", () => {
    for (const fn of [
      "neo_supplier_invoice_capture",
      "neo_supplier_invoice_accept",
      "neo_grn_reverse",
      "neo_matching_policy",
      "proc_three_way_match",
      "inventory_post_receipt",
    ]) {
      expect(RPC_MANIFEST[fn]).toBe("authenticated");
    }
  });

  it("names every matching exception the invoice inspector can show", () => {
    for (const kind of [
      "duplicate-invoice",
      "no-purchase-order",
      "unordered-item",
      "quantity-invoiced-over-received",
      "outstanding-delivery",
      "price-variance",
    ]) {
      expect(DISCREPANCY_LABELS[kind]).toBeTruthy();
    }
  });

  it("never reports a negative outstanding quantity on a partly received line", () => {
    expect(outstandingQuantity({ quantity: 100, accepted_quantity: 90, cancelled_quantity: 0 })).toBe(10);
    expect(outstandingQuantity({ quantity: 100, accepted_quantity: 120, cancelled_quantity: 0 })).toBe(0);
  });
});

/** Mirrors the SQL claimable-quantity rule so the intent is pinned in the repo. */
function claimable(input: {
  ordered: number;
  accepted: number;
  alreadyInvoiced: number;
  mode: "two-way" | "three-way";
  qtyTolerancePct?: number;
}) {
  const base = input.mode === "two-way" ? input.ordered : input.accepted;
  return base * (1 + (input.qtyTolerancePct ?? 0) / 100) - input.alreadyInvoiced;
}

function priceIsCritical(orderPrice: number, invoicePrice: number, pct: number, amount: number) {
  const tolerance = Math.max((orderPrice * pct) / 100, amount);
  return invoicePrice > orderPrice + tolerance;
}

describe("matching rules", () => {
  it("holds PO 100 / GRN 90 / invoice 100 instead of quietly paying it", () => {
    const allowed = claimable({ ordered: 100, accepted: 90, alreadyInvoiced: 0, mode: "three-way" });
    expect(allowed).toBe(90);
    expect(100 > allowed).toBe(true);
  });

  it("lets a two-way policy invoice the ordered quantity before delivery", () => {
    expect(claimable({ ordered: 100, accepted: 0, alreadyInvoiced: 0, mode: "two-way" })).toBe(100);
  });

  it("stops a second invoice claiming quantities the first already took", () => {
    const allowed = claimable({ ordered: 100, accepted: 90, alreadyInvoiced: 60, mode: "three-way" });
    expect(allowed).toBe(30);
    expect(40 > allowed).toBe(true);
  });

  it("treats a 500 → 550 price rise as critical under a 2% tolerance", () => {
    expect(priceIsCritical(500, 550, 2, 0)).toBe(true);
  });

  it("accepts a price rise that stays inside the configured tolerance", () => {
    expect(priceIsCritical(500, 505, 2, 0)).toBe(false);
  });
});
