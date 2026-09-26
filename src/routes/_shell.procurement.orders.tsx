import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, PackageCheck, ShoppingCart, Truck } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, QueryState } from "@/components/pms/PmsShared";
import { OpsGuard } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import { useTenant } from "@/lib/tenant";
import { formatMoney, statusTone, titleCase, type Row } from "@/lib/inventory";
import { useApproveOrder } from "@/lib/stores-lifecycle";
import { useCloseOrder, usePurchaseOrderBoard, type OrderStage, type OrderView } from "@/lib/procurement-orders";

export const Route = createFileRoute("/_shell/procurement/orders")({
  head: () => ({
    meta: [
      { title: "Purchase orders & receipts — NEØ" },
      {
        name: "description",
        content:
          "Approve purchase orders, follow what suppliers have delivered and post receipts that update stock balances.",
      },
      { property: "og:title", content: "Purchase orders & receipts — NEØ" },
      {
        property: "og:description",
        content:
          "Approve purchase orders, follow what suppliers have delivered and post receipts that update stock balances.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard path="/procurement/orders">
      <OrdersPage />
    </OpsGuard>
  ),
});

const STAGE_LABEL: Record<OrderStage, string> = {
  awaiting_approval: "Awaiting approval",
  open: "Pending delivery",
  partly_received: "Part delivered",
  completed: "Completed",
  cancelled: "Cancelled",
};

const qty = (v: number) => (Math.round(v * 1000) / 1000).toLocaleString();

function OrdersPage() {
  const { tenant } = useTenant();
  const symbol = tenant.regional.currencySymbol;
  const { can } = useAuth();
  const mayApprove = can("procurement", "lpos", "approve");

  const board = usePurchaseOrderBoard();
  const approve = useApproveOrder();
  const close = useCloseOrder();

  const [stage, setStage] = useState<OrderStage>("awaiting_approval");
  const [openId, setOpenId] = useState<string | null>(null);
  const [closeFor, setCloseFor] = useState<OrderView | null>(null);
  const [closeReason, setCloseReason] = useState("");

  const orders = board.data ?? [];
  const byStage = useMemo(() => {
    const map: Record<OrderStage, OrderView[]> = {
      awaiting_approval: [],
      open: [],
      partly_received: [],
      completed: [],
      cancelled: [],
    };
    for (const o of orders) map[o.stage].push(o);
    return map;
  }, [orders]);

  const overdue = orders.filter((o) => o.overdue);
  const committed = orders
    .filter((o) => o.stage === "open" || o.stage === "partly_received")
    .reduce((s, o) => s + o.total, 0);
  const pendingReceipts = orders.flatMap((o) =>
    o.receipts.filter((g) => String(g["status"] ?? "") !== "posted"),
  );

  const visible = byStage[stage];
  const selected = orders.find((o) => o.id === openId) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Supply Chain"
        title="Purchase orders & receipts"
        description="An approved order is what Stores may receive against. Every delivery posted here moves the accepted quantity into the store's stock balance."
        actions={
          <Button variant="outline" asChild>
            <Link to="/inventory/receiving">Receive a delivery</Link>
          </Button>
        }
      />

      <div className="neo-kpi-grid">
        <StatCard
          lead
          label="Awaiting approval"
          value={String(byStage.awaiting_approval.length)}
          hint="Raised from requisitions"
          icon={ShoppingCart}
          tone={byStage.awaiting_approval.length > 0 ? "warning" : "success"}
        />
        <StatCard
          label="Open with suppliers"
          value={String(byStage.open.length + byStage.partly_received.length)}
          hint={`${overdue.length} past their expected date`}
          icon={Truck}
          tone={overdue.length > 0 ? "destructive" : "default"}
        />
        <StatCard
          label="Deliveries not yet in stock"
          value={String(pendingReceipts.length)}
          hint="Goods received notes still to post"
          icon={PackageCheck}
          tone={pendingReceipts.length > 0 ? "warning" : "success"}
        />
        <StatCard
          label="Committed value"
          value={formatMoney(committed, symbol)}
          hint="Ordered and not yet completed"
          icon={CheckCircle2}
        />
      </div>

      <QueryState
        isLoading={board.isLoading}
        error={board.error}
        isEmpty={!board.isLoading && orders.length === 0}
        empty={
          <EmptyState
            icon={ShoppingCart}
            title="No purchase orders yet"
            description="Approve a requisition and raise the order from Purchase requests."
          />
        }
        skeleton="table"
      >
        <Tabs value={stage} onValueChange={(v) => setStage(v as OrderStage)}>
          <TabsList className="mb-4 flex-wrap">
            {(Object.keys(STAGE_LABEL) as OrderStage[]).map((key) => (
              <TabsTrigger key={key} value={key}>
                {`${STAGE_LABEL[key]} (${byStage[key].length})`}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value={stage}>
            <SectionCard
              title={STAGE_LABEL[stage]}
              description="Select an order to see its lines, what has been delivered and what is still outstanding."
            >
              {visible.length === 0 ? (
                <p className="py-6 text-sm text-muted-foreground">Nothing at this stage.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Order</TableHead>
                        <TableHead>Supplier</TableHead>
                        <TableHead>Expected</TableHead>
                        <TableHead className="text-right">Ordered</TableHead>
                        <TableHead className="text-right">Received</TableHead>
                        <TableHead className="text-right">Outstanding</TableHead>
                        <TableHead className="text-right">Value</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visible.map((o) => (
                        <TableRow key={o.id} className={openId === o.id ? "bg-muted/40" : undefined}>
                          <TableCell className="font-mono text-xs">{o.number}</TableCell>
                          <TableCell className="font-medium">{o.supplier}</TableCell>
                          <TableCell>{o.expected ?? "—"}</TableCell>
                          <TableCell className="text-right">{qty(o.ordered)}</TableCell>
                          <TableCell className="text-right">{qty(o.received)}</TableCell>
                          <TableCell className="text-right font-medium">
                            {qty(o.outstanding)}
                          </TableCell>
                          <TableCell className="text-right">
                            {formatMoney(o.total, symbol)}
                          </TableCell>
                          <TableCell>
                            {o.overdue ? (
                              <StatusPill tone="destructive">Overdue</StatusPill>
                            ) : (
                              <StatusPill tone={statusTone(o.status)}>
                                {titleCase(o.status)}
                              </StatusPill>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setOpenId(openId === o.id ? null : o.id)}
                            >
                              {openId === o.id ? "Hide" : "Open"}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </SectionCard>
          </TabsContent>
        </Tabs>
      </QueryState>

      {selected ? (
        <SectionCard
          title={`${selected.number} · ${selected.supplier}`}
          description={
            selected.closeReason
              ? `Closed${selected.closedAt ? ` on ${String(selected.closedAt).slice(0, 10)}` : ""} — ${selected.closeReason}. Any cancelled balance is settled and is not awaiting delivery.`
              : "Ordered against accepted. Only the accepted quantity of a delivery reaches the stock balance."
          }
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {selected.stage === "awaiting_approval" && mayApprove ? (
                <Button
                  size="sm"
                  disabled={approve.isPending}
                  onClick={() => approve.mutate({ orderId: selected.id })}
                >
                  Approve order
                </Button>
              ) : null}
              {selected.stage === "awaiting_approval" && !mayApprove ? (
                <span className="text-xs text-muted-foreground">
                  Awaiting an authorised buyer
                </span>
              ) : null}
              {selected.stage === "open" || selected.stage === "partly_received" ? (
                <Button size="sm" variant="secondary" asChild>
                  <Link to="/inventory/receiving">Receive delivery</Link>
                </Button>
              ) : null}
              {mayApprove && (selected.stage === "open" || selected.stage === "partly_received") ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setCloseFor(selected);
                    setCloseReason("");
                  }}
                >
                  Close short
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" asChild>
                <Link to="/lpos/$id" params={{ id: selected.id }}>
                  Document trail
                </Link>
              </Button>
            </div>
          }
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Ordered</TableHead>
                  <TableHead className="text-right">Accepted</TableHead>
                  <TableHead className="text-right">Cancelled</TableHead>
                  <TableHead className="text-right">Still awaited</TableHead>
                  <TableHead className="text-right">Unit price</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {selected.lines.map((l) => {
                  const ordered = Number(l["quantity"] ?? 0);
                  const accepted = Number(l["accepted_quantity"] ?? l["received_quantity"] ?? 0);
                  const cancelled = Number(l["cancelled_quantity"] ?? 0);
                  const unit = String((l["stock_items"] as Row | null)?.["base_unit"] ?? l["unit"] ?? "");
                  return (
                    <TableRow key={String(l["id"])}>
                      <TableCell className="font-medium">
                        {String((l["stock_items"] as Row | null)?.["name"] ?? l["description"] ?? "Item")}
                        {unit ? (
                          <span className="ml-2 text-xs text-muted-foreground">{`· ${unit}`}</span>
                        ) : null}
                      </TableCell>

                      <TableCell className="text-right">{qty(ordered)}</TableCell>
                      <TableCell className="text-right">{qty(accepted)}</TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {cancelled > 0 ? qty(cancelled) : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {qty(Math.max(ordered - accepted - cancelled, 0))}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatMoney(l["unit_price"], symbol)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <div className="mt-6">
            <h3 className="mb-2 text-sm font-medium">Deliveries received</h3>
            {selected.receipts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No delivery has been booked against this order yet.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {selected.receipts.map((g) => (
                  <li
                    key={String(g["id"])}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                  >
                    <div>
                      <p className="font-medium">{String(g["grn_number"] ?? "Delivery")}</p>
                      <p className="text-xs text-muted-foreground">
                        {`${String(g["received_at"] ?? "").slice(0, 10)} · ${formatMoney(g["total_value"], symbol)}${g["is_partial"] ? " · partial" : ""}`}
                      </p>
                    </div>
                    <StatusPill tone={statusTone(String(g["status"] ?? ""))}>
                      {titleCase(String(g["status"] ?? "draft"))}
                    </StatusPill>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SectionCard>
      ) : null}

      <Dialog open={Boolean(closeFor)} onOpenChange={(open) => !open && setCloseFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close the order short</DialogTitle>
            <DialogDescription>
              {`Everything still outstanding on ${String(closeFor?.number ?? "")} is cancelled. The reason stays with the order.`}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={closeReason}
            onChange={(e) => setCloseReason(e.target.value)}
            placeholder="Supplier cannot deliver the balance, ordered elsewhere…"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCloseFor(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={closeReason.trim().length === 0 || close.isPending}
              onClick={() =>
                close.mutate(
                  { orderId: String(closeFor?.id), reason: closeReason.trim() },
                  { onSuccess: () => setCloseFor(null) },
                )
              }
            >
              Close order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
