/**
 * Supplier portal.
 *
 * One shared view of the order book per supplier: what has been approved, what
 * is still owed, what has already been delivered and which goods receipts have
 * been posted. The internal view reads from Procurement's purchase order board.
 * Reads follow the active property, so a buyer only sees their own branch.
 */
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PackageCheck, Truck, Users } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { OpsGuard } from "@/components/operations/OpsShared";
import { EmptyState, QueryState } from "@/components/pms/PmsShared";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { useBranchScope } from "@/lib/branches";
import { useTenant } from "@/lib/tenant";
import { formatMoney, statusTone, titleCase, type Row } from "@/lib/inventory";
import { usePurchaseOrderBoard, type OrderView } from "@/lib/procurement-orders";

export const Route = createFileRoute("/_shell/procurement/supplier-portal")({
  head: () => ({
    meta: [
      { title: "Supplier portal — NEØ" },
      {
        name: "description",
        content:
          "Approved purchase orders, outstanding deliveries and goods receipts by supplier.",
      },
      { property: "og:title", content: "Supplier portal — NEØ" },
      {
        property: "og:description",
        content: "One shared order book: approved orders, pending deliveries and goods receipts per supplier.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard path="/procurement/orders">
      <SupplierPortalPage />
    </OpsGuard>
  ),
});

const qty = (v: number) => (Math.round(v * 1000) / 1000).toLocaleString();

type SupplierGroup = {
  key: string;
  supplier: string;
  orders: OrderView[];
  awaitingDelivery: number;
  outstanding: number;
  value: number;
  receipts: number;
  pendingReceipts: number;
  overdue: number;
};

function group(orders: OrderView[]): SupplierGroup[] {
  const map = new Map<string, SupplierGroup>();
  for (const order of orders) {
    if (order.stage === "cancelled" || order.stage === "awaiting_approval") continue;
    const key = String(order.raw["supplier_id"] ?? order.supplier);
    const entry =
      map.get(key) ??
      ({
        key,
        supplier: order.supplier,
        orders: [],
        awaitingDelivery: 0,
        outstanding: 0,
        value: 0,
        receipts: 0,
        pendingReceipts: 0,
        overdue: 0,
      } satisfies SupplierGroup);
    entry.orders.push(order);
    entry.value += order.total;
    const posted = order.receipts.filter((receipt) => receipt["status"] === "posted").length;
    entry.receipts += posted;
    entry.pendingReceipts += order.receipts.length - posted;
    if (order.stage === "open" || order.stage === "partly_received") {
      entry.awaitingDelivery += 1;
      entry.outstanding += order.outstanding;
      if (order.overdue) entry.overdue += 1;
    }
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => b.awaitingDelivery - a.awaitingDelivery || a.supplier.localeCompare(b.supplier));
}

function SupplierPortalPage() {
  const { tenant } = useTenant();
  const symbol = tenant.regional.currencySymbol;
  const { activeBranch } = useBranchScope();
  const board = usePurchaseOrderBoard();
  const [openSupplier, setOpenSupplier] = useState<string | null>(null);

  const groups = useMemo(() => group(board.data ?? []), [board.data]);

  // A supplier is only "live" while something is still owed to us. Fully
  // delivered order history stays on the board but is not counted as live.
  const totals = groups.reduce(
    (acc, g) => ({
      suppliers: acc.suppliers + (g.awaitingDelivery > 0 ? 1 : 0),
      awaiting: acc.awaiting + g.awaitingDelivery,
      overdue: acc.overdue + g.overdue,
      receipts: acc.receipts + g.receipts,
    }),
    { suppliers: 0, awaiting: 0, overdue: 0, receipts: 0 },
  );

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Users}
        eyebrow="Procurement"
        title="Supplier portal"
        description={
          activeBranch
            ? `Approved orders, pending deliveries and goods receipts for ${activeBranch.name}.`
            : "Approved orders, pending deliveries and goods receipts across every property."
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/procurement/orders">Purchase orders</Link>
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Suppliers with live orders" value={String(totals.suppliers)} icon={Users} lead />
        <StatCard label="Deliveries pending" value={String(totals.awaiting)} icon={Truck} />
        <StatCard
          label="Past the promised date"
          value={String(totals.overdue)}
          tone={totals.overdue > 0 ? "warning" : "default"}
        />
        <StatCard label="Goods receipts posted" value={String(totals.receipts)} icon={PackageCheck} />
      </div>

      <SectionCard title="Order book by supplier" description="Open an order to follow up on deliveries and receipts.">
        <QueryState
          query={board}
          isLoading={board.isLoading}
          error={board.error}
          isEmpty={groups.length === 0}
          empty="No approved purchase orders in this property yet."
        >
          {groups.length === 0 ? (
            <EmptyState title="No approved orders" description="Approved purchase orders will appear here for each supplier." />
          ) : (
            <div className="space-y-3">
              {groups.map((g) => (
                <div key={g.key} className="rounded-lg border">
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left"
                    aria-expanded={openSupplier === g.key}
                    onClick={() => setOpenSupplier(openSupplier === g.key ? null : g.key)}
                  >
                    <div>
                      <p className="font-medium">{g.supplier}</p>
                      <p className="text-sm text-muted-foreground">
                        {g.orders.length} order{g.orders.length === 1 ? "" : "s"} · {qty(g.outstanding)} units still owed
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {g.overdue > 0 ? <StatusPill tone="warning">{g.overdue} late</StatusPill> : null}
                      {g.pendingReceipts > 0 ? <StatusPill tone="warning">{g.pendingReceipts} receipts awaiting posting</StatusPill> : null}
                      <StatusPill tone={g.awaitingDelivery > 0 ? "info" : "success"}>
                        {g.awaitingDelivery > 0 ? `${g.awaitingDelivery} pending` : "All delivered"}
                      </StatusPill>
                      <span className="text-sm tabular-nums text-muted-foreground">{formatMoney(g.value, symbol)}</span>
                    </div>
                  </button>

                  {openSupplier === g.key ? (
                    <div className="border-t px-4 py-3">
                      <TableScroll>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Order</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead>Expected</TableHead>
                              <TableHead className="text-right">Ordered</TableHead>
                              <TableHead className="text-right">Delivered</TableHead>
                              <TableHead className="text-right">Owed</TableHead>
                              <TableHead>Goods receipts</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {g.orders.map((o) => (
                              <TableRow key={o.id}>
                                <TableCell className="font-medium">
                                  <Link to="/procurement/orders" search={{ order: o.id }} className="text-primary underline underline-offset-2">{o.number}</Link>
                                </TableCell>
                                <TableCell>
                                  <StatusPill tone={statusTone(o.status)}>{titleCase(o.status)}</StatusPill>
                                </TableCell>
                                <TableCell className={o.overdue ? "text-destructive" : undefined}>
                                  {o.expected ? new Date(o.expected).toLocaleDateString() : "—"}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">{qty(o.ordered)}</TableCell>
                                <TableCell className="text-right tabular-nums">{qty(o.received)}</TableCell>
                                <TableCell className="text-right tabular-nums">{qty(o.outstanding)}</TableCell>
                                <TableCell className="space-x-1">
                                  {o.receipts.length === 0 ? (
                                    <span className="text-sm text-muted-foreground">None yet</span>
                                  ) : (
                                    o.receipts.map((r: Row) => (
                                      <StatusPill key={String(r["id"])} tone={statusTone(String(r["status"] ?? ""))}>
                                        {String(r["grn_number"] ?? "GRN")}
                                        {" · "}{titleCase(String(r["status"] ?? "status unavailable"))}
                                      </StatusPill>
                                    ))
                                  )}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </TableScroll>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </QueryState>
      </SectionCard>
    </div>
  );
}
