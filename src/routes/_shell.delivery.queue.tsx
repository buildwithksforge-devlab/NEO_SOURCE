/**
 * Delivery queue — the one screen dispatch works from while orders are waiting
 * for someone to carry them. Assignment and billing are both database actions;
 * this page only shows what is waiting and who may take it.
 */
import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Bike, KeyRound, ReceiptText, Wallet } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import { EmptyState, OpsGuard, QueryState } from "@/components/operations/OpsShared";
import { AssignRiderDialog } from "@/components/delivery/AssignRiderDialog";
import { DeliveryPaymentDialog } from "@/components/delivery/DeliveryPaymentDialog";
import { DeliveryPinDialog } from "@/components/delivery/DeliveryPinPanel";
import { Button } from "@/components/ui/button";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import {
  deliveryStageLabel,
  money,
  orderStatusTone,
  resolveDeliveryStage,
  shortDateTime,
  titleCase,
  type DeliveryStageInput,
} from "@/lib/delivery";
import {
  useBillDeliveryOrder,
  useDeliveryStageRealtime,
  useStaffDeliveryOrders,
} from "@/lib/delivery-data";

export const Route = createFileRoute("/_shell/delivery/queue")({
  head: () => ({
    meta: [
      { title: "Delivery Queue — NEØ Hospitality OS" },
      {
        name: "description",
        content: "Deliveries waiting for a rider, with assignment and invoicing in one place.",
      },
      { property: "og:title", content: "Delivery Queue — NEØ Hospitality OS" },
      {
        property: "og:description",
        content: "Deliveries waiting for a rider, with assignment and invoicing in one place.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

type Row = Record<string, unknown>;

function Page() {
  const { branchId } = useActivePropertyFilter();
  const orders = useStaffDeliveryOrders({ branchId });
  const bill = useBillDeliveryOrder();
  useDeliveryStageRealtime();
  const [assignFor, setAssignFor] = useState<Row | null>(null);
  const [payFor, setPayFor] = useState<Row | null>(null);
  const [pinFor, setPinFor] = useState<Row | null>(null);

  const rows = (orders.data ?? []) as Row[];
  // Same stage calculation as the delivery dashboard and the rider app.
  const stageOf = (o: Row) => resolveDeliveryStage(o as DeliveryStageInput);
  // "Ready or cooking, nobody carrying" — an order still in the kitchen needs a
  // rider lined up too. Collections are excluded: nobody carries those.
  const waiting = useMemo(
    () =>
      rows.filter(
        (o) =>
          ["awaiting-rider", "kitchen"].includes(stageOf(o)) &&
          String(o["fulfilment_type"] ?? "delivery") !== "pickup",
      ),
    [rows],
  );
  const withRider = useMemo(
    () => rows.filter((o) => ["with-rider", "in-flight"].includes(stageOf(o))),
    [rows],
  );
  const finished = useMemo(() => rows.filter((o) => stageOf(o) === "closed"), [rows]);

  const lead: SummaryFigure = {
    id: "waiting",
    label: "Waiting for a rider",
    value: String(waiting.length),
    hint: "ready or cooking, nobody carrying",
    tone: waiting.length ? "warning" : "success",
  };
  const figures: SummaryFigure[] = [
    { id: "with-rider", label: "With a rider", value: String(withRider.length), hint: "on the way" },
    { id: "delivered", label: "Delivered", value: String(finished.length), hint: "ready to bill" },
  ];

  const line = (order: Row, action: "assign" | "bill" | null) => (
    <li
      key={String(order["id"])}
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">
          {String(order["order_number"] ?? "—")}
          <span className="ml-2 text-xs text-muted-foreground">
            {money(Number(order["grand_total"] ?? 0), String(order["currency"] ?? "KES"))}
          </span>
        </p>
        <p className="text-xs text-muted-foreground">
          {titleCase(String(order["payment_method"] ?? "unspecified"))} ·{" "}
          {titleCase(String(order["payment_status"] ?? "unknown"))} · {shortDateTime(String(order["created_at"] ?? ""))}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <StatusPill tone={mapTone(orderStatusTone(String(order["order_status"] ?? "")))}>
          {deliveryStageLabel(stageOf(order))}
        </StatusPill>
        {action === "assign" ? (
          <Button size="sm" variant="outline" onClick={() => setAssignFor(order)}>
            <Bike className="mr-1.5 size-3.5" /> Assign rider
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => setPinFor(order)}>
          <KeyRound className="mr-1.5 size-3.5" /> PIN
        </Button>
        {action === "bill" ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPayFor(order)}
          >
            <Wallet className="mr-1.5 size-3.5" /> Record money
          </Button>
        ) : null}
        {action === "bill" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={bill.isPending}
            onClick={() => bill.mutate({ orderId: String(order["id"]) })}
          >
            <ReceiptText className="mr-1.5 size-3.5" />
            {bill.isPending ? "Billing…" : "Raise invoice"}
          </Button>
        ) : null}
      </div>
    </li>
  );

  return (
    <OpsGuard module="delivery">
      <div className="space-y-5">
        <PageHeader
          title="Delivery queue"
          description="Deliveries waiting to be carried, who has them now, and what still needs invoicing."
        />
        <SummaryStrip lead={lead} figures={figures} />

        <QueryState
          isLoading={orders.isLoading}
          error={orders.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No delivery orders"
              description="Delivery orders for this property appear here as soon as they are placed."
              icon={Bike}
            />
          }
        >
          <SectionCard title="Waiting for a rider" description="Nobody is carrying these yet.">
            {waiting.length === 0 ? (
              <EmptyState title="Nothing waiting" description="Every ready order already has a rider." />
            ) : (
              <ul className="space-y-2">{waiting.map((o) => line(o, "assign"))}</ul>
            )}
          </SectionCard>

          <SectionCard title="With a rider" description="On the way to the guest.">
            {withRider.length === 0 ? (
              <EmptyState title="No deliveries out" description="No rider is carrying an order right now." />
            ) : (
              <ul className="space-y-2">{withRider.map((o) => line(o, "assign"))}</ul>
            )}
          </SectionCard>

          <SectionCard
            title="Delivered — billing"
            description="Raise the invoice and the matching accounting entry once, from the order's own amounts."
          >
            {finished.length === 0 ? (
              <EmptyState title="Nothing delivered yet" description="Completed deliveries appear here for billing." />
            ) : (
              <ul className="space-y-2">{finished.map((o) => line(o, "bill"))}</ul>
            )}
          </SectionCard>
        </QueryState>

        <DeliveryPaymentDialog
          orderId={payFor ? String(payFor["id"]) : null}
          orderNumber={payFor ? String(payFor["order_number"] ?? "") : null}
          suggestedAmount={payFor ? Number(payFor["grand_total"] ?? 0) : undefined}
          defaultMethod={payFor ? String(payFor["payment_method"] ?? "") : undefined}
          onOpenChange={(open) => {
            if (!open) setPayFor(null);
          }}
        />

        <DeliveryPinDialog
          orderId={pinFor ? String(pinFor["id"]) : null}
          orderNumber={pinFor ? String(pinFor["order_number"] ?? "") : null}
          onOpenChange={(open) => {
            if (!open) setPinFor(null);
          }}
        />

        <AssignRiderDialog
          orderId={assignFor ? String(assignFor["id"]) : null}
          orderNumber={assignFor ? String(assignFor["order_number"] ?? "") : null}
          currentRiderId={(assignFor?.["rider_id"] as string | null) ?? null}
          onOpenChange={(open) => {
            if (!open) setAssignFor(null);
          }}
        />
      </div>
    </OpsGuard>
  );
}

/** The shared pill uses a slightly different tone vocabulary. */
function mapTone(tone: string): "default" | "success" | "warning" | "info" | "destructive" {
  return tone === "neutral" ? "default" : (tone as "success" | "warning" | "info" | "destructive");
}
