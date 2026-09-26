/**
 * Configuration health.
 *
 * What each property is still missing before it can trade properly, with the
 * screen that fixes it. The scan reports; it never configures anything by
 * itself, because a bottle size, a recipe or a store mapping is a decision
 * somebody has to make.
 */
import { useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRight, RefreshCw, ShieldCheck } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import { EmptyState, OpsGuard, QueryState } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useConfigurationHealth, type HealthCheck } from "@/lib/configuration-health";

export const Route = createFileRoute("/_shell/platform/configuration-health")({
  head: () => ({
    meta: [
      { title: "Configuration Health — NEØ Hospitality OS" },
      {
        name: "description",
        content:
          "Missing stations, stores, stock items, recipes, bottle sizes and payment integrations, property by property.",
      },
      { property: "og:title", content: "Configuration Health — NEØ Hospitality OS" },
      {
        property: "og:description",
        content: "What each property still needs configured before it can trade properly.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

function CheckRow({ check }: { check: HealthCheck }) {
  const navigate = useNavigate();
  return (
    <li className="flex flex-wrap items-start gap-3 py-3">
      <StatusPill tone={check.severity === "critical" ? "destructive" : "warning"}>
        {check.severity === "critical" ? "Blocking" : "Attention"}
      </StatusPill>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {check.label}
          {check.count > 0 ? <span className="text-muted-foreground"> · {check.count}</span> : null}
        </p>
        <p className="text-xs text-muted-foreground">{check.detail}</p>
      </div>
      <Button size="sm" variant="outline" onClick={() => navigate({ to: check.fix_route })}>
        {check.fix_label}
        <ArrowRight className="ml-1.5 size-3.5" />
      </Button>
    </li>
  );
}

function Page() {
  const { branchId } = useActivePropertyFilter();
  const health = useConfigurationHealth(branchId);
  const properties = health.data?.properties ?? [];

  const figures: SummaryFigure[] = useMemo(() => {
    const checks = properties.flatMap((p) => p.checks);
    return [
      {
        id: "blocking",
        label: "Blocking",
        value: String(checks.filter((c) => c.severity === "critical").length),
        tone: "destructive",
      },
      {
        id: "attention",
        label: "Needs attention",
        value: String(checks.filter((c) => c.severity !== "critical").length),
        tone: "warning",
      },
      {
        id: "clear",
        label: "Properties ready",
        value: String(properties.filter((p) => p.issues === 0).length),
      },
    ];
  }, [properties]);

  const lead: SummaryFigure = {
    id: "properties",
    label: "Properties checked",
    value: String(properties.length),
  };

  return (
    <OpsGuard path="/platform/configuration-health">
      <div className="space-y-4">
        <PageHeader
          title="Configuration health"
          description="What each property is still missing before it can sell, deduct stock and take payment."
          actions={
            <Button size="sm" variant="outline" onClick={() => void health.refetch()} disabled={health.isFetching}>
              <RefreshCw className={`mr-1.5 size-3.5 ${health.isFetching ? "animate-spin" : ""}`} />
              Re-check
            </Button>
          }
        />
        <SummaryStrip lead={lead} figures={figures} />

        <QueryState
          isLoading={health.isLoading}
          error={health.error}
          isEmpty={properties.length === 0}
          empty={<EmptyState title="No properties in view" description="Choose a property to run the check." />}
        >
          <div className="space-y-4">
            {properties.map((p) => (
              <SectionCard
                key={p.branch_id}
                title={p.branch_name}
                description={`${p.stations} stations · ${p.stores} stores · ${p.stock_items} stock items · ${p.menu_items} menu items`}
              >
                {p.checks.length === 0 ? (
                  <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                    <ShieldCheck className="size-4 text-success" />
                    Nothing outstanding on this property.
                  </div>
                ) : (
                  <ul className="divide-y divide-border/60">
                    {p.checks.map((c) => (
                      <CheckRow key={`${p.branch_id}-${c.code}`} check={c} />
                    ))}
                  </ul>
                )}
              </SectionCard>
            ))}
          </div>
        </QueryState>
      </div>
    </OpsGuard>
  );
}
