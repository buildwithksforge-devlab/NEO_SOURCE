// @vitest-environment jsdom
/**
 * /delivery/reports — real query wiring, not route existence.
 *
 * Root cause history: the page read FLAT keys (`data.orders`, `data.on_time_rate`,
 * `data.riders` as an array) while `neo_delivery_department_metrics` returns a
 * NESTED payload `{ window, volume, service, payments, riders, exceptions }`,
 * and there was no rider-ledger query at all. Nothing threw, so route-existence
 * tests stayed green while every tile rendered a zero.
 *
 * This test exercises the real hooks (`useDeliveryDepartmentMetrics`,
 * `useDeliveryRiderPerformance`) against a mocked transport, so it fails if the
 * RPC names, argument names, or payload shape drift again.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

type Call = { name: string; args: Record<string, unknown> };
const calls: Call[] = [];
let metricsResult: { data: unknown; error: unknown } = { data: null, error: null };
let riderResult: { data: unknown; error: unknown } = { data: null, error: null };

const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
  calls.push({ name, args });
  return name === "neo_delivery_rider_performance" ? riderResult : metricsResult;
});

vi.mock("@/integrations/supabase/client", () => ({
  // The RPC guard refuses authenticated routines without a session, so the
  // mock has to present one exactly as the real client would.
  supabase: {
    rpc,
    from: () => ({}),
    auth: { getSession: async () => ({ data: { session: { access_token: "test-token" } } }) },
  },
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    organizationId: "org-1",
    profile: { branch_id: null },
    can: () => true,
    loading: false,
  }),
}));

vi.mock("@/lib/branch-filter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/branch-filter")>()),
  useActivePropertyFilter: () => ({
    branchId: "branch-1",
    orgWide: false,
    applyTo: <T,>(q: T) => q,
    filterKey: "branch-1",
  }),
}));

const { Route } = await import("@/routes/_shell.delivery.reports");
const { isPermissionError } = await import("@/routes/_shell.delivery.reports");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Page = () => (Route.options as any).component() as ReactNode;

const NESTED = {
  window: { from: "2026-08-01", to: "2026-08-27" },
  volume: { total: 42, today: 6, delivered: 37, cancelled: 3, failed: 2, unassigned: 1 },
  service: { avg_delivery_minutes: 28.4, on_time_rate: 91.2, revenue: 184500 },
  payments: { paid: 30, unpaid: 12, cod_orders: 9, cod_value: 41200 },
  riders: { total: 7, available: 3, on_delivery: 2, offline: 2 },
  exceptions: { open_issues: 1, supply_requests_pending: 2, maintenance_open: 0 },
};

const RIDERS = [
  {
    rider_id: "r1",
    rider_code: "RID-001",
    display_name: "Achieng Otieno",
    assigned: 14,
    delivered: 13,
    on_time_rate: 92.9,
    avg_delivery_minutes: 26.2,
    cash_collected: 18400,
  },
];

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Page />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls.length = 0;
  metricsResult = { data: NESTED, error: null };
  riderResult = { data: RIDERS, error: null };
});
afterEach(cleanup);

describe("delivery reports query wiring", () => {
  it("calls both department RPCs with the argument names the database declares", async () => {
    mount();
    await waitFor(() => expect(calls.length).toBe(2));

    const metrics = calls.find((c) => c.name === "neo_delivery_department_metrics");
    const riders = calls.find((c) => c.name === "neo_delivery_rider_performance");
    expect(metrics).toBeTruthy();
    expect(riders).toBeTruthy();
    for (const call of [metrics!, riders!]) {
      expect(Object.keys(call.args).sort()).toEqual(["_branch", "_from", "_to"]);
      // The active property is passed through as a uuid, never the "all" sentinel.
      expect(call.args["_branch"]).toBe("branch-1");
      expect(String(call.args["_from"])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(String(call.args["_to"])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("renders real values out of the NESTED payload — the original defect", async () => {
    mount();
    // volume.total / volume.delivered — previously read as data.orders (undefined -> 0)
    expect(await screen.findByText("42")).toBeTruthy();
    expect(screen.getByText("37")).toBeTruthy();
    // service.on_time_rate + service.avg_delivery_minutes
    expect(screen.getByText("91.2%")).toBeTruthy();
    expect(screen.getByText("28 min")).toBeTruthy();
    // riders.total, exceptions.open_issues
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    // No tile silently collapsed to a zero.
    expect(screen.queryAllByText("0").length).toBe(0);
  });

  it("renders the rider ledger rows from the second RPC", async () => {
    mount();
    expect(await screen.findByText("Achieng Otieno")).toBeTruthy();
    expect(screen.getByText("14")).toBeTruthy();
    expect(screen.getByText("92.9%")).toBeTruthy();
  });

  it("shows a designed empty state, not zeros, when the period has no activity", async () => {
    metricsResult = {
      data: { volume: { total: 0 }, service: {}, payments: {}, riders: { total: 0 }, exceptions: {} },
      error: null,
    };
    riderResult = { data: [], error: null };
    mount();
    expect(await screen.findByText("Awaiting Data")).toBeTruthy();
  });

  it("surfaces a failing metrics query as an error state rather than fake numbers", async () => {
    metricsResult = { data: null, error: { message: "boom" } };
    mount();
    await waitFor(() => expect(screen.queryByText("42")).toBeNull());
    expect(calls.some((c) => c.name === "neo_delivery_department_metrics")).toBe(true);
  });

  it("keeps the report usable when only the rider ledger is out of scope", async () => {
    // neo_delivery_rider_performance gates on dispatch/rider access, which is
    // narrower than delivery.reports.view — a reports-only viewer gets 42501
    // from that one query and must still see the department totals.
    riderResult = { data: null, error: { message: "insufficient_privilege" } };
    mount();
    expect(await screen.findByText("42")).toBeTruthy();
    expect(screen.getByText("Rider detail not available")).toBeTruthy();
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });
});

describe("permission-error classification", () => {
  it("recognises the database refusals PostgREST can return", () => {
    for (const message of [
      "insufficient_privilege",
      "permission denied for function neo_delivery_rider_performance",
      "You are not permitted to view delivery performance",
      "42501",
    ]) {
      expect(isPermissionError(new Error(message))).toBe(true);
    }
  });

  it("does not swallow ordinary failures", () => {
    expect(isPermissionError(new Error("network error"))).toBe(false);
    expect(isPermissionError(null)).toBe(false);
    expect(isPermissionError(undefined)).toBe(false);
  });
});
