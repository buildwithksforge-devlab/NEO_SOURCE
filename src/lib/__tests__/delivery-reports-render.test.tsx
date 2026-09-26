// @vitest-environment jsdom
/**
 * Delivery Reports actually renders its numbers.
 *
 * The page used to read flat keys (`data.orders`, `data.on_time_rate`,
 * `data.riders` as an array) while `neo_delivery_department_metrics` returns a
 * nested payload — `{ window, volume, service, payments, riders, exceptions }`.
 * Nothing threw, so route-existence tests stayed green while every tile showed
 * a zero and the rider table was permanently empty. This test renders the real
 * route component against the real payload shape, so that regression cannot
 * come back quietly.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const metrics = vi.fn();
const riders = vi.fn();

vi.mock("@/components/delivery/DeliveryGuard", () => ({
  DeliveryGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  QueryState: ({
    isLoading,
    error,
    isEmpty,
    empty,
    children,
  }: {
    isLoading?: boolean;
    error?: unknown;
    isEmpty?: boolean;
    empty?: React.ReactNode;
    children: React.ReactNode;
  }) => {
    if (isLoading) return <div>Loading</div>;
    if (error) return <div>Something went wrong</div>;
    if (isEmpty) return <>{empty}</>;
    return <>{children}</>;
  },
  EmptyState: ({ title, description }: { title: string; description?: string }) => (
    <div>
      <p>{title}</p>
      <p>{description}</p>
    </div>
  ),
}));

vi.mock("@/lib/delivery-department", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/delivery-department")>();
  return {
    ...actual,
    useDeliveryDepartmentMetrics: (...args: unknown[]) => metrics(...args),
    useDeliveryRiderPerformance: (...args: unknown[]) => riders(...args),
  };
});

const { Route } = await import("@/routes/_shell.delivery.reports");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Page = () => <>{(Route.options as any).component()}</>;

const PAYLOAD = {
  window: { from: "2026-08-01", to: "2026-08-27" },
  volume: { total: 42, today: 6, delivered: 37, cancelled: 3, failed: 2 },
  service: { avg_delivery_minutes: 28.4, on_time_rate: 91.2, revenue: 184500 },
  payments: { paid: 30, unpaid: 12, cod_orders: 9, cod_value: 41200 },
  riders: { total: 7, available: 3, on_delivery: 2, offline: 2 },
  exceptions: { open_issues: 1, supply_requests_pending: 2, maintenance_open: 0 },
};

const RIDER_ROWS = [
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

const state = <T,>(data: T, over: Record<string, unknown> = {}) => ({
  data,
  isLoading: false,
  error: null,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("/delivery/reports renders real department metrics", () => {
  it("reads the nested payload instead of flat keys", () => {
    metrics.mockReturnValue(state(PAYLOAD));
    riders.mockReturnValue(state(RIDER_ROWS));

    render(<Page />);

    expect(screen.getByText("Department Reports")).toBeTruthy();
    // volume group
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("6 today")).toBeTruthy();
    // service group — the two values the old flat read always rendered as 0
    expect(screen.getByText("91.2%")).toBeTruthy();
    expect(screen.getByText("28 min")).toBeTruthy();
    // payments + riders + exceptions groups
    expect(screen.getByText(/9 cash order\(s\)/)).toBeTruthy();
    expect(screen.getByText(/3 available · 2 on delivery/)).toBeTruthy();
    expect(screen.queryByText("Awaiting Data")).toBeNull();
  });

  it("renders per-rider performance rows from the rider routine", () => {
    metrics.mockReturnValue(state(PAYLOAD));
    riders.mockReturnValue(state(RIDER_ROWS));

    render(<Page />);

    expect(screen.getByText("Achieng Otieno")).toBeTruthy();
    expect(screen.getByText("92.9%")).toBeTruthy();
    expect(screen.getByText("13")).toBeTruthy();
  });

  it("passes the selected period to both data sources", () => {
    metrics.mockReturnValue(state(PAYLOAD));
    riders.mockReturnValue(state(RIDER_ROWS));

    render(<Page />);

    const [from, to] = metrics.mock.calls[0] as [string, string];
    expect(from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(riders.mock.calls[0]).toEqual([from, to]);
  });

  it("shows the designed empty state when the period has no delivery activity", () => {
    metrics.mockReturnValue(
      state({ volume: { total: 0 }, riders: { total: 0 }, service: {}, payments: {} }),
    );
    riders.mockReturnValue(state([]));

    render(<Page />);

    expect(screen.getByText("Awaiting Data")).toBeTruthy();
  });

  it("never prints a fabricated zero when the routine returns no value", () => {
    metrics.mockReturnValue(
      state({
        volume: { total: 5 },
        service: { on_time_rate: null, avg_delivery_minutes: null },
        payments: {},
        riders: { total: 1 },
        exceptions: {},
      }),
    );
    riders.mockReturnValue(state([]));

    render(<Page />);

    expect(screen.getAllByText("Awaiting data").length).toBeGreaterThan(0);
  });

  it("surfaces a query failure through the designed error state", () => {
    metrics.mockReturnValue(state(undefined, { error: new Error("permission denied") }));
    riders.mockReturnValue(state([]));

    render(<Page />);

    expect(screen.getByText("Something went wrong")).toBeTruthy();
  });
});
