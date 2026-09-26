/**
 * Phase 1C closure — supply chain operator reachability.
 *
 * These assertions are about the six verified gaps: the stock catalogue, the
 * reorder -> draft purchase request action, purchase order and RFQ route
 * registration, department-side receipt confirmation, and Finance payables
 * navigation. They read the real source so a future edit cannot silently
 * un-reach an operator journey.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ROUTE_CAPABILITIES, capabilitiesForPath, pathPermitted } from "@/lib/capabilities";
import { navigation as NAVIGATION } from "@/lib/navigation";
import { reorderQuantityFor } from "@/lib/inventory-data";

const src = (p: string) => readFileSync(resolve(process.cwd(), "src", p), "utf8");

const navPaths = () => {
  const paths: string[] = [];
  for (const group of NAVIGATION) {
    for (const item of group.items) {
      paths.push(item.to);
      
    }
  }
  return paths;
};

describe("stock item catalogue is operator reachable", () => {
  it("registers /inventory/items in the route registry", () => {
    expect(ROUTE_CAPABILITIES.some((r) => r.prefix === "/inventory/items")).toBe(true);
    expect(capabilitiesForPath("/inventory/items").length).toBeGreaterThan(0);
  });

  it("is present in navigation", () => {
    expect(navPaths()).toContain("/inventory/items");
  });

  it("guards the route through the shared path guard, not a stale local action", () => {
    const file = src("routes/_shell.inventory.items.tsx");
    expect(file).toContain('<OpsGuard path="/inventory/items">');
    expect(file).not.toContain('action="suppliers.edit"');
  });

  it("no longer sends operators to the supplier admin page to add stock", () => {
    expect(src("routes/_shell.inventory.index.tsx")).not.toContain(
      '<Link to="/admin/suppliers">Add stock item</Link>',
    );
  });
});

describe("reorder recommendation raises a draft purchase request only", () => {
  it("buys back to par, not merely to the reorder point", () => {
    expect(reorderQuantityFor({ on_hand: 16, min_level: 20, par_level: 50 })).toBe(34);
  });

  it("falls back to the suggested quantity when no par level is supplied", () => {
    expect(reorderQuantityFor({ on_hand: 16, min_level: 20, suggested_quantity: 34 })).toBe(34);
  });

  it("never returns a negative quantity", () => {
    expect(reorderQuantityFor({ on_hand: 80, par_level: 50 })).toBe(0);
  });

  it("writes a draft canonical purchase request and never an order", () => {
    const file = src("lib/inventory-data.ts");
    // The draft request and its line are written together by the canonical
    // function, which hard-codes the draft status server-side.
    expect(file).toContain("neo_purchase_request_from_reorder");
    expect(file).not.toContain('from("purchase_orders").insert');
  });

  it("surfaces the action on the inventory recommendation list", () => {
    const file = src("routes/_shell.inventory.index.tsx");
    expect(file).toContain("useRaiseReorderRequest");
    expect(file).toContain("Raise purchase request");
    // The recommendation rows are keyed by the item id the RPC actually returns.
    expect(file).not.toContain('r["stock_item_id"]');
  });
});

describe("purchase orders and RFQs are registered and navigable", () => {
  for (const path of ["/procurement/orders", "/procurement/quotations"]) {
    it(`${path} has route capabilities`, () => {
      expect(capabilitiesForPath(path).length).toBeGreaterThan(0);
    });
    it(`${path} appears in navigation`, () => {
      expect(navPaths()).toContain(path);
    });
  }

  it("uses the shared path guard so nav and route agree", () => {
    expect(src("routes/_shell.procurement.orders.tsx")).toContain(
      '<OpsGuard path="/procurement/orders">',
    );
    expect(src("routes/_shell.procurement.quotations.tsx")).toContain(
      '<OpsGuard path="/procurement/quotations">',
    );
  });

  it("keeps the RFQ despatch state honest — nothing claims a message was sent", () => {
    const file = src("routes/_shell.procurement.quotations.tsx");
    expect(file).toContain("dispatch_state");
    expect(file.toLowerCase()).toContain("despatch");
  });
});

describe("department-side receipt confirmation uses the canonical engine", () => {
  it("calls req_confirm_receipt and posts no second inventory movement", () => {
    const file = src("components/common/ConfirmReceiptButton.tsx");
    expect(file).toContain("useConfirmRequisitionReceipt");
    expect(file).not.toContain("inventory_apply_movement");
    expect(file).not.toContain("stock_movements");
  });

  it("is wired into the Housekeeping and Front Office requisition pages", () => {
    for (const route of [
      "routes/_shell.housekeeping.requisitions.tsx",
      "routes/_shell.pms.requisitions.tsx",
    ]) {
      const file = src(route);
      expect(file).toContain("ConfirmReceiptButton");
      // Only issued requisitions can be confirmed, and only with the capability.
      expect(file).toContain("awaitingReceipt(");
      expect(file).toContain("mayConfirm");
    }
  });
});

describe("Finance payables three-way match is navigable", () => {
  it("appears in navigation and stays gated by finance capabilities", () => {
    expect(navPaths()).toContain("/finance/payables");
    expect(capabilitiesForPath("/finance/payables").length).toBeGreaterThan(0);
    expect(src("routes/_shell.finance.payables.tsx")).toContain("FinanceGuard");
  });
});

describe("role gates match responsibility", () => {
  const grants = (...caps: Array<[string, string, string]>) =>
    new Set(caps.map(([m, f, a]) => `${m}.${f}.${a}`));

  const permits = (set: Set<string>, path: string) =>
    pathPermitted(
      (m: string, f: string, a?: string) => set.has(`${m}.${f}.${a ?? "view"}`),
      path,
    );

  it("a store keeper reaches the stock catalogue", () => {
    expect(permits(grants(["stores", "items", "view"]), "/inventory/items")).toBe(true);
  });

  it("a receiving clerk with order visibility does not reach the stock catalogue", () => {
    expect(permits(grants(["procurement", "orders", "view"]), "/inventory/items")).toBe(false);
  });

  it("procurement reaches orders and quotations", () => {
    const set = grants(
      ["procurement", "orders", "view"],
      ["procurement", "quotations", "view"],
    );
    expect(permits(set, "/procurement/orders")).toBe(true);
    expect(permits(set, "/procurement/quotations")).toBe(true);
  });

  it("a bare stores viewer reaches neither orders nor quotations", () => {
    const set = grants(["stores", "overview", "view"]);
    expect(permits(set, "/procurement/orders")).toBe(false);
    expect(permits(set, "/procurement/quotations")).toBe(false);
  });
});
