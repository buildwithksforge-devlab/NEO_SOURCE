import { useMemo } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AwaitingData } from "./AwaitingData";
import { DashboardStateCard } from "./DashboardStateCard";
import { cardContract } from "@/lib/data-sources";
import { isPermissionError } from "@/lib/card-state";
import { useVisibility } from "@/lib/visibility";
import { DashboardPanel } from "./panels";
import { ReconciliationStatusPanel } from "@/components/finance/ReconciliationStatus";
import { FactExportButton } from "@/components/common/FactExportButton";
import { DataSourceStatus } from "@/components/common/DataSourceStatus";
import { DensityToggle } from "@/components/common/DensityToggle";
import { readMetric, type DashboardSpec, type Widget } from "@/lib/dashboards";
import {
  DASHBOARD_PERIODS,
  scopePeriod,
  useDashboardMetrics,
  useScopeOptions,
  withPeriod,
  type DashboardScope,
} from "@/lib/dashboard-data";
import { useActivePropertyFilter } from "@/lib/branch-filter";

import { cn } from "@/lib/utils";
import {
  factCurrency,
  factDefinition,
  factGeneratedAt,
  factPathOf,
  factValue,
  factsMonetaryAuthorised,
  formatFact,
  isFactMetric,
  useFacts,
} from "@/lib/facts";

const ALL = "all";

export function DashboardFrame({
  spec,
  scope,
  onScopeChange,
  userId,
  organizationId,
  greeting,
  dashboards,
  activeKey,
}: {
  spec: DashboardSpec;
  scope: DashboardScope;
  onScopeChange: (next: DashboardScope) => void;
  userId: string | null;
  organizationId: string | null;
  greeting: string;
  dashboards: { key: string; name: string }[];
  activeKey: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // The global active property is the hard boundary: when one is selected every
  // dashboard figure, panel and export reads that property, never "all".
  const { branchId: activeBranchId } = useActivePropertyFilter();
  const scoped = useMemo<DashboardScope>(
    () => (activeBranchId ? { ...scope, branchId: activeBranchId } : scope),
    [scope, activeBranchId],
  );
  const metrics = useDashboardMetrics(scoped, Boolean(organizationId));
  const options = useScopeOptions(organizationId);
  const visibility = useVisibility();
  // One canonical period for the fact layer, shared with /analytics and /finance.
  const period = useMemo(() => scopePeriod(scoped), [scoped]);
  const factScope = useMemo(
    () => ({ branchId: scoped.branchId, from: period.from, to: period.to }),
    [scoped.branchId, period.from, period.to],
  );

  const usesFacts = spec.widgets.some((w) => w.kind === "kpi" && isFactMetric(w.metric));
  const facts = useFacts(factScope, Boolean(organizationId) && usesFacts);
  const currency = factCurrency(facts.data);
  const moneyAllowed = factsMonetaryAuthorised(facts.data);

  // A dashboard shows what the reader owns. A figure or action the role was
  // never meant to hold is omitted, never rendered as an "Access denied" tile.
  const permittedWidget = (w: { requires?: { module: string; feature: string; action: string } }) =>
    !w.requires || visibility.canAct(w.requires.module, w.requires.feature, w.requires.action);
  const kpis = spec.widgets.filter(
    (w): w is Extract<Widget, { kind: "kpi" }> => w.kind === "kpi" && permittedWidget(w),
  );
  const panels = spec.widgets.filter(
    (w): w is Extract<Widget, { kind: "panel" }> => w.kind === "panel" && permittedWidget(w),
  );
  // A quick action must also lead somewhere the reader may actually open —
  // capability alone is not enough when the destination page is guarded.
  const quickActions = spec.quickActions.filter(
    (a) => permittedWidget(a) && (!a.to || visibility.canSeePage(a.to)),
  );


  /**
   * Scope selectors offer only what the reader is authorised to look at. A
   * station-scope user gets their own stations and no "All …" escape hatch;
   * departmental and wider scopes keep the breadth they genuinely hold.
   */
  const departmentScope = visibility.departmentSelector();
  const stationScope = visibility.stationSelector();

  const departments = (options.data?.departments ?? [])
    .filter((d) => !scoped.branchId || d.branch_id === scoped.branchId)
    .filter((d) => departmentScope.allowAll || departmentScope.ids.includes(d.id));
  const stations = (options.data?.stations ?? [])
    .filter((s) => !scoped.departmentId || s.department_id === scoped.departmentId)
    .filter((s) => stationScope.allowAll || stationScope.ids.includes(s.id));


  return (
    <div>
      <PageHeader
        eyebrow={`${spec.name} · ${spec.scopeHint} scope`}
        title={greeting}
        description={spec.purpose}
        actions={
          <>
            {dashboards.length > 1 ? (
              <Select
                value={activeKey}
                onValueChange={(key) => {
                  void navigate({ to: "/dashboards/$key", params: { key } });
                }}
              >
                <SelectTrigger className="h-9 w-full sm:w-[220px]" aria-label="Switch dashboard">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {dashboards.map((d) => (
                    <SelectItem key={d.key} value={d.key}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Button
              variant="outline"
              onClick={() => void queryClient.invalidateQueries()}
              aria-label="Refresh dashboard"
            >
              <RefreshCw className={cn("size-4", metrics.isFetching && "animate-spin")} />
              Refresh
            </Button>
          </>
        }
      />

      {/*
        Shared filter surface plus one stable control slot.

        The filters occupy a fluid, min-w-0 column that measures itself against
        the toolbar — collapsing or expanding the sidebar changes its width
        without moving the density control, which keeps its own right-hand
        slot. From md the segmented track is shown; below that the control
        compresses to a single density menu so it can never wrap onto the
        period row.
      */}
      <div
        data-dashboard-toolbar
        className="mb-6 flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start"
      >
        <div className="neo-filter-bar min-w-0 flex-1">
        <Select
          value={scoped.branchId ?? ALL}
          disabled={Boolean(activeBranchId)}
          onValueChange={(v) =>
            onScopeChange({
              ...scope,
              branchId: v === ALL ? null : v,
              departmentId: null,
              stationId: null,
            })
          }
        >
          <SelectTrigger
            className="h-10 w-full"
            aria-label="Filter by branch"
            title={
              activeBranchId
                ? "Following the active property selected in the top bar"
                : undefined
            }
          >
            <SelectValue placeholder="All branches" />
          </SelectTrigger>
          <SelectContent>
            {activeBranchId ? null : <SelectItem value={ALL}>All branches</SelectItem>}
            {(options.data?.branches ?? []).map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={scope.departmentId ?? ALL}
          onValueChange={(v) =>
            onScopeChange({
              ...scope,
              departmentId: v === ALL ? null : v,
              stationId: null,
            })
          }
        >
          <SelectTrigger className="h-10 w-full" aria-label="Filter by department">
            <SelectValue placeholder="All departments" />
          </SelectTrigger>
          <SelectContent>
            {departmentScope.allowAll ? <SelectItem value={ALL}>All departments</SelectItem> : null}
            {departments.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={scope.stationId ?? ALL}
          onValueChange={(v) => onScopeChange({ ...scope, stationId: v === ALL ? null : v })}
        >
          <SelectTrigger className="h-10 w-full" aria-label="Filter by station">
            <SelectValue placeholder="All stations" />
          </SelectTrigger>
          <SelectContent>
            {stationScope.allowAll ? <SelectItem value={ALL}>All stations</SelectItem> : null}
            {stations.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>


        <Select
          value={period.key}
          onValueChange={(v) => onScopeChange(withPeriod(scope, v as typeof period.key))}
        >
          <SelectTrigger
            className="h-10 w-full"
            aria-label="Reporting period"
            data-testid="dashboard-period"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DASHBOARD_PERIODS.map((p) => (
              <SelectItem key={p.key} value={p.key}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        </div>

        <div
          data-density-slot
          className="flex shrink-0 items-center justify-end gap-1 lg:pt-0"
        >
          <DensityToggle className="hidden md:inline-flex" />
          <DensityToggle variant="menu" className="md:hidden" />
        </div>
      </div>

      {/* One dashboard context line. Scope, period and calculation time are
          stated once here and never repeated inside every KPI card. */}
      <p
        data-dashboard-context
        className="mb-5 text-xs text-muted-foreground"
      >
        <span className="font-medium text-foreground">{spec.scopeHint} scope</span> ·{" "}
        {period.label} ({period.from} → {period.to})
        {factGeneratedAt(facts.data)
          ? ` · calculated ${new Date(factGeneratedAt(facts.data) as string).toLocaleTimeString()}`
          : ""}
      </p>


      {metrics.error ? (
        <div className="mb-6 rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Dashboard metrics could not be loaded for your account. Ask an administrator to confirm
          your branch and department assignments.
        </div>
      ) : null}

      {/* Editorial grid: the lead KPI is given more room, the supporting
          figures stay compact, and everything reflows to one column on a
          phone rather than shrinking a desktop layout. */}
      <div className="neo-kpi-grid">
        {kpis.map((w, index) => {
          const card = cardContract(w.id, w.metric);
          const permitted =
            !card || card.capability === "universal" ? true : visibility.canSeePage(card.drillTo);
          const usesFactLayer = isFactMetric(w.metric);
          const def = usesFactLayer ? factDefinition(factPathOf(w.metric!)) : undefined;
          const value = usesFactLayer
            ? factValue(facts.data, factPathOf(w.metric!))
            : readMetric(metrics.data, w.metric);
          // Each fact card reads the state of the one domain that produces it,
          // so a failure in period/accounting facts cannot blank Front Office
          // or operational cards (and vice versa).
          const factDomain = usesFactLayer ? facts.forPath(factPathOf(w.metric!)) : null;
          const query = factDomain ?? metrics;
          const factPermitted =
            !usesFactLayer ||
            !def ||
            def.kind !== "money" ||
            !facts.domains.period.isSuccess ||
            moneyAllowed;
          // Refusals are omitted, not displayed: a figure this role does not
          // own has no place on their dashboard at all.
          if (!permitted || !factPermitted || isPermissionError(query.error)) return null;
          return (
            <div key={w.id} className="min-w-0" data-kpi-span={index === 0 ? "lead" : undefined}>
            <DashboardStateCard
              label={w.title}
              implemented={w.source !== "awaiting-module"}
              permitted={permitted && factPermitted}
              configured={w.source === "external" ? false : organizationId ? undefined : false}
              configureNote={w.note || "Complete workspace setup to produce this figure"}
              // A work figure states the audience it counted on the card
              // itself, so "open tasks" is never mistaken for "my tasks".
              {...(w.note ? { hint: w.note } : {})}
              isLoading={query.isLoading}
              hasLoaded={query.isSuccess}
              error={query.error}
              scopeSelectionRequired={factDomain?.scopeSelectionRequired ?? false}
              value={value}
              suffix={usesFactLayer && def && def.kind !== "count" ? "" : (w.suffix ?? "")}
              {...(usesFactLayer && def
                ? { format: (v: number) => formatFact(v, def.kind, currency) }
                : {})}
              featured={index === 0}
              {...(card?.drillTo ? { drillTo: card.drillTo, drillLabel: "Open records" } : {})}
              onRetry={() => query.refetch()}
              {...(w.tone ? { tone: w.tone } : {})}
            />
            </div>
          );
        })}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3" data-dashboard-panels>
        {panels.map((w) => {
          const spanClass =
            w.span === 3 ? "lg:col-span-3" : w.span === 2 ? "lg:col-span-2" : undefined;
          return (
            <div key={w.id} className={spanClass}>
              {w.source === "awaiting-module" || !w.panel ? (
                <AwaitingData title={w.title} note={w.note ?? ""} className="h-full" />
              ) : (
                <DashboardPanel panel={w.panel} title={w.title} scope={scoped} userId={userId} />
              )}
            </div>
          );
        })}
      </div>

      {usesFacts ? (
        <div className="mt-6 space-y-3">
          <div className="flex justify-end">
            <FactExportButton
              scope={factScope}
              scopeLabel={spec.scopeHint}
              enabled={Boolean(organizationId)}
            />
          </div>
          {/* Fact-service provenance is technical diagnostics: useful to an
              administrator, noise on an operational staff dashboard. */}
          {visibility.canSeePage("/admin/settings") ? (
            <DataSourceStatus
              scope={factScope}
              query={facts}
              facts={facts}
              enabled={Boolean(organizationId)}
            />
          ) : null}
        </div>
      ) : null}

      {visibility.canSeePage("/finance/posting") ? (
        <div className="mt-6">
          <ReconciliationStatusPanel scope={factScope} compact />
        </div>
      ) : null}


      <TooltipProvider>
      <div className="mt-6 flex flex-wrap gap-2">
        {quickActions.map((a) =>
          a.to ? (
            <Button key={a.label} variant="outline" asChild>
              <Link to={a.to}>{a.label}</Link>
            </Button>
          ) : (
            <Tooltip key={a.label}>
              <TooltipTrigger asChild>
                <span>
                  <Button variant="outline" disabled>
                    {a.label}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{a.note ?? "Awaiting the related module"}</TooltipContent>
            </Tooltip>
          ),
        )}
      </div>
      </TooltipProvider>
    </div>
  );
}
