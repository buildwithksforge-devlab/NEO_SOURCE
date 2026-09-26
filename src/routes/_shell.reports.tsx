/**
 * Operational reporting workspace.
 *
 * Every figure here is read from the same canonical scoped fact layer the
 * dashboards, /analytics and /finance read (`neo_facts`, `neo_front_office_facts`
 * and `neo_operational_facts`), so a report can never disagree with the screen
 * it was produced from. No report recomputes a number locally and no figure is
 * fabricated: an unauthorised or empty scope renders the card's real state.
 *
 * The layout is a single board: one scope bar, one provenance and source line,
 * one export control, and a section switcher — rather than six stacked blocks
 * each repeating the same chrome.
 */
import { useMemo, useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  AXIS_PROPS,
  BAR_PROPS,
  ChartGradients,
  GRID_PROPS,
  LINE_PROPS,
  TOOLTIP_PROPS,
  chartFill,
  chartSeriesColor,
} from "@/components/charts/ChartKit";
import { ChartFrame, LoadingRows } from "@/components/analytics/AnalyticsShared";
import { QuietLinkRow } from "@/components/common/SectionTabs";
import { PageHeader } from "@/components/common/DataDisplay";
import { DataSourceStatus } from "@/components/common/DataSourceStatus";
import { FactProvenance } from "@/components/common/FactCard";
import { FactExportButton } from "@/components/common/FactExportButton";
import { FactReconciliation } from "@/components/common/FactSection";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { GitCompareArrows } from "lucide-react";
import {
  AttentionRail,
  BoardNav,
  BoardPanel,
  FactGrid,
  type AttentionRule,
} from "@/components/reports/ReportsBoard";
import { ScopeBar, useAnalyticsScope, useCurrencySymbol } from "@/components/analytics/ScopeBar";
import { useOccupancySeries, useRevenueBreakdown, useRevenueSeries } from "@/lib/analytics-data";
import {
  factCurrency,
  factGeneratedAt,
  factPeriodLabel,
  factTimezone,
  factsAuthorised,
  useFactReconciliation,
  useFacts,
} from "@/lib/facts";

export const Route = createFileRoute("/_shell/reports")({
  head: () => ({
    meta: [
      { title: "Operational Reports — NEØ Hospitality OS" },
      {
        name: "description",
        content:
          "Daily rooms, revenue, restaurant, events, inventory and procurement reporting from the canonical scoped fact layer.",
      },
      { property: "og:title", content: "Operational Reports — NEØ Hospitality OS" },
      {
        property: "og:description",
        content:
          "Scoped daily reporting across rooms, revenue, restaurant, events, inventory and procurement.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type Section = {
  id: string;
  label: string;
  title: string;
  description: string;
  paths: string[];
  lead?: number;
};

const SECTIONS: Section[] = [
  {
    id: "overview",
    label: "Overview",
    title: "Executive overview",
    description:
      "The headline position for the selected scope, with the trends and exceptions behind it.",
    lead: 1,
    paths: [
      "accounting.net_recognised_revenue",
      "rooms.occupancy_rate",
      "rooms.adr",
      "rooms.revpar",
      "collections.total",
      "receivables.total",
      "operational.pos_finalised_sales",
      "events.confirmed_forecast",
    ],
  },
  {
    id: "rooms",
    label: "Rooms",
    title: "Rooms & occupancy",
    description:
      "Room-night performance for the selected period, plus the live front-office room state for the property day.",
    paths: [
      "rooms.occupancy_rate",
      "rooms.occupied_room_nights",
      "rooms.available_room_nights",
      "rooms.adr",
      "rooms.revpar",
      "front_office.arrivals_today",
      "front_office.departures_today",
      "front_office.in_house",
      "front_office.rooms_out_of_order",
    ],
  },
  {
    id: "revenue",
    label: "Revenue",
    title: "Revenue & collections",
    description:
      "Operational revenue streams, recognised accounting revenue and cash collected are separate facts and are never added together.",
    paths: [
      "operational.room_folio_revenue",
      "operational.pos_finalised_sales",
      "operational.delivery_sales",
      "operational.other_folio_revenue",
      "accounting.net_recognised_revenue",
      "collections.total",
      "receivables.total",
      "receivables.invoices_overdue",
    ],
  },
  {
    id: "profitability",
    label: "Profit & cost",
    title: "Profitability, payroll & stock turnover",
    description:
      "Posted revenue against posted cost of sales, payroll and operating expenses, with how fast stock is being used. Only posted entries and approved payroll count — unposted activity never appears here.",
    paths: [
      "accounting.posted_revenue",
      "accounting.cost_of_sales",
      "accounting.gross_profit",
      "accounting.gross_margin",
      "accounting.payroll_cost",
      "accounting.operating_expenses",
      "accounting.net_profit",
      "accounting.net_margin",
      "inventory.closing_valuation",
      "inventory.cost_of_issues",
      "inventory.stock_turnover",
      "inventory.days_on_hand",
    ],
  },
  {
    id: "restaurant",
    label: "Restaurant & kitchen",
    title: "Restaurant & kitchen",
    description: "Point-of-sale trading and kitchen throughput for the property day.",
    paths: [
      "ops.restaurant.sales_today",
      "ops.restaurant.open_bills",
      "ops.restaurant.open_value",
      "ops.restaurant.avg_service_minutes",
      "ops.kitchen.items_preparing",
      "ops.kitchen.delayed_items",
      "ops.kitchen.avg_prep_minutes",
      "ops.finance.payments_today",
    ],
  },
  {
    id: "events",
    label: "Events",
    title: "Events",
    description: "Event pipeline, confirmed business and money still to collect.",
    paths: [
      "ops.events.open_enquiries",
      "ops.events.quotations_sent",
      "ops.events.confirmed",
      "ops.events.upcoming",
      "events.confirmed_forecast",
      "events.invoiced",
      "ops.events.deposits_received",
      "ops.events.outstanding_balance",
    ],
  },
  {
    id: "inventory",
    label: "Inventory & procurement",
    title: "Inventory & procurement",
    description: "Stock position and the purchasing pipeline feeding it.",
    paths: [
      "ops.inventory.valuation",
      "ops.inventory.low_stock",
      "ops.inventory.negative_stock",
      "ops.inventory.goods_received_today",
      "ops.procurement.open_requests",
      "ops.procurement.awaiting_approval",
      "ops.procurement.open_orders",
      "ops.procurement.awaiting_receipt",
    ],
  },
  {
    id: "service",
    label: "Service & workforce",
    title: "Service delivery & workforce",
    description: "Housekeeping, maintenance, laundry, delivery and workforce readiness.",
    paths: [
      "ops.housekeeping.dirty_rooms",
      "ops.housekeeping.awaiting_inspection",
      "ops.maintenance.open_work_orders",
      "ops.maintenance.rooms_blocked",
      "ops.laundry.open_orders",
      "ops.delivery.delivered_today",
      "ops.hr.present_today",
      "ops.hr.open_leave_requests",
    ],
  },
  {
    id: "reconciliation",
    label: "Reconciliation",
    title: "Operational to finance reconciliation",
    description:
      "What operations recorded, what finance posted, and every eligible record that did not reach the ledger.",
    paths: [],
  },
];

const ATTENTION_RULES: AttentionRule[] = [
  {
    path: "receivables.invoices_overdue",
    when: (v) => v > 0,
    severity: "destructive",
    message: (f) => `${f} is past its due date and needs collection action.`,
  },
  {
    path: "ops.inventory.negative_stock",
    when: (v) => v > 0,
    severity: "destructive",
    message: (f) => `${f} item(s) hold a negative balance — a counting or posting fault.`,
  },
  {
    path: "ops.kitchen.delayed_items",
    when: (v) => v > 0,
    severity: "warning",
    message: (f) => `${f} ticket item(s) are past their expected preparation time.`,
  },
  {
    path: "ops.procurement.awaiting_approval",
    when: (v) => v > 0,
    severity: "warning",
    message: (f) => `${f} purchase request(s) are waiting on a decision.`,
  },
  {
    path: "ops.inventory.low_stock",
    when: (v) => v > 0,
    severity: "warning",
    message: (f) => `${f} item(s) have fallen to or below their reorder level.`,
  },
  {
    path: "ops.maintenance.rooms_blocked",
    when: (v) => v > 0,
    severity: "warning",
    message: (f) => `${f} room(s) are out of inventory for maintenance.`,
  },
  {
    path: "ops.restaurant.open_bills",
    when: (v) => v > 0,
    severity: "info",
    message: (f) => `${f} bill(s) are still open and unsettled.`,
  },
  {
    path: "ops.housekeeping.awaiting_inspection",
    when: (v) => v > 0,
    severity: "info",
    message: (f) => `${f} room(s) are cleaned but still awaiting inspection.`,
  },
];

const DEEP_LINKS: { label: string; to: string }[] = [
  { label: "Executive analytics", to: "/analytics" },
  { label: "Finance ledger", to: "/finance/ledger" },
  { label: "Point-of-sale reports", to: "/pos/reports" },
  { label: "Housekeeping reports", to: "/housekeeping/reports" },
  { label: "Kitchen reports", to: "/kitchen/reports" },
  { label: "Event reports", to: "/events/reports" },
  { label: "Marketing reports", to: "/marketing/reports" },
];

/** The equivalent period immediately before the selected one. */
function previousPeriod(from: string, to: string): { from: string; to: string } | null {
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const span = end - start + 86_400_000;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(start - span), to: iso(start - 86_400_000) };
}

function ReportsPage() {
  const { scope, setScope } = useAnalyticsScope();
  const [activeId, setActiveId] = useState<string>("overview");
  const [compare, setCompare] = useState(true);
  const symbol = useCurrencySymbol();

  const factScope = useMemo(
    () => ({ branchId: scope.branchId, from: scope.from, to: scope.to }),
    [scope.branchId, scope.from, scope.to],
  );
  const previousScope = useMemo(() => {
    const window = previousPeriod(scope.from, scope.to);
    return window ? { branchId: scope.branchId, from: window.from, to: window.to } : null;
  }, [scope.branchId, scope.from, scope.to]);
  const scopeLabel = scope.branchId ? "Selected property" : "All authorised properties";

  const facts = useFacts(factScope);
  const priorFacts = useFacts(
    previousScope ?? factScope,
    compare && previousScope !== null,
  );
  const reconciliation = useFactReconciliation(factScope);
  const currency = factCurrency(facts.data);
  const authorised = !facts.domains.period.isSuccess || factsAuthorised(facts.data);

  const section = SECTIONS.find((s) => s.id === activeId) ?? SECTIONS[0]!;
  const isOverview = section.id === "overview";
  const isReconciliation = section.id === "reconciliation";

  const revenueSeries = useRevenueSeries(scope, isOverview || section.id === "revenue");
  const occupancySeries = useOccupancySeries(scope, isOverview || section.id === "rooms");
  const breakdown = useRevenueBreakdown("department", scope, isOverview);
  const propertyBreakdown = useRevenueBreakdown(
    "branch",
    scope,
    isOverview && scope.branchId === null,
  );

  const revenueData = (revenueSeries.data ?? []).map((row) => ({
    day: String(row["day"]).slice(5),
    rooms: Number(row["rooms"] ?? 0),
    fnb: Number(row["fnb"] ?? 0),
    delivery: Number(row["delivery"] ?? 0),
    events: Number(row["events"] ?? 0),
  }));
  const occupancyData = (occupancySeries.data ?? []).map((row) => ({
    day: String(row["day"]).slice(5),
    occupancy: Number(row["occupancy"] ?? 0),
  }));
  const mixData = (breakdown.data ?? []).map((row) => ({
    label: String(row["label"] ?? "—"),
    amount: Number(row["amount"] ?? 0),
  }));
  const league = (propertyBreakdown.data ?? [])
    .map((row) => ({ label: String(row["label"] ?? "—"), amount: Number(row["amount"] ?? 0) }))
    .sort((a, b) => b.amount - a.amount);
  const leagueTop = league[0]?.amount ?? 0;
  const money = (value: number) =>
    `${symbol || currency} ${new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 }).format(value)}`;

  const period = `${scope.from} → ${scope.to}`;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Management"
        title="Operational Reports"
        description="One scoped board across rooms, revenue, restaurant, events, inventory, service and the finance reconciliation behind them. Each section exports exactly the figures shown."
      />

      <ScopeBar scope={scope} onChange={setScope} />

      {/* One provenance, source and export header for the whole board. */}
      <Card className="surface-panel">
        <CardContent className="neo-card-pad space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">{section.title}</h2>
              <p className="text-sm text-muted-foreground">{section.description}</p>
              <FactProvenance
                scopeLabel={scopeLabel}
                period={factPeriodLabel(facts.data)}
                timezone={factTimezone(facts.data)}
                currency={currency}
                generatedAt={factGeneratedAt(facts.data)}
              />
            </div>
            <div data-action-cluster className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={compare ? "default" : "outline"}
                aria-pressed={compare}
                disabled={previousScope === null}
                onClick={() => setCompare((value) => !value)}
              >
                <GitCompareArrows className="mr-2 size-4" aria-hidden="true" />
                {compare ? "Comparing previous period" : "Compare previous period"}
              </Button>
              <FactExportButton
                scope={factScope}
                scopeLabel={scopeLabel}
                {...(section.paths.length ? { paths: section.paths } : {})}
                title={section.title}
              />
            </div>
          </div>

          <DataSourceStatus
            scope={factScope}
            query={facts}
            facts={facts}
            reconciliation={reconciliation}
          />

          <BoardNav sections={SECTIONS} active={section.id} onSelect={setActiveId} />
        </CardContent>
      </Card>

      {!facts.domains.period.isLoading && !authorised ? (
        <Card className="surface-panel">
          <CardContent className="py-6 text-sm text-muted-foreground">
            Your account is not authorised to see these figures. Ask an administrator for the
            relevant finance, analytics or reporting permission.
          </CardContent>
        </Card>
      ) : isReconciliation ? (
        <Card className="surface-panel">
          <CardContent className="neo-card-pad">
            <FactReconciliation scope={factScope} />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-5">
          {compare && previousScope ? (
            <p className="text-xs text-muted-foreground">
              Movement is measured against {previousScope.from} → {previousScope.to}, the
              equivalent period immediately before this one.
            </p>
          ) : null}

          <FactGrid
            paths={section.paths}
            facts={facts}
            {...(compare && previousScope ? { previous: priorFacts } : {})}
            scope={factScope}
            lead={section.lead ?? 0}
          />

          {isOverview ? (
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <ChartFrame
                  title="Revenue by stream"
                  unit={`Amount in ${symbol || currency || "local currency"}`}
                  period={period}
                  source="Folio lines, point-of-sale orders, delivery orders and event billing"
                  empty={!revenueData.some((d) => d.rooms || d.fnb || d.delivery || d.events)}
                >
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart data={revenueData}>
                      <ChartGradients idPrefix="rep" />
                      <CartesianGrid {...GRID_PROPS} />
                      <XAxis dataKey="day" {...AXIS_PROPS} />
                      <YAxis {...AXIS_PROPS} width={70} />
                      <Tooltip {...TOOLTIP_PROPS} />
                      {(
                        [
                          ["rooms", "Rooms"],
                          ["fnb", "Food & beverage"],
                          ["delivery", "Delivery"],
                          ["events", "Events"],
                        ] as const
                      ).map(([key, name], index) => (
                        <Area
                          key={key}
                          {...LINE_PROPS}
                          dataKey={key}
                          name={name}
                          stackId="1"
                          stroke={chartSeriesColor(index)}
                          fill={chartFill(index, "rep")}
                        />
                      ))}
                    </AreaChart>
                  </ResponsiveContainer>
                </ChartFrame>
              </div>

              <BoardPanel
                title="Needs attention"
                description="Raised only where a canonical fact crosses a reporting rule."
              >
                {facts.isLoading ? (
                  <LoadingRows rows={3} />
                ) : (
                  <AttentionRail rules={ATTENTION_RULES} facts={facts} />
                )}
              </BoardPanel>

              <div className="lg:col-span-2">
                <ChartFrame
                  title="Revenue mix by department"
                  unit={`Amount in ${symbol || currency || "local currency"}`}
                  period={period}
                  source="bi_revenue_breakdown"
                  empty={mixData.length === 0}
                >
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={mixData} layout="vertical" margin={{ left: 12 }}>
                      <CartesianGrid {...GRID_PROPS} horizontal={false} />
                      <XAxis type="number" {...AXIS_PROPS} />
                      <YAxis type="category" dataKey="label" {...AXIS_PROPS} width={130} />
                      <Tooltip {...TOOLTIP_PROPS} />
                      <Bar
                        dataKey="amount"
                        name="Revenue"
                        fill={chartSeriesColor(0)}
                        {...BAR_PROPS}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartFrame>
              </div>

              <ChartFrame
                title="Occupancy trend"
                unit="Occupancy %"
                period={period}
                source="bi_occupancy_series"
                empty={occupancyData.length === 0}
              >
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={occupancyData}>
                    <CartesianGrid {...GRID_PROPS} />
                    <XAxis dataKey="day" {...AXIS_PROPS} />
                    <YAxis {...AXIS_PROPS} width={48} />
                    <Tooltip {...TOOLTIP_PROPS} />
                    <Line
                      {...LINE_PROPS}
                      dataKey="occupancy"
                      name="Occupancy"
                      stroke={chartSeriesColor(1)}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </ChartFrame>

              {scope.branchId === null ? (
                <div className="lg:col-span-3">
                  <BoardPanel
                    title="Property league"
                    description="Recognised revenue per property for this period, ranked. Shown only for the properties you are permitted to see."
                  >
                    {propertyBreakdown.isLoading ? (
                      <LoadingRows rows={3} />
                    ) : league.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No revenue was recorded against any permitted property in this period.
                      </p>
                    ) : (
                      <ul className="space-y-2">
                        {league.map((row, index) => (
                          <li key={row.label} className="min-w-0">
                            <div className="flex items-baseline justify-between gap-3 text-sm">
                              <span className="truncate">
                                <span className="mr-2 text-xs text-muted-foreground">
                                  {index + 1}
                                </span>
                                {row.label}
                              </span>
                              <span className="neo-atomic font-semibold">{money(row.amount)}</span>
                            </div>
                            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-primary"
                                style={{
                                  width: `${leagueTop > 0 ? Math.max(2, (row.amount / leagueTop) * 100) : 0}%`,
                                }}
                              />
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </BoardPanel>
                </div>
              ) : null}
            </div>
          ) : null}

          {section.id === "revenue" ? (
            <ChartFrame
              title="Revenue by stream"
              unit={`Amount in ${symbol || currency || "local currency"}`}
              period={period}
              source="Folio lines, point-of-sale orders, delivery orders and event billing"
              empty={!revenueData.some((d) => d.rooms || d.fnb || d.delivery || d.events)}
            >
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={revenueData}>
                  <ChartGradients idPrefix="repr" />
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis dataKey="day" {...AXIS_PROPS} />
                  <YAxis {...AXIS_PROPS} width={70} />
                  <Tooltip {...TOOLTIP_PROPS} />
                  {(
                    [
                      ["rooms", "Rooms"],
                      ["fnb", "Food & beverage"],
                      ["delivery", "Delivery"],
                      ["events", "Events"],
                    ] as const
                  ).map(([key, name], index) => (
                    <Area
                      key={key}
                      {...LINE_PROPS}
                      dataKey={key}
                      name={name}
                      stackId="1"
                      stroke={chartSeriesColor(index)}
                      fill={chartFill(index, "repr")}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </ChartFrame>
          ) : null}

          {section.id === "rooms" ? (
            <ChartFrame
              title="Occupancy trend"
              unit="Occupancy %"
              period={period}
              source="bi_occupancy_series"
              empty={occupancyData.length === 0}
            >
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={occupancyData}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis dataKey="day" {...AXIS_PROPS} />
                  <YAxis {...AXIS_PROPS} width={48} />
                  <Tooltip {...TOOLTIP_PROPS} />
                  <Line
                    {...LINE_PROPS}
                    dataKey="occupancy"
                    name="Occupancy"
                    stroke={chartSeriesColor(1)}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </ChartFrame>
          ) : null}
        </div>
      )}

      <QuietLinkRow
        label="Detailed module reports"
        links={DEEP_LINKS}
        className="border-t border-outline-subtle pt-4"
      />
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/reports">
      <ReportsPage />
    </OpsGuard>
  );
}
