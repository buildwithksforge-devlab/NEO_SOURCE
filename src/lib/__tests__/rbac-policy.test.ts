import { describe, expect, it } from "vitest";
import { can, canOpenRoute, decide, DISCOUNT_CEILING, ROLE_POLICIES } from "@/lib/rbac-policy";

describe("capability plus scope, declared once", () => {
  it("keeps a rider on their own availability, deliveries and proof", () => {
    expect(can("rider", "delivery.assignments.edit", "own")).toBe(true);
    expect(can("rider", "delivery.assignments.edit", "property")).toBe(false);
    expect(decide("rider", "delivery.dispatch.assign")).toEqual({ allowed: false, reason: "withheld" });
  });

  it("keeps a maintenance officer on their own jobs and out of inspection", () => {
    expect(can("maintenance_officer", "maintenance.workorders.edit", "own")).toBe(true);
    expect(can("maintenance_officer", "maintenance.workorders.edit", "property")).toBe(false);
    expect(can("maintenance_officer", "maintenance.workorders.inspect")).toBe(false);
  });

  it("keeps a housekeeper on assigned rooms with no inspection authority", () => {
    expect(can("housekeeper", "housekeeping.assignments.edit", "own")).toBe(true);
    expect(can("housekeeper", "housekeeping.inspection.perform")).toBe(false);
  });

  it("lets a store keeper receive, issue and accept returns but never raise a PO or a payable", () => {
    for (const cap of ["stores.receipts.create", "stores.issues.create", "stores.returns.accept"])
      expect(can("store_keeper", cap, "property")).toBe(true);
    expect(can("store_keeper", "procurement.orders.create")).toBe(false);
    expect(can("store_keeper", "finance.ap.create")).toBe(false);
  });

  it("gives procurement PR/PO/supplier authority with read-only payables", () => {
    expect(can("procurement_manager", "procurement.orders.approve", "organisation")).toBe(true);
    expect(can("procurement_manager", "finance.ap.view", "organisation")).toBe(true);
    expect(can("procurement_manager", "finance.ap.create")).toBe(false);
    expect(can("procurement_manager", "finance.payment.approve")).toBe(false);
  });

  it("separates the Accountant's breadth from the Finance Manager's authority", () => {
    expect(can("accountant", "finance.ap.create", "organisation")).toBe(true);
    expect(can("accountant", "finance.reconcile.perform", "organisation")).toBe(true);
    for (const cap of ["finance.payment.approve", "finance.period.close", "finance.coa.manage", "finance.journals.post"])
      expect(can("accountant", cap)).toBe(false);
    for (const cap of ["finance.payment.approve", "finance.period.close", "finance.journals.post"])
      expect(can("finance_manager", cap, "organisation")).toBe(true);
  });

  it("gives Operations Manager property command without finance posting or configuration", () => {
    expect(can("operations_manager", "approvals.inbox.decide", "property")).toBe(true);
    expect(can("operations_manager", "approvals.inbox.decide", "organisation")).toBe(false);
    for (const cap of ["finance.journals.post", "finance.payment.approve", "platform.settings.manage"])
      expect(can("operations_manager", cap)).toBe(false);
    expect(DISCOUNT_CEILING["operations_manager"]).toBe(15);
  });

  it("gives the Owner top authority", () => {
    expect(can("owner", "platform.settings.manage", "organisation")).toBe(true);
    expect(can("owner", "finance.period.close", "organisation")).toBe(true);
  });

  it("refuses an unknown role outright", () => {
    expect(decide("visitor", "finance.ap.view")).toEqual({ allowed: false, reason: "not-granted" });
  });
});

describe("routes derive from the same policy as the buttons", () => {
  it("closes a page whose capability the role does not hold", () => {
    expect(canOpenRoute("rider", "/pms/arrivals")).toBe(false);
    expect(canOpenRoute("housekeeper", "/finance/journals")).toBe(false);
  });

  it("opens a page the role's capability covers", () => {
    expect(canOpenRoute("finance_manager", "/finance/journals")).toBe(true);
  });
});

describe("policy hygiene", () => {
  it("never grants and withholds the same capability", () => {
    for (const [key, policy] of Object.entries(ROLE_POLICIES)) {
      const granted = new Set(policy.grants.map((x) => x.capability));
      for (const w of policy.withheld) expect(granted.has(w), `${key}: ${w}`).toBe(false);
    }
  });
});
