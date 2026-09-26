import { Fragment, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ReceiptText } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader, SectionCard, TableScroll } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, OrderStatusBadge, PosGuard, QueryState } from "@/components/pos/PosShared";
import { RecordDialog } from "./_shell.pos.floor";
import { MANUAL_ORDER_TYPES, ORDER_TYPES, money, titleCase } from "@/lib/pos";
import { useCreateOrder, usePosOrders, useRestaurantTables } from "@/lib/pos-data";

export const Route = createFileRoute("/_shell/pos/orders/")({
  head: () => ({
    meta: [
      { title: "Orders & Bills — NEØ" },
      {
        name: "description",
        content:
          "Every dine-in, takeaway, room service, delivery and catering order with its live settlement state.",
      },
      { property: "og:title", content: "Orders & Bills — NEØ" },
      {
        property: "og:description",
        content:
          "Every dine-in, takeaway, room service, delivery and catering order with its live settlement state.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PosGuard action="orders.view" path="/pos/orders">
      <OrdersPage />
    </PosGuard>
  ),
});

function OrdersPage() {
  const navigate = useNavigate();
  const [scope, setScope] = useState<"open" | "all">("open");
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState<string>("all");
  const [newOrder, setNewOrder] = useState(false);
  const orders = usePosOrders(scope);
  const tables = useRestaurantTables();
  const createOrder = useCreateOrder();

  const q = search.trim().toLowerCase();
  const scoped = orders.data ?? [];

  /** Where the order came from is the first question on a busy service. */
  const channelCounts = new Map<string, number>();
  const channelValue = new Map<string, number>();
  for (const o of scoped) {
    channelCounts.set(o.order_type, (channelCounts.get(o.order_type) ?? 0) + 1);
    channelValue.set(o.order_type, (channelValue.get(o.order_type) ?? 0) + Number(o.grand_total));
  }

  const rows = scoped.filter(
    (o) =>
      (channel === "all" || o.order_type === channel) &&
      (!q ||
      o.order_number.toLowerCase().includes(q) ||
      (o.guest_name ?? "").toLowerCase().includes(q) ||
      (o.customers?.full_name ?? "").toLowerCase().includes(q) ||
      (o.restaurant_tables?.code ?? "").toLowerCase().includes(q)),
  );

  /** Orders read by origin: one band per channel, each with its own value. */
  const groups = [
    ...rows
      .reduce((map, o) => {
        const bucket = map.get(o.order_type);
        if (bucket) bucket.push(o);
        else map.set(o.order_type, [o]);
        return map;
      }, new Map<string, typeof rows>())
      .entries(),
  ].sort(([a], [b]) => a.localeCompare(b));

  return (
    <div>
      <PageHeader
        eyebrow="Restaurant & POS"
        title="Orders & Bills"
        description="One order record per bill, from first item to settlement, with a full status history behind it."
        actions={<Button onClick={() => setNewOrder(true)}>New order</Button>}
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <Select value={scope} onValueChange={(v) => setScope(v as "open" | "all")}>
          <SelectTrigger className="w-48" aria-label="Order scope">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open orders</SelectItem>
            <SelectItem value="all">All orders</SelectItem>
          </SelectContent>
        </Select>
        <Input
          className="w-64"
          placeholder="Search order, guest or table"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5">
        <ChannelChip
          label="All channels"
          count={scoped.length}
          total={scoped.reduce((sum, o) => sum + Number(o.grand_total), 0)}
          active={channel === "all"}
          onSelect={() => setChannel("all")}
        />
        {ORDER_TYPES.filter((t) => (channelCounts.get(t) ?? 0) > 0).map((t) => (
          <ChannelChip
            key={t}
            label={titleCase(t)}
            count={channelCounts.get(t) ?? 0}
            total={channelValue.get(t) ?? 0}
            active={channel === t}
            onSelect={() => setChannel(channel === t ? "all" : t)}
          />
        ))}
      </div>

      <SectionCard title="Orders" description="Select an order to open the service terminal.">
        <QueryState
          isLoading={orders.isLoading}
          error={orders.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              icon={ReceiptText}
              title="No orders yet"
              description="Orders appear here as soon as they are opened on the floor, at the bar, or through room service."
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
                  <TableHead>Opened</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map(([type, list]) => (
                  <Fragment key={type}>
                    {/* Category band: managers read origin, volume and value first. */}
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={6} className="bg-muted/50 py-2">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="text-xs font-semibold uppercase tracking-[0.14em]">
                            {titleCase(type)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {list.length} order(s) ·{" "}
                            <span className="font-semibold tabular-nums text-foreground">
                              {money(list.reduce((sum, o) => sum + Number(o.grand_total), 0))}
                            </span>
                          </span>
                        </div>
                      </TableCell>
                    </TableRow>
                    {list.map((o) => (
                      <TableRow
                        key={o.id}
                        onClick={() => navigate({ to: "/pos/orders/$id", params: { id: o.id } })}
                        className="cursor-pointer"
                      >
                        <TableCell className="font-mono text-xs">
                          <Link
                            to="/pos/orders/$id"
                            params={{ id: o.id }}
                            className="font-semibold text-primary hover:underline"
                          >
                            {o.order_number}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                            {titleCase(o.order_type)}
                          </span>
                        </TableCell>
                        <TableCell>
                          {o.restaurant_tables?.code ??
                            o.guest_name ??
                            o.customers?.full_name ??
                            "Walk-in"}
                        </TableCell>
                        <TableCell>{new Date(o.created_at).toLocaleString()}</TableCell>
                        <TableCell>
                          <OrderStatusBadge status={o.status} />
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {money(o.grand_total)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </SectionCard>

      <RecordDialog
        open={newOrder}
        onOpenChange={setNewOrder}
        title="New order"
        fields={[
          { name: "guest_name", label: "Guest name (optional)" },
          { name: "guest_phone", label: "Guest phone (optional)" },
          { name: "guest_count", label: "Guests", type: "number" },
        ]}
        selects={[
          {
            name: "order_type",
            label: "Order type",
            options: MANUAL_ORDER_TYPES.map((t) => ({ value: t, label: titleCase(t) })),
          },
          {
            name: "table_id",
            label: "Table (dine-in)",
            options: (tables.data ?? []).map((t) => ({ value: t.id, label: t.code })),
          },
        ]}
        onSubmit={(values) => {
          void createOrder
            .mutateAsync({
              order_type: values["order_type"] ?? "dine-in",
              table_id: values["table_id"] ?? null,
              guest_name: values["guest_name"] ?? null,
              contact_phone: values["guest_phone"] ?? null,
              guest_count: Number(values["guest_count"] ?? 1) || 1,
            })
            .then((order) => navigate({ to: "/pos/orders/$id", params: { id: order.id } }));
        }}
      />
    </div>
  );
}

/** One order channel: dine-in, takeaway, room service, delivery, catering. */
function ChannelChip({
  label,
  count,
  total,
  active,
  onSelect,
}: {
  label: string;
  count: number;
  total: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-touch-target
      aria-pressed={active}
      onClick={onSelect}
      className={cn(
        "inline-flex min-h-11 items-center gap-2 rounded-full border px-3.5 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-primary/50 bg-chip-selected text-foreground"
          : "border-outline-subtle text-muted-foreground hover:bg-muted/50",
      )}
    >
      <span>{label}</span>
      <span className="rounded-full bg-muted px-1.5 tabular-nums">{count}</span>
      <span className="tabular-nums opacity-70">{money(total)}</span>
    </button>
  );
}
