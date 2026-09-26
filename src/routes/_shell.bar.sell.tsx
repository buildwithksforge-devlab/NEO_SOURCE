import { cn } from "@/lib/utils";
/**
 * The Bar's own selling surface.
 *
 * It is a department-facing entry point, not a second order system: a tab
 * opened here is an ordinary `pos_orders` record created through the canonical
 * `useCreateOrder` mutation, and it is served, sent to the bar station, settled
 * or charged to a room in the same POS terminal every other outlet uses. The
 * drinks list is the bar-scoped slice of the one menu catalogue.
 */
import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { GlassWater, Receipt } from "lucide-react";
import {
  Atomic,
  PageHeader,
  RowActions,
  SectionCard,
  StatCard,
  StatusPill,
  TableScroll,
} from "@/components/common/DataDisplay";
import { BarGuard, EmptyState, QueryState } from "@/components/bar/BarShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { OrderStatusBadge } from "@/components/pos/PosShared";
import { MenuItemImage } from "@/components/pos/MenuImageField";
import { useAuth } from "@/lib/auth";
import { money, titleCase } from "@/lib/pos";
import { useCreateOrder, useMyOpenShift } from "@/lib/pos-data";
import { useBarMenu, useBarOpenOrders, type BarMenuItem } from "@/lib/bar";

export const Route = createFileRoute("/_shell/bar/sell")({
  head: () => ({
    meta: [
      { title: "Sell at the Bar — NEØ" },
      {
        name: "description",
        content:
          "Open a bar tab, add drinks from the bar-assigned menu and settle or charge to room through the canonical POS terminal.",
      },
      { property: "og:title", content: "Sell at the Bar — NEØ" },
      {
        property: "og:description",
        content:
          "Bar selling surface backed by the shared POS order, payment and station contracts.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <BarGuard action="pos.view">
      <BarSellPage />
    </BarGuard>
  ),
});

function BarSellPage() {
  const { can, isAdmin } = useAuth();
  const navigate = useNavigate();
  const menu = useBarMenu();
  const openOrders = useBarOpenOrders();
  const shift = useMyOpenShift();
  const createOrder = useCreateOrder();
  const [search, setSearch] = useState("");
  const [guest, setGuest] = useState("");

  // A bar attendant sells through the bar's own POS feature; a restaurant
  // cashier may also hold the shared POS orders permission. Either opens a tab.
  const maySell = isAdmin || can("bar", "pos", "create") || can("pos", "orders", "create");
  const items = (menu.data ?? []) as BarMenuItem[];
  const query = search.trim().toLowerCase();
  const drinks = useMemo(
    () =>
      items.filter(
        (i) =>
          !query ||
          i.name.toLowerCase().includes(query) ||
          (i.sku ?? "").toLowerCase().includes(query) ||
          (i.category_name ?? "").toLowerCase().includes(query),
      ),
    [items, query],
  );
  const tabs = openOrders.data ?? [];
  const openValue = tabs.reduce((sum, t) => sum + Number(t.grand_total ?? 0), 0);

  const openTab = async () => {
    const created = await createOrder.mutateAsync({
      order_type: "bar",
      order_source: "bar-pos",
      guest_name: guest.trim() || null,
      shift_id: shift.data?.id ?? null,
    });
    setGuest("");
    // Items, sending to the bar station, discounts, payment and room charge all
    // happen in the canonical terminal — the Bar never forks that flow.
    void navigate({ to: "/pos/orders/$id", params: { id: created.id } });
  };

  return (
    <div>
      <PageHeader
        eyebrow="Bar Department"
        title="Sell at the Bar"
        description="Open a tab, pour, then settle or charge to room. Every tab is an ordinary POS order, so Finance, the bar queue and stock all see it exactly once."
        actions={
          <Button variant="outline" asChild>
            <Link to="/bar/queue">Open bar queue</Link>
          </Button>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Open tabs" value={String(tabs.length)} hint="Not yet settled" />
        <StatCard label="Open tab value" value={money(openValue)} />
        <StatCard label="Bar items" value={String(items.length)} hint="Assigned to a bar station" />
        <StatCard
          label="My shift"
          value={shift.data ? "Open" : "Not open"}
          hint={shift.data ? "Sales attach to this shift" : "Open a shift in POS to attach sales"}
          tone={shift.data ? "default" : "warning"}
        />
      </div>

      <SectionCard
        title="Open a bar tab"
        description="A tab opens in the shared service terminal, where drinks, modifiers, holds, discounts and settlement follow the existing rules."
      >
        {maySell ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Input
              className="sm:max-w-xs"
              placeholder="Guest or tab name (optional)"
              value={guest}
              aria-label="Guest or tab name"
              onChange={(e) => setGuest(e.target.value)}
            />
            <Button
              className="min-h-11"
              disabled={createOrder.isPending}
              onClick={() => void openTab()}
            >
              <Receipt className="size-4" />
              New bar tab
            </Button>
          </div>
        ) : (
          <EmptyState
            title="You may view the bar but not sell"
            description="Opening a tab needs the POS order-creation permission. Ask an administrator to grant it from Roles & Permissions — the Bar does not bypass it."
          />
        )}
      </SectionCard>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <SectionCard title="Open bar tabs" description="Select a tab to add drinks or settle it.">
          <QueryState
            isLoading={openOrders.isLoading}
            error={openOrders.error}
            isEmpty={tabs.length === 0}
            empty={
              <EmptyState
                icon={Receipt}
                title="No open bar tabs"
                description="Tabs opened at the bar, and restaurant orders routed to a bar station, appear here until they are settled."
              />
            }
          >
            <TableScroll>
              <Table className="neo-list-rows">
                <TableHeader>
                  <TableRow>
                    <TableHead className="neo-sticky-col">Tab</TableHead>
                    <TableHead>Guest / table</TableHead>
                    <TableHead>Items</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Open</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tabs.map((t) => (
                    <TableRow key={t.order_id}>
                      <TableCell className="neo-sticky-col whitespace-nowrap font-mono text-xs">
                        {t.order_number}
                      </TableCell>
                      <TableCell>
                        <span
                          className="neo-line-1 max-w-[14rem]"
                          title={t.guest_name ?? t.table_code ?? "Walk-in"}
                        >
                          {t.guest_name ?? t.table_code ?? "Walk-in"}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {Number(t.item_count ?? 0)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <OrderStatusBadge status={t.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Atomic>{money(t.grand_total, t.currency ?? "KES")}</Atomic>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        <RowActions>
                          <Button size="sm" variant="outline" asChild>
                            <Link to="/pos/orders/$id" params={{ id: t.order_id }}>
                              Service terminal
                            </Link>
                          </Button>
                        </RowActions>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableScroll>
          </QueryState>
        </SectionCard>

        <SectionCard
          title="Bar drinks list"
          description="Only items whose production station is a bar station of the selected property."
          actions={
            <Input
              className="w-44 sm:w-56"
              placeholder="Search drinks"
              aria-label="Search bar menu"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          }
        >
          <QueryState
            isLoading={menu.isLoading}
            error={menu.error}
            isEmpty={drinks.length === 0}
            empty={
              <EmptyState
                icon={GlassWater}
                title="No bar items yet"
                description="Items appear here once a published menu item is routed to a bar station for this property."
              />
            }
          >
            <ul className="grid gap-2 sm:grid-cols-2">
              {drinks.map((item) => (
                <li
                  key={item.id}
                  className={cn(
                    "relative flex min-h-16 items-center gap-3 overflow-hidden rounded-xl border p-3 pl-4 transition-shadow hover:shadow-sm",
                    item.availability === "available"
                      ? "surface-raised border-outline-subtle"
                      : "border-warning/40 bg-card/60",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "absolute inset-y-0 left-0 w-1",
                      item.availability === "available" ? "bg-success/60" : "bg-warning/80",
                    )}
                  />
                  <MenuItemImage path={item.image_url} name={item.name} size={44} />
                  <div className="min-w-0 flex-1">
                    <p
                      className="neo-line-1 text-[0.9375rem] font-semibold tracking-tight"
                      title={item.name}
                    >
                      {item.name}
                    </p>
                    <p className="neo-line-1 text-xs text-muted-foreground">
                      {[item.category_name, item.station_name].filter(Boolean).join(" · ") || "Bar"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="neo-atomic text-base font-bold tabular-nums">
                      {money(item.base_price, item.currency ?? "KES")}
                    </p>
                    <p className="text-[0.65rem] uppercase tracking-[0.12em] text-muted-foreground">
                      Price
                    </p>
                    {item.availability !== "available" ? (
                      <StatusPill tone="warning">{titleCase(item.availability)}</StatusPill>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </QueryState>
        </SectionCard>
      </div>
    </div>
  );
}
