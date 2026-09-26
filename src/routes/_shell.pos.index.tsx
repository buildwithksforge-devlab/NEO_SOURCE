import { createFileRoute, Link } from "@tanstack/react-router";
import { ClipboardList, Coffee, CreditCard, Timer, Utensils } from "lucide-react";
import { PageHeader, SectionCard, StatCard, TableScroll } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, OrderStatusBadge, PosGuard, QueryState } from "@/components/pos/PosShared";
import { minutesSince, money, titleCase } from "@/lib/pos";
import {
  useMyOpenShift,
  usePosOrders,
  useRestaurantTables,
  useStationTickets,
} from "@/lib/pos-data";

export const Route = createFileRoute("/_shell/pos/")({
  head: () => ({
    meta: [
      { title: "POS Home — NEØ" },
      {
        name: "description",
        content:
          "Live restaurant, bar and coffee station trading: open orders, ready items and settled bills.",
      },
      { property: "og:title", content: "POS Home — NEØ" },
      {
        property: "og:description",
        content:
          "Live restaurant, bar and coffee station trading: open orders, ready items and settled bills.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PosGuard action="access">
      <PosHome />
    </PosGuard>
  ),
});

function isToday(iso: string | null) {
  if (!iso) return false;
  const d = new Date(iso);
  const n = new Date();
  return d.toDateString() === n.toDateString();
}

function PosHome() {
  const open = usePosOrders("open");
  const all = usePosOrders("all");
  const tickets = useStationTickets("all");
  const tables = useRestaurantTables();
  const shift = useMyOpenShift();

  const openRows = open.data ?? [];
  const settledToday = (all.data ?? []).filter(
    (o) =>
      isToday(o.closed_at) && ["paid", "charged-to-room", "closed", "credit"].includes(o.status),
  );
  const postedRevenue = settledToday.reduce((s, o) => s + Number(o.grand_total ?? 0), 0);
  const readyOrders = openRows.filter(
    (o) => o.status === "ready" || o.status === "partially-ready",
  );
  const delayed = (tickets.data ?? []).filter(
    (t) => t.status !== "ready" && minutesSince(t.created_at) > Number(t.target_minutes ?? 15),
  );
  const occupied = (tables.data ?? []).filter(
    (t) => !["available", "out-of-service", "blocked"].includes(t.status),
  );

  return (
    <div>
      <PageHeader
        eyebrow="Restaurant & POS"
        title="Point of Sale"
        description="Everything trading right now across the restaurant floor, bar, coffee station and kitchen — read from posted records only."
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/pos/floor">Restaurant floor</Link>
            </Button>
            <Button asChild>
              <Link to="/pos/orders">Open orders</Link>
            </Button>
          </>
        }
      />

      <div className="neo-kpi-grid mb-6">
        <StatCard
          lead
          label="Open orders"
          value={String(openRows.length)}
          icon={ClipboardList}
          hint="Not yet settled"
        />
        <StatCard
          label="Ready to serve"
          value={String(readyOrders.length)}
          icon={Coffee}
          tone="accent"
          hint="All or some stations finished"
        />
        <StatCard
          label="Delayed tickets"
          value={String(delayed.length)}
          icon={Timer}
          tone="warning"
          hint="Past station target time"
        />
        <StatCard
          label="Posted revenue today"
          value={money(postedRevenue)}
          icon={CreditCard}
          tone="success"
          hint={`${settledToday.length} finalised bill(s)`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          title="Open orders"
          description="Draft, sent, in-preparation and awaiting-payment bills."
          actions={
            <Button asChild size="sm" variant="ghost">
              <Link to="/pos/orders">View all</Link>
            </Button>
          }
        >
          <QueryState
            isLoading={open.isLoading}
            error={open.error}
            isEmpty={openRows.length === 0}
            empty={
              <EmptyState
                icon={Utensils}
                title="No open orders"
                description="Open a table on the restaurant floor, or create a takeaway or room-service order to start trading."
                action={
                  <Button asChild size="sm">
                    <Link to="/pos/floor">Go to the floor</Link>
                  </Button>
                }
              />
            }
          >
            <TableScroll>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Table / guest</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {openRows.slice(0, 12).map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="font-mono text-xs">
                        <Link
                          to="/pos/orders/$id"
                          params={{ id: o.id }}
                          className="text-primary hover:underline"
                        >
                          {o.order_number}
                        </Link>
                      </TableCell>
                      <TableCell>{titleCase(o.order_type)}</TableCell>
                      <TableCell>
                        {o.restaurant_tables?.code ??
                          o.guest_name ??
                          o.customers?.full_name ??
                          "Walk-in"}
                      </TableCell>
                      <TableCell>
                        <OrderStatusBadge status={o.status} />
                      </TableCell>
                      <TableCell className="text-right">{money(o.grand_total)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableScroll>
          </QueryState>
        </SectionCard>

        <div className="space-y-6">
          <SectionCard
            title="My cash session"
            description="Shift enforcement applies to cash settlement."
          >
            {shift.data ? (
              <div className="space-y-2 text-sm">
                <p className="font-medium">
                  Shift open since {new Date(shift.data.opened_at).toLocaleTimeString()}
                </p>
                <p className="text-muted-foreground">
                  Opening float {money(shift.data.opening_float)}
                </p>
                <Button asChild size="sm" variant="outline">
                  <Link to="/pos/shifts">Manage shift</Link>
                </Button>
              </div>
            ) : (
              <EmptyState
                title="No open shift"
                description="Open a cash session before taking cash payments."
                action={
                  <Button asChild size="sm">
                    <Link to="/pos/shifts">Open a shift</Link>
                  </Button>
                }
              />
            )}
          </SectionCard>

          <SectionCard title="Floor at a glance" description="Live table occupancy.">
            <div className="space-y-1 text-sm">
              <p>
                <span className="font-semibold">{occupied.length}</span> table(s) in service
              </p>
              <p className="text-muted-foreground">
                {(tables.data ?? []).length} table(s) configured
              </p>
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
