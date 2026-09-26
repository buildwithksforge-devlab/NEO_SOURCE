import { useMemo, useState } from "react";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { ReceiveStockDialog } from "@/components/inventory/ReceiveStockDialog";
import { ReceiptFinanceTrail } from "@/components/inventory/ReceiptFinanceTrail";
import { createFileRoute } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import { PackageCheck } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { QueryState } from "@/components/pms/PmsShared";
import { ReconciliationPanel } from "@/components/common/ReconciliationPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { DeliveryReconciliationPanel } from "@/components/inventory/DeliveryReconciliationPanel";
import { reconcileDelivery, useLedgerOnHand } from "@/lib/delivery-reconciliation";
import { useProcurementReconciliation } from "@/lib/ops-reconciliation";
import { useStockLocations } from "@/lib/inventory-data";
import { formatMoney, statusTone, titleCase, type Row } from "@/lib/inventory";
import { useTenant } from "@/lib/tenant";
import {
  newAttemptKey,
  outstandingOf,
  useReceivableOrders,
  useReceiveGoods,
} from "@/lib/stores-lifecycle";

export const Route = createFileRoute("/_shell/inventory/receiving")({
  head: () => ({
    meta: [
      { title: "Goods receiving — NEØ" },
      {
        name: "description",
        content:
          "Receive supplier deliveries against their purchase order, in full or in part, and post them into stock exactly once.",
      },
      { property: "og:title", content: "Goods receiving — NEØ" },
      {
        property: "og:description",
        content:
          "Receive supplier deliveries against their purchase order, in full or in part, and post them into stock exactly once.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

function Page() {
  const { tenant } = useTenant();
  const symbol = tenant.regional.currencySymbol;
  const { branchId } = useActivePropertyFilter();
  const orders = useReceivableOrders();
  const locations = useStockLocations();
  const receive = useReceiveGoods();
  const health = useProcurementReconciliation(branchId);
  const [directOpen, setDirectOpen] = useState(false);

  const [openOrder, setOpenOrder] = useState<string | null>(null);
  const [locationId, setLocationId] = useState("");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [batches, setBatches] = useState<Record<string, string>>({});
  const [expiries, setExpiries] = useState<Record<string, string>>({});
  const [lineReasons, setLineReasons] = useState<Record<string, string>>({});
  const [rejected, setRejected] = useState<Record<string, string>>({});
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({});
  const [deliveryNote, setDeliveryNote] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [attemptKey, setAttemptKey] = useState(newAttemptKey);
  const [varianceAcknowledged, setVarianceAcknowledged] = useState(false);

  const orderRows = (orders.data ?? []) as Row[];
  const locationRows = (locations.data ?? []) as Row[];
  const active = orderRows.find((o) => String(o["id"]) === openOrder) ?? null;
  const lines = ((active?.["purchase_order_lines"] as Row[] | undefined) ?? []).slice();

  const itemIds = useMemo(
    () =>
      Array.from(
        new Set(
          lines
            .map((l) => (l["stock_item_id"] ? String(l["stock_item_id"]) : ""))
            .filter((id) => id.length > 0),
        ),
      ),
    [lines],
  );
  const ledger = useLedgerOnHand(itemIds, locationId || null);
  const reconciliation = useMemo(
    () => reconcileDelivery(lines, quantities, rejected, ledger.data),
    [lines, quantities, rejected, ledger.data],
  );
  const blockedByVariance = reconciliation.hasExceptions && !varianceAcknowledged;


  const overLines = useMemo(
    () =>
      lines
        .filter((l) => Number(quantities[String(l["id"])] ?? 0) > outstandingOf(l) + 0.0001)
        .map((l) => String(l["id"])),
    [lines, quantities],
  );
  const missingReason = overLines.some((id) => (lineReasons[id] ?? "").trim().length === 0);
  // Anything turned away at the gate has to say why, otherwise the supplier
  // dispute later has nothing behind it.
  const missingRejectReason = lines.some(
    (l) =>
      Number(rejected[String(l["id"])] ?? 0) > 0 &&
      (rejectReasons[String(l["id"])] ?? "").trim().length === 0,
  );
  const badSplit = lines.some(
    (l) =>
      Number(rejected[String(l["id"])] ?? 0) > Number(quantities[String(l["id"])] ?? 0) + 0.0001,
  );

  function acceptedOf(id: string) {
    return Math.max(Number(quantities[id] ?? 0) - Number(rejected[id] ?? 0), 0);
  }

  function start(order: Row) {
    setOpenOrder(String(order["id"]));
    setLocationId(String(order["deliver_to_location_id"] ?? ""));
    setQuantities({});
    setNotes("");
    setBatches({});
    setExpiries({});
    setLineReasons({});
    setRejected({});
    setRejectReasons({});
    setDeliveryNote("");
    setInvoiceNumber("");
    setAttemptKey(newAttemptKey());
    setVarianceAcknowledged(false);
  }

  function submit() {
    if (!active) return;
    const payload = lines
      .map((l) => {
        const id = String(l["id"]);
        const reason = (lineReasons[id] ?? "").trim();
        const rejectQty = Number(rejected[id] ?? 0);
        const rejectReason = (rejectReasons[id] ?? "").trim();
        return {
          order_line_id: id,
          quantity_received: Number(quantities[id] ?? 0),
          ...(rejectQty > 0 ? { quantity_rejected: rejectQty } : {}),
          ...(rejectQty > 0 && rejectReason ? { rejection_reason: rejectReason } : {}),
          ...(batches[id]?.trim() ? { batch_number: batches[id]!.trim() } : {}),
          ...(expiries[id] ? { expiry_date: expiries[id]! } : {}),
          ...(reason ? { over_receipt_reason: reason } : {}),
        };
      })
      .filter((l) => l.quantity_received > 0);
    if (payload.length === 0) return;
    // The browser never decides whether an over-receipt is permitted; it only
    // carries the line reason the database requires before it checks authority.
    const input = { orderId: String(active["id"]), locationId, lines: payload, attemptKey };
    receive.mutate(
      {
        ...input,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(deliveryNote.trim() ? { deliveryNoteNumber: deliveryNote.trim() } : {}),
        ...(invoiceNumber.trim() ? { supplierInvoiceNumber: invoiceNumber.trim() } : {}),
      },
      { onSuccess: () => setOpenOrder(null) },
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Supply Chain"
        title="Goods receiving"
        description="Count the delivery against the order. Partial deliveries are normal; receiving more than was ordered needs both a written reason and over-receipt authority."
        actions={
          <Button variant="outline" onClick={() => setDirectOpen(true)}>
            Direct / opening receipt
          </Button>
        }
      />

      <ReceiveStockDialog open={directOpen} onOpenChange={setDirectOpen} />

      <ReceiptFinanceTrail symbol={symbol} />


      <QueryState
        isLoading={orders.isLoading}
        error={orders.error}
        isEmpty={orderRows.length === 0}
        empty={
          <SectionCard
            title="Nothing to receive"
            description="Approved purchase orders appear here as soon as a buyer issues them."
          >
            <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <PackageCheck className="h-4 w-4" /> No open orders for this property.
            </p>
          </SectionCard>
        }
      >
        <SectionCard
          title="Open purchase orders"
          description="Choose the order the delivery belongs to."
        >
          <ul className="divide-y divide-border">
            {orderRows.map((o) => (
              <li
                key={String(o["id"])}
                className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
              >
                <div>
                  <p className="font-medium">{String(o["order_number"] ?? "Purchase order")}</p>
                  <p className="text-xs text-muted-foreground">
                    {`${(o["suppliers"] as Row | null)?.["name"] ?? "Supplier"} · ${formatMoney(o["total_amount"], symbol)}`}
                    {o["expected_date"] ? ` · expected ${String(o["expected_date"])}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill tone={statusTone(String(o["status"] ?? ""))}>
                    {titleCase(String(o["status"] ?? ""))}
                  </StatusPill>
                  <Button
                    size="sm"
                    variant={openOrder === String(o["id"]) ? "secondary" : "default"}
                    onClick={() => start(o)}
                  >
                    Receive delivery
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
      </QueryState>

      {active ? (
        <SectionCard
          title={`Receive against ${String(active["order_number"] ?? "order")}`}
          description="Enter what physically arrived. Blank or zero lines are simply not received yet."
        >
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Receiving store</Label>
                <Select value={locationId} onValueChange={setLocationId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Where is it being stored?" />
                  </SelectTrigger>
                  <SelectContent>
                    {locationRows.map((l) => (
                      <SelectItem key={String(l["id"])} value={String(l["id"])}>
                        {String(l["name"])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="grn-note-number">Supplier delivery note no.</Label>
                <Input
                  id="grn-note-number"
                  value={deliveryNote}
                  onChange={(e) => setDeliveryNote(e.target.value)}
                  placeholder="As printed on the delivery note"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="grn-invoice">Supplier invoice no.</Label>
                <Input
                  id="grn-invoice"
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                  placeholder="If the invoice came with the goods"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="grn-notes">Receiving remarks</Label>
                <Input
                  id="grn-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Driver, vehicle, condition on arrival…"
                />
              </div>
            </div>

            <ul className="divide-y divide-border">
              {lines.map((l) => {
                const outstanding = outstandingOf(l);
                const id = String(l["id"]);
                const over = overLines.includes(id);
                return (
                  <li key={id} className="space-y-2 py-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="font-medium">
                          {String(
                            (l["stock_items"] as Row | null)?.["name"] ??
                              l["description"] ??
                              "Item",
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {`Ordered ${Number(l["quantity"] ?? 0)} ${String(l["unit"] ?? "")} · already received ${Number(l["received_quantity"] ?? 0)} · outstanding ${outstanding}`}
                        </p>
                      </div>
                      <div className="flex items-end gap-2">
                        <div className="space-y-1">
                          <Label className="text-xs" htmlFor={`recv-${id}`}>
                            Delivered
                          </Label>
                          <Input
                            id={`recv-${id}`}
                            className="w-28"
                            type="number"
                            min={0}
                            step="0.01"
                            value={quantities[id] ?? ""}
                            onChange={(e) => setQuantities((q) => ({ ...q, [id]: e.target.value }))}
                            placeholder="0"
                            aria-label={`Quantity delivered for ${String((l["stock_items"] as Row | null)?.["name"] ?? "item")}`}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs" htmlFor={`rej-${id}`}>
                            Rejected
                          </Label>
                          <Input
                            id={`rej-${id}`}
                            className="w-28"
                            type="number"
                            min={0}
                            step="0.01"
                            value={rejected[id] ?? ""}
                            onChange={(e) => setRejected((r) => ({ ...r, [id]: e.target.value }))}
                            placeholder="0"
                            aria-label={`Quantity rejected for ${String((l["stock_items"] as Row | null)?.["name"] ?? "item")}`}
                          />
                        </div>
                        <p className="pb-2 text-xs text-muted-foreground">
                          {`Accepted into stock: ${acceptedOf(id)}`}
                        </p>
                      </div>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Input
                        value={batches[id] ?? ""}
                        onChange={(e) => setBatches((b) => ({ ...b, [id]: e.target.value }))}
                        placeholder="Batch / lot number"
                        aria-label={`Batch number for ${String((l["stock_items"] as Row | null)?.["name"] ?? "item")}`}
                      />
                      <NeoDatePicker
                        value={expiries[id] ?? ""}
                        onChange={(v) => setExpiries((x) => ({ ...x, [id]: v }))}
                        ariaLabel={`Expiry date for ${String((l["stock_items"] as Row | null)?.["name"] ?? "item")}`}
                      />
                    </div>
                    {Number(rejected[id] ?? 0) > 0 ? (
                      <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                        <Label htmlFor={`rej-reason-${id}`}>
                          Why was part of this line rejected?
                        </Label>
                        <Textarea
                          id={`rej-reason-${id}`}
                          value={rejectReasons[id] ?? ""}
                          onChange={(e) =>
                            setRejectReasons((r) => ({ ...r, [id]: e.target.value }))
                          }
                          placeholder="Damaged, short-dated, wrong specification…"
                        />
                        {Number(rejected[id] ?? 0) > Number(quantities[id] ?? 0) + 0.0001 ? (
                          <p className="text-xs text-destructive">
                            You cannot reject more than was delivered on this line.
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            Only the accepted quantity is posted into stock; the rejection stays on
                            the receipt.
                          </p>
                        )}
                      </div>
                    ) : null}
                    {over ? (
                      <div className="space-y-1 rounded-md border border-warning/40 bg-warning/5 p-3">
                        <Label htmlFor={`over-${id}`}>Over-receipt reason for this line</Label>
                        <Textarea
                          id={`over-${id}`}
                          value={lineReasons[id] ?? ""}
                          onChange={(e) => setLineReasons((r) => ({ ...r, [id]: e.target.value }))}
                          placeholder={`Only ${outstanding} outstanding — explain why more is being accepted.`}
                        />
                        <p className="text-xs text-muted-foreground">
                          Written to the audit trail and refused unless you hold over-receipt
                          authority.
                        </p>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            <DeliveryReconciliationPanel
              reconciliation={reconciliation}
              ledgerReady={Boolean(locationId) && !ledger.isLoading && !ledger.error}
              acknowledged={varianceAcknowledged}
              onAcknowledgedChange={setVarianceAcknowledged}
            />

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpenOrder(null)}>
                Cancel
              </Button>
              <Button
                disabled={
                  !locationId ||
                  receive.isPending ||
                  missingReason ||
                  missingRejectReason ||
                  badSplit ||
                  blockedByVariance ||
                  lines.every((l) => Number(quantities[String(l["id"])] ?? 0) <= 0)
                }
                onClick={submit}
              >
                Post receipt to stock
              </Button>
            </div>
          </div>
        </SectionCard>
      ) : null}

      <ReconciliationPanel
        title="Receiving and stock integrity"
        description="Ordered against received against stock on hand, computed in the database within your property scope."
        report={health.data}
        isLoading={health.isLoading}
        error={health.error}
      />
    </div>
  );
}

// Every Supply Chain screen writes to stock, money or supplier records, so the
// page itself asks for the capability its route declares — never the shell.
function GuardedPage() {
  return (
    <OpsGuard path="/inventory/receiving">
      <Page />
    </OpsGuard>
  );
}
