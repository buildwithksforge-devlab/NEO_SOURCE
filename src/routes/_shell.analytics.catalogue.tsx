import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { StatusPill } from "@/components/common/DataDisplay";
import { Card, CardContent } from "@/components/ui/card";
import { MetricDefinitionDialog } from "@/components/analytics/AnalyticsShared";
import { Button } from "@/components/ui/button";
import { METRIC_CATALOGUE, freshnessLabels, statusLabels } from "@/lib/analytics";

export const Route = createFileRoute("/_shell/analytics/catalogue")({
  head: () => ({
    meta: [
      { title: "KPI Catalogue — HOS Hospitality Platform" },
      {
        name: "description",
        content:
          "The approved hospitality KPI catalogue: formulas, sources, owners, versions and refresh frequency.",
      },
      { property: "og:title", content: "KPI Catalogue — HOS Hospitality Platform" },
      {
        property: "og:description",
        content: "Approved KPI definitions with formulas, sources, owners and versions.",
      },
    ],
  }),
  component: GuardedPage,
});

function Catalogue() {
  return (
    <Card className="surface-panel">
      <CardContent className="pt-5">
        <p className="mb-4 text-sm text-muted-foreground">
          Dashboards may only render metrics from this catalogue. Each entry states exactly what is
          counted, what is excluded and which records it is derived from.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3">Metric</th>
                <th className="py-2 pr-3">Section</th>
                <th className="py-2 pr-3">Formula</th>
                <th className="py-2 pr-3">Refresh</th>
                <th className="py-2 pr-3">Version</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {METRIC_CATALOGUE.map((m) => (
                <tr key={m.code} className="border-b border-border/60 align-top">
                  <td className="py-2 pr-3">
                    <p className="font-medium text-foreground">{m.name}</p>
                    <p className="text-xs text-muted-foreground">{m.code}</p>
                  </td>
                  <td className="py-2 pr-3 capitalize text-muted-foreground">{m.section}</td>
                  <td className="max-w-sm py-2 pr-3 text-xs text-muted-foreground">{m.formula}</td>
                  <td className="py-2 pr-3 text-xs text-muted-foreground">
                    {freshnessLabels[m.refresh]}
                  </td>
                  <td className="py-2 pr-3 text-xs text-muted-foreground">v{m.version}</td>
                  <td className="py-2 pr-3">
                    <StatusPill tone={m.status === "active" ? "success" : "info"}>
                      {statusLabels[m.status] ?? m.status}
                    </StatusPill>
                  </td>
                  <td className="py-2">
                    <MetricDefinitionDialog
                      metric={m}
                      trigger={
                        <Button size="sm" variant="ghost" className="h-7 text-xs">
                          Definition
                        </Button>
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/analytics/catalogue">
      <Catalogue />
    </OpsGuard>
  );
}
