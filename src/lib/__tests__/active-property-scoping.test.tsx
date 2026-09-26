// @vitest-environment jsdom
/**
 * Active-property scoping regression suite.
 *
 * The topbar property selector must narrow every property-owned read, not just
 * the selector options. These tests pin three things:
 *  1. the scoping registry covers every operational domain and excludes
 *     organisation master data;
 *  2. `applyTo` emits the right PostgREST filter per table class, and switching
 *     Nairobi -> Mombasa -> Taveta changes both the filter and the cache key;
 *  3. every property-dependent module keeps consuming the contract, so a future
 *     query cannot silently go organisation-wide again.
 */
import { readFileSync } from "node:fs";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  BRANCH_OR_GLOBAL_TABLES,
  BRANCH_SCOPED_TABLES,
  PARENT_SCOPED_TABLES,
  isPropertyOwnedTable,
  useActivePropertyFilter,
} from "@/lib/branch-filter";

const NAIROBI = "11111111-1111-1111-1111-111111111111";
const MOMBASA = "22222222-2222-2222-2222-222222222222";
const TAVETA = "33333333-3333-3333-3333-333333333333";

let scope: { activeBranchId: string | null; orgWide: boolean } = {
  activeBranchId: "all",
  orgWide: true,
};

vi.mock("@/lib/branches", () => ({
  useBranchScope: () => scope,
}));

/** Minimal PostgREST builder recorder. */
function builder() {
  const calls: string[] = [];
  const api = {
    calls,
    eq(column: string, value: string) {
      calls.push(`eq:${column}=${value}`);
      return api;
    },
    or(filter: string) {
      calls.push(`or:${filter}`);
      return api;
    },
  };
  return api;
}

function filterFor(branch: string | null, table: string) {
  scope = { activeBranchId: branch, orgWide: branch === null || branch === "all" };
  const { result } = renderHook(() => useActivePropertyFilter());
  const q = builder();
  result.current.applyTo(q, table);
  return { calls: q.calls, filterKey: result.current.filterKey, branchId: result.current.branchId };
}

describe("scoping registry", () => {
  it("covers every property-owned operational domain", () => {
    const required = [
      "reservations", "rooms", "folios", "guest_requests", "stays",
      "housekeeping_jobs", "maintenance_work_orders", "assets",
      "pos_orders", "pos_shifts", "restaurant_tables", "station_tickets",
      "stock_movements", "stock_locations", "internal_requisitions",
      "purchase_requests", "purchase_orders", "goods_receipts",
      "journal_entries", "invoices", "payments", "cash_drawers",
      "event_bookings", "event_quotations", "banquet_event_orders",
      "delivery_orders", "rider_shifts", "delivery_issues",
      "employees", "attendance_records", "leave_requests",
      "tasks", "audit_logs",
      "customer_feedback", "loyalty_transactions",
    ];
    for (const table of required) expect(BRANCH_SCOPED_TABLES.has(table), table).toBe(true);
  });

  it("keeps mixed org/property tables on the or-null rule", () => {
    for (const table of ["profiles", "room_types", "rate_plans", "approval_requests", "pos_settings", "notifications"])
      expect(BRANCH_OR_GLOBAL_TABLES.has(table), table).toBe(true);
  });

  it("never branch-filters organisation master data", () => {
    for (const table of [
      "role_catalogue",
      "permissions",
      "role_permissions",
      "organization_settings",
      "chart_of_accounts",
      "branches",
      "organizations",
    ])
      expect(isPropertyOwnedTable(table), table).toBe(false);
  });

  it("scopes parentless child tables through their canonical parent", () => {
    for (const [child, rel] of Object.entries(PARENT_SCOPED_TABLES)) {
      expect(isPropertyOwnedTable(child), child).toBe(false);
      expect(isPropertyOwnedTable(rel.parent), rel.parent).toBe(true);
    }
  });
});

describe("applyTo", () => {
  it("adds no filter in All Properties mode", () => {
    const { calls, filterKey, branchId } = filterFor("all", "reservations");
    expect(calls).toEqual([]);
    expect(filterKey).toBe("all");
    expect(branchId).toBeNull();
  });

  it("narrows a strictly property-owned table with equality", () => {
    expect(filterFor(NAIROBI, "reservations").calls).toEqual([`eq:branch_id=${NAIROBI}`]);
  });

  it("keeps organisation-wide rows for mixed tables", () => {
    expect(filterFor(NAIROBI, "profiles").calls).toEqual([
      `or:branch_id.eq.${NAIROBI},branch_id.is.null`,
    ]);
  });

  it("keeps organisation-wide notifications in the selected property's bell count", () => {
    expect(filterFor(NAIROBI, "notifications").calls).toEqual([
      `or:branch_id.eq.${NAIROBI},branch_id.is.null`,
    ]);
  });

  it("leaves organisation master data untouched", () => {
    expect(filterFor(NAIROBI, "role_catalogue").calls).toEqual([]);
  });

  it("switching property changes both the filter and the cache key", () => {
    const seen = [
      filterFor("all", "pos_orders"),
      filterFor(NAIROBI, "pos_orders"),
      filterFor(MOMBASA, "pos_orders"),
      filterFor(TAVETA, "pos_orders"),
    ];
    const keys = seen.map((s) => s.filterKey);
    expect(new Set(keys).size).toBe(4);
    expect(keys).toEqual(["all", NAIROBI, MOMBASA, TAVETA]);
    expect(seen[1]!.calls).not.toEqual(seen[2]!.calls);
    expect(seen[2]!.calls).not.toEqual(seen[3]!.calls);
  });
});

describe("module adoption", () => {
  const MODULES = [
    "src/lib/pms-data.ts",
    "src/lib/frontdesk-ops.ts",
    "src/lib/operations-data.ts",
    "src/lib/hr-data.ts",
    "src/lib/crm.ts",
    "src/lib/marketing-data.ts",
    "src/lib/delivery-data.ts",
    "src/lib/pos-data.ts",
    "src/lib/kitchen-data.ts",
    "src/lib/procurement-data.ts",
    "src/lib/inventory-data.ts",
    "src/lib/finance-data.ts",
    "src/lib/automation.ts",
    "src/lib/packages-data.ts",
    "src/routes/_shell.users.tsx",
    "src/routes/_shell.tasks.tsx",
    "src/routes/_shell.notifications.tsx",
    "src/routes/_shell.approvals.tsx",
  ];

  // `useDataScope` is the stricter form of the same contract: it applies the
  // active property first and then narrows to department or own work.
  it.each(MODULES)("%s consumes the active-property contract", (file) => {
    const src = readFileSync(file, "utf8");
    expect(/useActivePropertyFilter|useDataScope/.test(src)).toBe(true);
  });

  it.each(MODULES)("%s keys its property-dependent queries on the active property", (file) => {
    const src = readFileSync(file, "utf8");
    const keys = [...src.matchAll(/(?:queryKey:|tenantQuery\()\s*\[([^\]]*)\]/g)].map((m) => m[1]!);
    const scoped = keys.filter((k) => /filterKey|branchId|scope\.branchId|scopeKey/.test(k));
    expect(scoped.length).toBeGreaterThan(0);
  });

});
