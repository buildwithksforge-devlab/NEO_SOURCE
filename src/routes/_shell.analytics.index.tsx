import { useMemo } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { useBranchScope } from "@/lib/branches";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AXIS_PROPS,
  ChartGradients,
  GRID_PROPS,
  LINE_PROPS,
  TOOLTIP_PROPS,
  chartFill,
  chartSeriesColor,
} from "@/components/charts/ChartKit";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatusPill } from "@/components/common/DataDisplay";
import {
  AiDisclosure,
  ChartFrame,
  ClassificationBadge,
  ErrorState,
  LoadingRows,
  MetricCard,
} from "@/components/analytics/AnalyticsShared";
import { ScopeBar, useAnalyticsScope, useCurrencySymbol } from "@/components/analytics/ScopeBar";
import { FactHandoff } from "@/components/analytics/FactHandoff";
import { ReconciliationStatusPanel } from "@/components/finance/ReconciliationStatus";
import { RevenueVariancePanel } from "@/components/finance/RevenueVariance";
import { FactSection, SHARED_FACT_PATHS } from "@/components/common/FactSection";

import { buildAdvisories, metricValue, metricsForSection } from "@/lib/analytics";
import {
  useCaptureAdvisory,
  useComparisonKpis,
  useKpis,
  useRevenueSeries,
  useRiskScan,
} from "@/lib/analytics-data";

export const Route = createFileRoute("/_shell/analytics/")({
  head: () => ({
    meta: [
      { title: "Executive Analytics — HOS Hospitality Platform" },
      {
        name: "description",
        content:
          "Executive KPI overview with verified occupancy, revenue, cost and service metrics plus labelled AI advisories.",
      },
      { property: "og:title", content: "Executive Analytics — HOS Hospitality Platform" },
      {
        property: "og:description",
        content:
          "Verified executive KPIs, revenue trends and labelled AI advisories for hospitality leadership.",
      },
    ],
  }),
  component: GuardedPage,
});

/** Profit, payroll and stock-turnover facts, from the same canonical layer. */
const PROFITABILITY_FACT_PATHS = [
  "accounting.posted_revenue",
  "accounting.cost_of_sales",
  "accounting.gross_profit",
  "accounting.gross_margin",
  "accounting.payroll_cost",
  "accounting.operating_expenses",
  "accounting.net_profit",
  "inventory.closing_valuation",
  "inventory.cost_of_issues",
  "inventory.stock_turnover",
  "inventory.days_on_hand",
];

function ExecutiveAnalytics() {
  // The global header is the single source of property context. Analytics
  // inherits it rather than demanding the property be chosen a second time.
  const branchScope = useBranchScope();
  const globalBranchId = branchScope.activeBranchId === "all" ? null : branchScope.activeBranchId;
  const { scope: dateScope, setScope: setDateScope } = useAnalyticsScope();
  const scope = useMemo(
    () => ({ ...dateScope, branchId: globalBranchId }),
    [dateScope, globalBranchId],
  );
  const setScope = (s: typeof scope) => setDateScope({ ...s, branchId: globalBranchId });
  const propertyLabel =
    branchScope.activeBranch?.name ??
    (globalBranchId ? "Selected property" : "All permitted properties");
  const symbol = useCurrencySymbol();
  const kpis = useKpis(scope);
  const previous = useComparisonKpis(scope);
  const series = useRevenueSeries(scope);
  const risk = useRiskScan(scope);
  const capture = useCaptureAdvisory();

  const metrics = metricsForSection("executive");
  const advisories = buildAdvisories(kpis.data, risk.data, symbol);
  const generatedAt = (kpis.data?.["generated_at"] as string | undefined) ?? null;

  const chartData = (series.data ?? []).map((r) => ({
    day: String(r["day"]).slice(5),
    rooms: Number(r["rooms"] ?? 0),
    fnb: Number(r["fnb"] ?? 0),
    delivery: Number(r["delivery"] ?? 0),
  }));

  if (kpis.isError) return <ErrorState error={kpis.error} onRetry={() => void kpis.refetch()} />;

  return (
    <div>
      <ScopeBar scope={scope} onChange={setScope} lockedPropertyLabel={propertyLabel} />

      <div className="mb-6 space-y-6">
        <FactSection
          title="Canonical facts"
          description="The same scoped fact layer the dashboards and Finance read. Operational sales, forecast, collections and posted accounting revenue are separate facts and are never added together."
          paths={SHARED_FACT_PATHS}
          scope={{ branchId: scope.branchId, from: scope.from, to: scope.to }}
          scopeLabel={scope.branchId ? "Selected property" : "All authorised properties"}
        />
        <FactSection
          title="Profit, payroll & stock turnover"
          description="Posted accounting revenue against posted cost of sales, payroll and operating expenses, with how quickly stock is being used. Only posted entries and approved payroll are counted."
          paths={PROFITABILITY_FACT_PATHS}
          scope={{ branchId: scope.branchId, from: scope.from, to: scope.to }}
          scopeLabel={scope.branchId ? "Selected property" : "All authorised properties"}
        />
        <FactHandoff scope={{ branchId: scope.branchId, from: scope.from, to: scope.to }} />
        <RevenueVariancePanel
          scope={{ branchId: scope.branchId, from: scope.from, to: scope.to }}
        />

        <ReconciliationStatusPanel
          scope={{ branchId: scope.branchId, from: scope.from, to: scope.to }}
          compact
        />
      </div>

      {kpis.isLoading ? (
        <LoadingRows rows={4} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {metrics.map((m) => (
            <MetricCard
              key={m.code}
              metric={m}
              value={metricValue(kpis.data, m.path)}
              previous={metricValue(previous.data, m.path)}
              symbol={symbol}
              generatedAt={generatedAt}
            />
          ))}
        </div>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ChartFrame
            title="Revenue by stream"
            unit={`Amount in ${symbol || "local currency"}`}
            period={`${scope.from} → ${scope.to}`}
            source="Folio lines, point-of-sale orders and delivery orders"
            empty={!chartData.some((d) => d.rooms || d.fnb || d.delivery)}
          >
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={chartData}>
                <ChartGradients idPrefix="rev" />
                <CartesianGrid {...GRID_PROPS} />
                <XAxis dataKey="day" {...AXIS_PROPS} />
                <YAxis {...AXIS_PROPS} width={70} />
                <Tooltip {...TOOLTIP_PROPS} />
                <Area
                  {...LINE_PROPS}
                  dataKey="rooms"
                  name="Rooms"
                  stackId="1"
                  stroke={chartSeriesColor(0)}
                  fill={chartFill(0, "rev")}
                />
                <Area
                  {...LINE_PROPS}
                  dataKey="fnb"
                  name="Food & beverage"
                  stackId="1"
                  stroke={chartSeriesColor(1)}
                  fill={chartFill(1, "rev")}
                />
                <Area
                  {...LINE_PROPS}
                  dataKey="delivery"
                  name="Delivery"
                  stackId="1"
                  stroke={chartSeriesColor(2)}
                  fill={chartFill(2, "rev")}
                />
              </AreaChart>
            </ResponsiveContainer>
          </ChartFrame>
        </div>

        <Card className="surface-panel">
          <CardContent className="pt-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">Advisories</h3>
              <ClassificationBadge kind="recommendation" />
            </div>
            {advisories.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No rule triggered for this period. Nothing is invented to fill the panel.
              </p>
            ) : (
              <ul className="space-y-3">
                {advisories.map((a) => (
                  <li key={a.reference} className="rounded-lg border border-border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium text-foreground">{a.title}</p>
                      <StatusPill tone={a.confidence === "high" ? "warning" : "info"}>
                        {a.confidence}
                      </StatusPill>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{a.observation}</p>
                    <p className="mt-1 text-xs text-foreground">{a.recommendedAction}</p>
                    <p className="mt-1 text-[0.68rem] text-muted-foreground">{a.limitations}</p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 h-7 text-xs"
                      disabled={capture.isPending}
                      onClick={() =>
                        capture.mutate({
                          ...a,
                          branchId: scope.branchId,
                          from: scope.from,
                          to: scope.to,
                        })
                      }
                    >
                      Send for review
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4">
              <AiDisclosure
                provider="None — deterministic rules only"
                modelVersion="advisory-rules v1"
                dataPeriod={`${scope.from} → ${scope.to}`}
                sources={["bi_kpis", "bi_risk_scan"]}
                confidence="Rule-based, no model inference"
                gaps="Unrecorded activity is invisible to these rules."
                owner="Requires human review before action"
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/analytics">
      <ExecutiveAnalytics />
    </OpsGuard>
  );
}
