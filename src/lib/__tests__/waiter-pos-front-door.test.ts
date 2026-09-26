import { describe, expect, it } from "vitest";
import { canFromPermissions, featureKey } from "@/lib/permissions";
import { canAccessPath } from "@/lib/nav-permissions";

/**
 * The Waiter role template grants restaurant features (overview, floor,
 * orders, kds, shifts, wastage). It grants no `pos.access` action, because no
 * template does — `access` is the module front door, not a feature. The POS
 * terminal must therefore open on the same capability the sidebar link uses.
 */
const waiterGrants = new Set<string>(
  [
    ["restaurant", "overview", "view"],
    ["restaurant", "overview", "create"],
    ["restaurant", "overview", "edit"],
    ["restaurant", "floor", "view"],
    ["restaurant", "orders", "view"],
    ["restaurant", "orders", "create"],
    ["restaurant", "orders", "edit"],
    ["restaurant", "kds", "view"],
    ["restaurant", "kds", "create"],
    ["restaurant", "kds", "edit"],
    ["restaurant", "shifts", "view"],
    ["restaurant", "wastage", "view"],
    ["restaurant", "wastage", "create"],
    ["restaurant", "wastage", "edit"],
  ].map(([m, f, a]) => featureKey(m as string, f as string, a as string)),
);

describe("waiter POS front door", () => {
  const can = canFromPermissions(waiterGrants);

  it("holds no literal pos.access grant", () => {
    expect(can("pos", "access")).toBe(false);
  });

  it("still opens the POS terminal, floor, orders and KDS", () => {
    for (const path of ["/pos", "/pos/floor", "/pos/orders", "/pos/kds"]) {
      expect(canAccessPath(can, path), path).toBe(true);
    }
  });

  it("does not open menu management or POS settings", () => {
    expect(canAccessPath(can, "/pos/menu")).toBe(false);
    expect(canAccessPath(can, "/pos/settings")).toBe(false);
  });
});
