import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, History, ShieldAlert, Split } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { KitchenGuard, QueryState } from "@/components/kitchen/KitchenShared";
import { KitchenAlertsFeed } from "@/components/kitchen/KitchenAlertsFeed";
import { ReconciliationPanel } from "@/components/common/ReconciliationPanel";
import { usePosKdsReconciliation, useRouteMissingKitchenTickets } from "@/lib/ops-reconciliation";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useAuth } from "@/lib/auth";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { titleCase } from "@/lib/kitchen";
import { shortfallOf, useInsufficientStockOutcomes } from "@/lib/stock-reconciliation";
import {
  KITCHEN_ALERT_LABELS,
  useKitchenReconcileRun,
  useKitchenReconciliationStatus,
  useKitchenRoutingHealth,
} from "@/lib/kitchen-alerts";

export const Route = createFileRoute("/_shell/kitchen/reconciliation")({
  head: () => ({
    meta: [
      { title: "Kitchen Reconciliation — NEØ" },
      {
        name: "description",
        content:
          "Last successful ticket-station reconciliation, partitioned ticket counts, idempotency checks and suppressed duplicate alerts.",
      },
      { property: "og:title", content: "Kitchen Reconciliation — NEØ" },
      {
        property: "og:description",
        content: "Reconciliation runs, routing invariants and suppressed duplicate kitchen alerts.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <KitchenGuard action="queue.view">
      <KitchenReconciliation />
    </KitchenGuard>
  ),
});

function KitchenReconciliation() {
  const status = useKitchenReconciliationStatus();
  const health = useKitchenRoutingHealth();
  const run = useKitchenReconcileRun();
  const posKds = usePosKdsReconciliation();
  const { branchId } = useActivePropertyFilter();
  const { can } = useAuth();
  const mayRepair = can("kitchen", "queue.manage") || can("restaurant", "orders.manage");
  const routeMissing = useRouteMissingKitchenTickets(branchId);
  const s = status.data;
  const last = s?.last_successful_run ?? null;
  const missing = posKds.data?.groups.find((g) => g.key === "missing_tickets")?.rows.length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Kitchen"
        title="Reconciliation status"
        description="Evidence for ticket-station reconciliation: when it last ran, what it changed, whether it was idempotent, and which duplicate alerts were suppressed."
        actions={
          <Button variant="outline" disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? "Reconciling…" : "Run reconciliation"}
          </Button>
        }
      />

      <QueryState isLoading={status.isLoading} error={status.error} isEmpty={false} empty={null}>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Last successful run"
            value={last ? new Date(last.ran_at).toLocaleString() : "Never run"}
            icon={CheckCircle2}
            hint={last ? `${last.duration_ms} ms` : "Run reconciliation to establish a baseline"}
          />
          <StatCard
            label="Partitioned tickets"
            value={health.isLoading ? "—" : String(health.data?.partitioned_tickets ?? 0)}
            icon={Split}
            hint={
              health.isLoading
                ? "Checking ticket partitions…"
                : `${health.data?.partitioned_orders ?? 0} order(s) split across stations`
            }
          />
          <StatCard
            label="Idempotency check"
            value={last ? (last.idempotent ? "Clean" : "Changes applied") : "Awaiting data"}
            icon={ShieldAlert}
            tone={last && !last.idempotent ? "warning" : "default"}
            hint={
              last
                ? `${last.tickets_assigned} assigned · ${last.partitions_created} partitions · ${last.items_moved} items moved`
                : "Awaiting first run"
            }
          />
          <StatCard
            label="Suppressed duplicates (7d)"
            value={String(s?.alerts_suppressed_7d ?? 0)}
            icon={History}
            hint={`${s?.alerts_delivered_7d ?? 0} alert(s) delivered`}
          />
        </div>

        <SectionCard
          title="Run history"
          description="Every reconciliation run, with what it changed and whether it was a no-op."
        >
          {(s?.runs ?? []).length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">
              No reconciliation has been recorded for this property yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ran at</TableHead>
                    <TableHead className="text-right">Assigned</TableHead>
                    <TableHead className="text-right">Partitions</TableHead>
                    <TableHead className="text-right">Items moved</TableHead>
                    <TableHead className="text-right">Unrouted left</TableHead>
                    <TableHead>Idempotent</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(s?.runs ?? []).map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">
                        {new Date(r.ran_at).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">{r.tickets_assigned}</TableCell>
                      <TableCell className="text-right">{r.partitions_created}</TableCell>
                      <TableCell className="text-right">{r.items_moved}</TableCell>
                      <TableCell className="text-right">
                        {r.items_without_routing > 0 ? (
                          <StatusPill tone="warning">{r.items_without_routing}</StatusPill>
                        ) : (
                          0
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusPill tone={r.idempotent ? "success" : "info"}>
                          {r.idempotent ? "No-op" : "Changed"}
                        </StatusPill>
                      </TableCell>
                      <TableCell>
                        <StatusPill tone={r.status === "succeeded" ? "success" : "destructive"}>
                          {titleCase(r.status)}
                        </StatusPill>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Alert delivery (last 7 days)"
          description="Delivered versus suppressed duplicate notifications, by alert kind."
        >
          {(s?.alerts_by_kind ?? []).length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">
              No kitchen alerts raised in the last seven days.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {(s?.alerts_by_kind ?? []).map((a) => (
                <li key={a.kind} className="flex items-center justify-between py-2 text-sm">
                  <span className="font-medium">
                    {KITCHEN_ALERT_LABELS[a.kind] ?? titleCase(a.kind)}
                  </span>
                  <span className="flex items-center gap-2">
                    <StatusPill tone="success">{a.delivered} delivered</StatusPill>
                    <StatusPill tone={a.suppressed > 0 ? "warning" : "default"}>
                      {a.suppressed} suppressed
                    </StatusPill>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <KitchenAlertsFeed />

        <div className="space-y-3">
          {mayRepair ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 p-3">
              <p className="text-sm text-muted-foreground">
                {missing > 0
                  ? `${missing} sent item(s) hold no kitchen ticket. Routing rebuilds them through the canonical station resolver.`
                  : "Kitchen-bound orders route to the kitchen automatically. Use this to re-check historic orders."}
              </p>
              <Button
                variant="outline"
                disabled={routeMissing.isPending}
                onClick={() => routeMissing.mutate()}
              >
                {routeMissing.isPending ? "Routing…" : "Route missing tickets"}
              </Button>
            </div>
          ) : null}
          <ReconciliationPanel
            title="POS to kitchen reconciliation"
            description="Every sent prepared item should hold exactly one live kitchen ticket line, on a resolved station."
            report={posKds.data}
            isLoading={posKds.isLoading}
            error={posKds.error}
          />
          <InsufficientStockPanel />
        </div>

      </QueryState>
    </div>
  );
}

/**
 * Insufficient-stock outcomes. Recipe consumption posts the full requirement:
 * nothing is silently part-deducted, so a store that did not hold the stock
 * shows here as a negative balance to be investigated and corrected through the
 * canonical count/adjustment flow. This view only reads.
 */
function InsufficientStockPanel() {
  const outcomes = useInsufficientStockOutcomes();
  const rows = outcomes.data ?? [];

  return (
    <SectionCard
      title="Insufficient stock outcomes"
      description="Consumption is never partially deducted. Where a store did not hold the recipe requirement the balance is left negative so the shortfall stays visible — reconcile it with a stock count or adjustment."
    >
      <QueryState
        isLoading={outcomes.isLoading}
        error={outcomes.error}
        isEmpty={rows.length === 0}
        empty={
          <p className="text-sm text-muted-foreground" data-testid="insufficient-stock-clear">
            No negative balances — every consumption posting was covered by stock on hand.
          </p>
        }
      >
        <Table data-testid="insufficient-stock-table">
          <TableHeader>
            <TableRow>
              <TableHead>Stock item</TableHead>
              <TableHead>Store</TableHead>
              <TableHead className="text-right">Shortfall</TableHead>
              <TableHead className="text-right">Last movement</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const item = (row["stock_items"] ?? {}) as Record<string, unknown>;
              const location = (row["stock_locations"] ?? {}) as Record<string, unknown>;
              return (
                <TableRow key={String(row["id"])}>
                  <TableCell>{String(item["name"] ?? "—")}</TableCell>
                  <TableCell>{String(location["name"] ?? "—")}</TableCell>
                  <TableCell className="text-right">
                    {shortfallOf(row)} {String(item["base_unit"] ?? "")}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {row["last_movement_at"] ? String(row["last_movement_at"]).slice(0, 16).replace("T", " ") : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </QueryState>
    </SectionCard>
  );
}
