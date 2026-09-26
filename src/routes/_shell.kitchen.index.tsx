import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ChefHat,
  Clock,
  Flame,
  PackageSearch,
  Sparkles,
  Trash2,
  Utensils,
} from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { Card, CardContent } from "@/components/ui/card";
import { KitchenGuard, QueryState } from "@/components/kitchen/KitchenShared";
import { titleCase, type Row } from "@/lib/kitchen";
import { useVisibility } from "@/lib/visibility";
import {
  useKitchenAiInsights,
  useKitchenMetrics,
  useKitchenQueue,
  useShortageAlerts,
} from "@/lib/kitchen-data";

export const Route = createFileRoute("/_shell/kitchen/")({
  head: () => ({
    meta: [
      { title: "Kitchen Management — NEØ" },
      {
        name: "description",
        content:
          "Live kitchen production overview: station load, preparation timers, waste, shortages and quality holds across every outlet.",
      },
      { property: "og:title", content: "Kitchen Management — NEØ" },
      {
        property: "og:description",
        content: "Live kitchen production overview across stations, waste, shortages and quality.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <KitchenGuard action="access">
      <KitchenHome />
    </KitchenGuard>
  ),
});

function KitchenHome() {
  const metrics = useKitchenMetrics();
  const queue = useKitchenQueue("all");
  const shortages = useShortageAlerts();
  const insights = useKitchenAiInsights();
  const showCost = useVisibility().canSeeCost("production-cost");

  const m = metrics.data ?? {};
  const num = (key: string) => Number(m[key] ?? 0);

  const live = queue.data ?? [];
  const byStation = new Map<string, number>();
  for (const t of live) {
    const name = (t as Row)["operational_stations"]?.name ?? "Unassigned";
    byStation.set(name, (byStation.get(name) ?? 0) + 1);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Kitchen"
        title="Kitchen Management System"
        description="Every figure below is calculated from live production records — tickets, waste logs, quality checks and posted sales."
      />

      <div className="neo-kpi-grid">
        <StatCard
          lead
          label="Tickets received (24h)"
          value={String(num("tickets_received"))}
          icon={Utensils}
        />
        <StatCard
          label="In preparation"
          value={String(num("tickets_in_preparation"))}
          icon={Flame}
        />
        <StatCard
          label="Delayed tickets"
          value={String(num("tickets_delayed"))}
          icon={Clock}
          tone={num("tickets_delayed") > 0 ? "warning" : "default"}
        />
        <StatCard
          label="Average prep time"
          value={m["avg_prep_minutes"] == null ? "—" : `${m["avg_prep_minutes"]} min`}
          icon={ChefHat}
        />
        <StatCard label="Items ready (24h)" value={String(num("items_ready"))} icon={Utensils} />
        <StatCard label="Remakes" value={String(num("remakes"))} icon={AlertTriangle} />
        <StatCard
          label="Waste records (24h)"
          value={String(num("waste_records"))}
          {...(showCost ? { hint: `Cost ${num("waste_cost").toFixed(2)}` } : {})}
          icon={Trash2}
        />
        <StatCard
          label="Open shortages"
          value={String(num("open_shortages"))}
          hint={`${num("open_requests")} open store requests`}
          icon={PackageSearch}
          tone={num("open_shortages") > 0 ? "warning" : "default"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="Live load by station"
          description="Open tickets currently routed to each preparation station."
          actions={
            <Link
              to="/kitchen/queue"
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              Open live queue
            </Link>
          }
        >
          <QueryState
            isLoading={queue.isLoading}
            error={queue.error}
            isEmpty={byStation.size === 0}
            empty={<p className="py-6 text-sm text-muted-foreground">No open tickets right now.</p>}
          >
            <ul className="divide-y divide-border">
              {[...byStation.entries()].map(([name, count]) => (
                <li key={name} className="flex items-center justify-between py-2 text-sm">
                  <span className="font-medium">{name}</span>
                  <StatusPill tone={count > 8 ? "warning" : "default"}>{count} open</StatusPill>
                </li>
              ))}
            </ul>
          </QueryState>
        </SectionCard>

        <SectionCard
          title="Shortages reported by the kitchen"
          description="Raised by chefs and routed to Stores and Procurement."
          actions={
            <Link
              to="/kitchen/stores"
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              Manage requests
            </Link>
          }
        >
          <QueryState
            isLoading={shortages.isLoading}
            error={shortages.error}
            isEmpty={(shortages.data ?? []).length === 0}
            empty={
              <p className="py-6 text-sm text-muted-foreground">No shortages have been reported.</p>
            }
          >
            <ul className="divide-y divide-border">
              {(shortages.data ?? []).slice(0, 8).map((s) => {
                const row = s as Row;
                return (
                  <li key={row["id"]} className="flex items-center justify-between py-2 text-sm">
                    <span className="font-medium">{row["ingredient_name"]}</span>
                    <StatusPill tone={row["status"] === "resolved" ? "success" : "warning"}>
                      {titleCase(row["status"])}
                    </StatusPill>
                  </li>
                );
              })}
            </ul>
          </QueryState>
        </SectionCard>
      </div>

      <SectionCard
        title="AI kitchen recommendations"
        description="Generated from your own production history. Recommendations only — a supervisor still decides."
      >
        <QueryState
          isLoading={insights.isLoading}
          error={insights.error}
          isEmpty={(insights.data ?? []).length === 0}
          empty={
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
                <Sparkles className="size-5 text-muted-foreground" />
                <p className="text-sm font-medium">No recommendations yet</p>
                <p className="max-w-md text-sm text-muted-foreground">
                  Insights appear once enough tickets, waste records and quality checks have been
                  captured for this kitchen.
                </p>
              </CardContent>
            </Card>
          }
        >
          <ul className="space-y-3">
            {(insights.data ?? []).map((i) => {
              const row = i as Row;
              return (
                <li key={row["id"]} className="rounded-xl border border-border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold">{row["title"]}</p>
                    <StatusPill tone="info">
                      {titleCase(row["insight_type"] ?? "insight")}
                    </StatusPill>
                  </div>
                  {row["body"] ? (
                    <p className="mt-1 text-sm text-muted-foreground">{row["body"]}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </QueryState>
      </SectionCard>
    </div>
  );
}
