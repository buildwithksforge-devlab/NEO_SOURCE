/**
 * The kitchen dashboard.
 *
 * One screen for the kitchen's own position: ingredient stock by store, the
 * day's recorded sales, the ticket load, and a reorder alert listing items at
 * or below their reorder point with the requisitions and expected deliveries
 * already raised against them.
 *
 * Every figure comes from a record: the ledger-backed stock board, the
 * canonical fact layer and the kitchen's own ticket counts. Where an item has
 * no reorder point configured, it is reported as unconfigured rather than
 * assumed safe.
 */
import { useMemo } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, PackageSearch, Truck } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import { EmptyState, KitchenGuard, QueryState } from "@/components/kitchen/KitchenShared";
import { MoneyValue } from "@/components/common/MoneyValue";
import { useKitchenMetrics } from "@/lib/kitchen-data";
import {
  useLiveStockBoard,
  usePurchaseOrders,
  usePurchaseRequests,
  type LiveStockItem,
} from "@/lib/inventory-data";
import { useFacts, factValue, factsMonetaryAuthorised } from "@/lib/facts";
import { useFinanceCtx } from "@/lib/finance-data";
import type { Row } from "@/lib/kitchen";

export const Route = createFileRoute("/_shell/kitchen/dashboard")({
  head: () => ({
    meta: [
      { title: "Kitchen dashboard — NEØ" },
      {
        name: "description",
        content:
          "Ingredient stock by store, the day's recorded sales, ticket load and reorder alerts with the requisitions and deliveries raised against them.",
      },
      { property: "og:title", content: "Kitchen dashboard — NEØ" },
      {
        property: "og:description",
        content: "Kitchen stock, sales, ticket load and reorder alerts from recorded data only.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <KitchenGuard action="access">
      <KitchenDashboard />
    </KitchenGuard>
  ),
});

type AlertRow = LiveStockItem & {
  storeName: string;
  configured: boolean;
  shortfall: number;
};

const todayStart = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

function KitchenDashboard() {
  const { branchId } = useFinanceCtx();
  const start = useMemo(todayStart, []);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const board = useLiveStockBoard();
  const metrics = useKitchenMetrics(start.toISOString(), new Date().toISOString());
  const facts = useFacts({ branchId, from: iso(start), to: iso(new Date()) });
  const requests = usePurchaseRequests();
  const orders = usePurchaseOrders();

  const stores = board.data?.stores ?? [];
  const totals = board.data?.totals;

  /** Items at or below their reorder point, and items with no point configured. */
  const alerts = useMemo<AlertRow[]>(() => {
    const rows: AlertRow[] = [];
    for (const store of stores) {
      for (const item of store.items ?? []) {
        const configured = Number(item.reorder_point) > 0;
        if (configured && Number(item.on_hand) > Number(item.reorder_point)) continue;
        if (!configured && Number(item.on_hand) > 0) continue;
        rows.push({
          ...item,
          storeName: store.location_name,
          configured,
          shortfall: configured ? Number(item.reorder_point) - Number(item.on_hand) : 0,
        });
      }
    }
    return rows.sort((a, b) => Number(a.on_hand) - Number(b.on_hand));
  }, [stores]);

  /** Outstanding requisitions per stock item, from the requisition lines themselves. */
  const requisitionsByItem = useMemo(() => {
    const map = new Map<string, string[]>();
    const open = ["draft", "submitted", "pending", "pending_approval", "approved", "ordered"];
    for (const r of (requests.data ?? []) as Row[]) {
      if (!open.includes(String(r["status"] ?? ""))) continue;
      const lines = (r["purchase_request_lines"] ?? []) as Array<Record<string, unknown>>;
      for (const l of lines) {
        const id = String(l["stock_item_id"] ?? "");
        if (!id) continue;
        const list = map.get(id) ?? [];
        list.push(String(r["request_number"] ?? "Requisition"));
        map.set(id, list);
      }
    }
    return map;
  }, [requests.data]);

  const expectedDeliveries = useMemo(() => {
    const open = ["sent", "acknowledged", "confirmed", "partially_received", "in_transit"];
    return ((orders.data ?? []) as Row[])
      .filter((o) => open.includes(String(o["status"] ?? "")))
      .sort((a, b) => String(a["expected_date"] ?? "").localeCompare(String(b["expected_date"] ?? "")));
  }, [orders.data]);

  const sales = factValue(facts.data, "operational.pos_finalised_sales");
  const openValue = factValue(facts.data, "operational.pos_open_value");
  const moneyAllowed = factsMonetaryAuthorised(facts.data);

  const ticketsReceived = Number(metrics.data?.["tickets_received"] ?? 0);
  const inPreparation = Number(metrics.data?.["tickets_in_preparation"] ?? 0);
  const delayed = Number(metrics.data?.["tickets_delayed"] ?? 0);

  const lead: SummaryFigure = {
    id: "alerts",
    label: "Items needing reorder",
    value: String(alerts.length),
    hint:
      alerts.filter((a) => !a.configured).length > 0
        ? `${alerts.filter((a) => !a.configured).length} have no reorder point configured`
        : "Against recorded reorder points",
    tone: alerts.length > 0 ? "warning" : "success",
  };

  const figures: SummaryFigure[] = [
    {
      id: "sales",
      label: "Sales recorded today",
      value: moneyAllowed ? <MoneyValue value={sales} /> : "Withheld",
      hint: moneyAllowed
        ? openValue !== null
          ? `Open in service: ${new Intl.NumberFormat().format(openValue)}`
          : "Finalised orders only"
        : "Your permissions do not include financial figures",
    },
    { id: "tickets", label: "Tickets today", value: String(ticketsReceived), hint: `${inPreparation} in preparation` },
    {
      id: "delayed",
      label: "Past target",
      value: String(delayed),
      tone: delayed > 0 ? "warning" : "default",
      hint: "Tickets beyond their preparation target",
    },
    {
      id: "stores",
      label: "Stores tracked",
      value: String(stores.length),
      hint: totals ? `${totals.out_of_stock} lines out of stock` : "Ledger-backed balances",
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Kitchen dashboard"
        description="Ingredient stock by store, today's recorded sales and ticket load, and the reorder alerts with what has already been raised against them."
      />

      <SummaryStrip lead={lead} figures={figures} />

      <SectionCard
        title="Reorder alert"
        description="Items at or below their recorded reorder point. An item with no reorder point configured is listed as unconfigured — it is never assumed safe."
      >
        <QueryState
          isLoading={board.isLoading}
          error={board.error}
          isEmpty={alerts.length === 0}
          empty={<EmptyState title="Nothing below its reorder point" description="Every tracked item in this property's stores is above its recorded reorder point." />}
        >
          <div className="neo-table-scroll overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  {["Item", "Store", "On hand", "Reorder point", "Short by", "Raised against it"].map((h) => (
                    <th key={h} className="whitespace-nowrap py-2 pr-4 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {alerts.map((a) => {
                  const raised = requisitionsByItem.get(a.stock_item_id) ?? [];
                  return (
                    <tr key={`${a.stock_item_id}-${a.storeName}`} className="align-top">
                      <td className="py-2 pr-4">
                        <div className="font-medium">{a.name}</div>
                        {a.sku ? <div className="text-xs text-muted-foreground">{a.sku}</div> : null}
                      </td>
                      <td className="py-2 pr-4">{a.storeName}</td>
                      <td className="py-2 pr-4 tabular-nums">
                        {a.on_hand} {a.unit ?? ""}
                      </td>
                      <td className="py-2 pr-4 tabular-nums">
                        {a.configured ? (
                          `${a.reorder_point} ${a.unit ?? ""}`
                        ) : (
                          <StatusPill tone="warning">Not configured</StatusPill>
                        )}
                      </td>
                      <td className="py-2 pr-4 tabular-nums">
                        {a.configured ? a.shortfall.toFixed(2) : "—"}
                      </td>
                      <td className="py-2 pr-4">
                        {raised.length > 0 ? (
                          <span className="text-xs">{raised.join(", ")}</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-destructive">
                            <AlertTriangle className="size-3.5" aria-hidden />
                            Nothing raised
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Raise what is missing from{" "}
            <Link to="/kitchen/reorder" className="text-primary underline-offset-4 hover:underline">
              Reorder
            </Link>
            , consolidate it in{" "}
            <Link to="/kitchen/needs" className="text-primary underline-offset-4 hover:underline">
              Stock Needs
            </Link>
            , and correct the physical figures in{" "}
            <Link to="/kitchen/stock-count" className="text-primary underline-offset-4 hover:underline">
              Stock count
            </Link>
            .
          </p>
        </QueryState>
      </SectionCard>

      <SectionCard
        title="Ingredient stock by store"
        description="Ledger-backed balances for every store this property keeps."
      >
        <QueryState
          isLoading={board.isLoading}
          error={board.error}
          isEmpty={stores.length === 0}
          empty={<EmptyState title="No stores recorded" description={
            board.data?.reason ??
            "This property has no stock locations with recorded balances yet."
          } />}
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {stores.map((s) => (
              <div key={s.location_id} className="rounded-xl border border-border/70 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{s.location_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {s.lines} line{s.lines === 1 ? "" : "s"}
                    </p>
                  </div>
                  <PackageSearch className="size-4 text-muted-foreground" aria-hidden />
                </div>
                <dl className="mt-2 space-y-1 text-xs">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Below reorder</dt>
                    <dd className="tabular-nums">{s.below_reorder}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Out of stock</dt>
                    <dd className="tabular-nums">{s.out_of_stock}</dd>
                  </div>
                  {moneyAllowed ? (
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Value</dt>
                      <dd className="tabular-nums">
                        <MoneyValue value={s.value} />
                      </dd>
                    </div>
                  ) : null}
                </dl>
              </div>
            ))}
          </div>
        </QueryState>
      </SectionCard>

      <SectionCard
        title="Expected deliveries"
        description="Purchase orders still open against this property, with the date the supplier is expected."
      >
        <QueryState
          isLoading={orders.isLoading}
          error={orders.error}
          isEmpty={expectedDeliveries.length === 0}
          empty={<EmptyState title="No deliveries outstanding" description="No open purchase order is awaiting delivery for this property." />}
        >
          <ul className="space-y-2">
            {expectedDeliveries.map((o) => (
              <li
                key={String(o["id"])}
                className="flex items-center justify-between gap-3 rounded-lg border border-border/70 px-3 py-2 text-sm"
              >
                <span className="flex items-center gap-2">
                  <Truck className="size-4 text-muted-foreground" aria-hidden />
                  <span className="font-medium">{String(o["order_number"] ?? "—")}</span>
                  <span className="text-muted-foreground">
                    {String((o["suppliers"] as Record<string, unknown> | null)?.["name"] ?? "Supplier not recorded")}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {o["expected_date"] ? String(o["expected_date"]) : "No expected date recorded"}
                </span>
              </li>
            ))}
          </ul>
        </QueryState>
      </SectionCard>
    </div>
  );
}
