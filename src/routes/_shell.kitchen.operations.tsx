import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Clock, Flame, Route as RouteIcon, Utensils } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { KitchenGuard, QueryState } from "@/components/kitchen/KitchenShared";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { titleCase } from "@/lib/kitchen";
import { Button } from "@/components/ui/button";
import {
  useKitchenOpsMetrics,
  useKitchenStationReconcile,
  useKitchenTicketRealtime,
} from "@/lib/kitchen-tickets";
import { KitchenAlertsFeed } from "@/components/kitchen/KitchenAlertsFeed";
import { useKitchenRoutingHealth } from "@/lib/kitchen-alerts";
import { ErrorState } from "@/components/common/StateSystem";

export const Route = createFileRoute("/_shell/kitchen/operations")({
  head: () => ({
    meta: [
      { title: "Kitchen Operations — NEØ" },
      {
        name: "description",
        content:
          "Station workload dashboard: open tickets, delayed tickets, average preparation time and backlog by ticket status.",
      },
      { property: "og:title", content: "Kitchen Operations — NEØ" },
      {
        property: "og:description",
        content:
          "Station workload, prep times and live backlog by ticket status across the kitchen.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <KitchenGuard action="queue.view">
      <KitchenOperations />
    </KitchenGuard>
  ),
});

function KitchenOperations() {
  useKitchenTicketRealtime();
  const metrics = useKitchenOpsMetrics();
  const reconcile = useKitchenStationReconcile();
  const health = useKitchenRoutingHealth();
  const m = metrics.data;
  const h = health.data;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Kitchen"
        title="Kitchen operations"
        description="Station workload derived from the same canonical production tickets the display screens use. Updates live as tickets move."
        actions={
          <Button
            variant="outline"
            disabled={reconcile.isPending}
            onClick={() => reconcile.mutate()}
          >
            {reconcile.isPending ? "Reconciling…" : "Reconcile ticket stations"}
          </Button>
        }
      />

      <QueryState isLoading={metrics.isLoading} error={metrics.error} isEmpty={false} empty={null}>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Open tickets" value={String(m?.open_tickets ?? 0)} icon={Utensils} />
          <StatCard
            label="Delayed tickets"
            value={String(m?.delayed_tickets ?? 0)}
            icon={Clock}
            tone={(m?.delayed_tickets ?? 0) > 0 ? "warning" : "default"}
          />
          <StatCard
            label="Average prep time"
            value={m?.avg_prep_minutes == null ? "Awaiting data" : `${m.avg_prep_minutes} min`}
            icon={Flame}
          />
          <StatCard
            label="Stations with load"
            value={String((m?.stations ?? []).filter((s) => s.open_tickets > 0).length)}
            icon={AlertTriangle}
          />
        </div>

        <SectionCard
          title="Backlog by ticket status"
          description="Open tickets grouped by their canonical lifecycle status."
        >
          {(m?.backlog_by_status ?? []).length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">No open tickets right now.</p>
          ) : (
            <ul className="divide-y divide-border">
              {(m?.backlog_by_status ?? []).map((b) => (
                <li key={b.status} className="flex items-center justify-between py-2 text-sm">
                  <span className="font-medium">{titleCase(b.status)}</span>
                  <StatusPill tone={b.status === "new" ? "warning" : "default"}>
                    {b.count}
                  </StatusPill>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Station workload"
          description="Open and delayed tickets, oldest waiting ticket, average preparation time and completions in the last 24 hours."
        >
          {(m?.stations ?? []).length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">
              No production tickets in the last seven days.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Station</TableHead>
                    <TableHead className="text-right">Open</TableHead>
                    <TableHead className="text-right">Delayed</TableHead>
                    <TableHead className="text-right">Oldest (min)</TableHead>
                    <TableHead className="text-right">Avg prep (min)</TableHead>
                    <TableHead className="text-right">Done 24h</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(m?.stations ?? []).map((s) => (
                    <TableRow key={s.station_id ?? s.station_name}>
                      <TableCell className="font-medium">{s.station_name}</TableCell>
                      <TableCell className="text-right">{s.open_tickets}</TableCell>
                      <TableCell className="text-right">
                        {s.delayed_tickets > 0 ? (
                          <StatusPill tone="warning">{s.delayed_tickets}</StatusPill>
                        ) : (
                          s.delayed_tickets
                        )}
                      </TableCell>
                      <TableCell className="text-right">{s.oldest_minutes}</TableCell>
                      <TableCell className="text-right">{s.avg_prep_minutes ?? "—"}</TableCell>
                      <TableCell className="text-right">{s.completed_24h}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Station routing health"
          description="Missing-routing rate, invariant violations and partitioning counts over the last 30 days."
        >
          {health.isLoading ? (
            <p className="py-6 text-sm text-muted-foreground">Loading routing health…</p>
          ) : health.error ? (
            <ErrorState className="my-4" error={health.error} inline />
          ) : (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard
                  label="Missing-routing rate"
                  value={`${((h?.missing_routing_rate ?? 0) * 100).toFixed(1)}%`}
                  icon={RouteIcon}
                  tone={(h?.items_missing_routing ?? 0) > 0 ? "warning" : "default"}
                  hint={`${h?.items_missing_routing ?? 0} of ${h?.items_total ?? 0} item(s)`}
                />
                <StatCard
                  label="Mixed-station tickets"
                  value={String(h?.mixed_station_tickets ?? 0)}
                  icon={AlertTriangle}
                  tone={(h?.mixed_station_tickets ?? 0) > 0 ? "warning" : "default"}
                />
                <StatCard
                  label="Unrouted tickets"
                  value={String(h?.unrouted_tickets ?? 0)}
                  icon={AlertTriangle}
                  tone={(h?.unrouted_tickets ?? 0) > 0 ? "warning" : "default"}
                />
                <StatCard
                  label="Partitioned tickets"
                  value={String(h?.partitioned_tickets ?? 0)}
                  icon={Utensils}
                  hint={`${h?.partitioned_orders ?? 0} order(s) split across stations`}
                />
              </div>
              {(h?.violations ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No routing invariant violations detected.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {(h?.violations ?? []).map((v) => (
                    <li
                      key={v.violation}
                      className="flex items-center justify-between py-2 text-sm"
                    >
                      <span className="font-medium">
                        {titleCase(v.violation.replace(/-/g, " "))}
                      </span>
                      <StatusPill tone="destructive">{v.count}</StatusPill>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </SectionCard>

        <KitchenAlertsFeed limit={8} />
      </QueryState>
    </div>
  );
}
