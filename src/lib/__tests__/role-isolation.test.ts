import { describe, expect, it } from "vitest";
import { ALIAS_FEATURES, canFromPermissions, canonicalPermission } from "@/lib/permissions";

/**
 * Role isolation regression guards. These lock the canonicalisation rules that
 * stopped coarse module grants from satisfying sensitive feature checks.
 */
describe("role isolation — canonical permission resolution", () => {
  it("resolves sub-module aliases to their own feature, never a module wildcard", () => {
    expect(ALIAS_FEATURES["finance-gl"]).toBe("gl");
    expect(ALIAS_FEATURES["crm-customers"]).toBe("customers");
    expect(canonicalPermission("finance-gl", "view").feature).toBe("gl");
    expect(canonicalPermission("crm-customers", "view").feature).toBe("customers");
  });

  it("does not let a generic view grant imply money, cost or whole-department reads", () => {
    const can = canFromPermissions(new Set(["delivery.orders.view"]));
    expect(can("delivery", "orders", "view")).toBe(true);
    expect(can("delivery", "orders", "financials")).toBe(false);
    expect(can("delivery", "payments", "revenue")).toBe(false);
    expect(can("stores", "stock", "cost")).toBe(false);
  });

  it("does not let an own-records grant imply everyone else's records", () => {
    const rider = canFromPermissions(new Set(["delivery.orders.view-own"]));
    expect(rider("delivery", "orders", "view-own")).toBe(true);
    expect(rider("delivery", "orders", "view")).toBe(false);
    expect(rider("delivery", "dispatch", "assign")).toBe(false);
  });

  it("keeps a departmental grant out of unrelated modules", () => {
    const chef = canFromPermissions(new Set(["kitchen.queue.view", "kitchen.item.prepare"]));
    expect(chef("kitchen", "queue", "view")).toBe(true);
    expect(chef("finance-gl", "*", "view")).toBe(false);
    expect(chef("hr-employees", "*", "directory.view")).toBe(false);
    expect(chef("front-office", "folios", "view")).toBe(false);
  });

  it("keeps a waiter out of restricted approvals and guest financial history", () => {
    const waiter = canFromPermissions(new Set(["restaurant.orders.create", "kitchen.queue.view"]));
    expect(waiter("restaurant", "orders", "create")).toBe(true);
    expect(waiter("restaurant", "orders", "void")).toBe(false);
    expect(waiter("restaurant", "orders", "discount")).toBe(false);
    expect(waiter("front-office", "folios", "view")).toBe(false);
    expect(waiter("hr-employees", "*", "directory.view")).toBe(false);
  });
});
