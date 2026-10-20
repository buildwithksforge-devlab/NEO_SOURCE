import { ApprovedReceivingPosting } from "@/components/inventory/ApprovedReceivingPosting";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { guardedRpc } from "@/lib/rpc-guard";
import { supabase } from "@/integrations/supabase/client";
import { createFileRoute } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { QueryState } from "@/components/pms/PmsShared";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useReceivableOrders } from "@/lib/stores-lifecycle";
import { NeoDatePicker } from "@/components/common/DatePicker";

type BlindItem = {
  id: string;
  stock_item_id: string | null;
  name: string;
  unit: string;
};

type BlindOrder = {
  id: string;
  order_number: string;
  supplier_name: string;
  branch_id: string;
  deliver_to_location_id: string | null;
  items: BlindItem[];
};

type BlindCountPayload = {
  orderId: string;
  locationId: string;
  deliveryNote: string;
  remarks: string;
  lines: Array<{
    order_line_id: string;
    quantity_delivered: number;
    quantity_rejected: number;
    rejection_reason?: string | undefined;
    batch_number?: string | undefined;
    expiry_date?: string | undefined;
  }>;
};

const db = supabase as any;

export const Route = createFileRoute("/_shell/inventory/receiving")({
  component: GuardedPage,
});

function Page() {
  const orders = useReceivableOrders();
  const queryClient = useQueryClient();

  const submitCount = useMutation({
    mutationFn: async (payload: BlindCountPayload) => {
      const { data, error } = await guardedRpc(
        db,
        "neo_submit_blind_receiving_count",
        {
          _order: payload.orderId,
          _location: payload.locationId,
          _delivery_note: payload.deliveryNote,
          _remarks: payload.remarks,
          _lines: payload.lines,
        },
      );

      if (error) throw new Error(error.message);

      return data;
    },

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["procurement"] });
      toast.success(
        "Blind receiving count submitted. Awaiting reconciliation."
      );
      setPendingConfirmation(null);
      setSelected(null);
    },

    onError: (error: Error) => {
      toast.error(error.message);
    },

    onSettled: () => {
      submittingRef.current = false;
    },
  });

  const [pendingConfirmation, setPendingConfirmation] = useState<{
    payload: BlindCountPayload;
    orderNumber: string;
    supplierName: string;
    summary: string;
  } | null>(null);
  const confirmationRef = useRef<HTMLDialogElement>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    const dialog = confirmationRef.current;
    if (!dialog) return;
    if (pendingConfirmation && !dialog.open) dialog.showModal();
    if (!pendingConfirmation && dialog.open) dialog.close();
  }, [pendingConfirmation]);

  const [selected, setSelected] = useState<string | null>(null);

  const [delivered, setDelivered] = useState<Record<string, string>>({});
  const [rejected, setRejected] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [batches, setBatches] = useState<Record<string, string>>({});
  const [expiries, setExpiries] = useState<Record<string, string>>({});
  const [deliveryNote, setDeliveryNote] = useState("");
  const [remarks, setRemarks] = useState("");

  const rows = (orders.data ?? []) as BlindOrder[];

  const active = rows.find((order) => order.id === selected);

  function openOrder(id: string) {
    if (submittingRef.current) return;
    setPendingConfirmation(null);
    setSelected(id);
    setDelivered({});
    setRejected({});
    setReasons({});
    setBatches({});
    setExpiries({});
    setDeliveryNote("");
    setRemarks("");
  }

  function handleSubmit() {
    if (!active || submittingRef.current || pendingConfirmation) return;

    if (!deliveryNote.trim()) {
      toast.error("Supplier delivery note number is required.");
      return;
    }

    const lines = active.items.map((item) => ({
      order_line_id: item.id,
      quantity_delivered: Number(delivered[item.id] || 0),
      quantity_rejected: Number(rejected[item.id] || 0),
      rejection_reason: reasons[item.id] || undefined,
      batch_number: batches[item.id] || undefined,
      expiry_date: expiries[item.id] || undefined,
    }));

    const invalid = lines.some(
      (line) =>
        !Number.isFinite(line.quantity_delivered) ||
        !Number.isFinite(line.quantity_rejected) ||
        line.quantity_delivered < 0 ||
        line.quantity_rejected < 0 ||
        line.quantity_rejected > line.quantity_delivered ||
        (line.quantity_rejected > 0 && !line.rejection_reason?.trim())
    );

    if (invalid) {
      toast.error("Check delivered and rejected quantities.");
      return;
    }

    if (!lines.some((line) => line.quantity_delivered > 0)) {
      toast.error("Enter at least one delivered quantity.");
      return;
    }

    const summary = lines
      .map((line) => {
        const item = active.items.find(
          (candidate) => candidate.id === line.order_line_id
        );

        return [
          item?.name ?? line.order_line_id,
          `Delivered: ${line.quantity_delivered} ${item?.unit ?? ""}`,
          `Rejected: ${line.quantity_rejected} ${item?.unit ?? ""}`,
          `Accepted: ${line.quantity_delivered - line.quantity_rejected} ${item?.unit ?? ""}`,
          `Rejection reason: ${line.rejection_reason ?? "Not entered"}`,
          `Batch: ${line.batch_number ?? "Not entered"}`,
          `Expiry: ${line.expiry_date ?? "NOT ENTERED"}`,
        ].join("\n");
      })
      .join("\n\n");

    setPendingConfirmation({
      orderNumber: active.order_number,
      supplierName: active.supplier_name,
      summary,
      payload: {
        orderId: active.id,
        locationId: active.deliver_to_location_id ?? "",
        deliveryNote: deliveryNote.trim(),
        remarks,
        lines,
      },
    });
  }

  function cancelConfirmation() {
    if (submittingRef.current) return;
    setPendingConfirmation(null);
  }

  function confirmSubmission() {
    if (!pendingConfirmation || submittingRef.current) return;
    submittingRef.current = true;
    submitCount.mutate(pendingConfirmation.payload);
  }

  return (
    <div className="space-y-6">

      <PageHeader
        eyebrow="Supply Chain"
        title="Blind Goods Receiving"
        description="Count what physically arrived. Purchase order quantities and prices are hidden until the receiving count is submitted."
      />

      <ApprovedReceivingPosting />

      <QueryState
        isLoading={orders.isLoading}
        error={orders.error}
        isEmpty={rows.length === 0}
        empty={
          <SectionCard title="No deliveries awaiting receiving">
            <p className="py-4 text-sm text-muted-foreground">
              No eligible purchase orders are currently available for this property.
            </p>
          </SectionCard>
        }
      >
        <SectionCard
          title="Purchase orders awaiting delivery"
          description="Select the supplier delivery you are counting."
        >
          <div className="space-y-3">
            {rows.map((order) => (
              <div
                key={order.id}
                className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4"
              >
                <div>
                  <p className="font-medium">{order.order_number}</p>
                  <p className="text-sm text-muted-foreground">
                    {order.supplier_name}
                  </p>
                </div>

                <Button
                  variant={selected === order.id ? "secondary" : "default"}
                  disabled={submitCount.isPending}
                  onClick={() => openOrder(order.id)}
                >
                  Start blind count
                </Button>
              </div>
            ))}
          </div>
        </SectionCard>
      </QueryState>

      {active && (
        <SectionCard
          title={`Blind count — ${active.order_number}`}
          description="Enter the delivered quantities independently. Expected quantities and purchase prices are not available on this screen."
        >
          <div className="space-y-6">

            <div className="rounded-lg border p-4">
              <p className="text-sm font-medium">
                Supplier: {active.supplier_name}
              </p>

              <p className="mt-1 text-xs text-muted-foreground">
                Count all items physically before recording acceptance or rejection.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">

              <div className="space-y-2">
                <Label>Supplier delivery note number</Label>
                <Input
                  value={deliveryNote}
                  onChange={(e) => setDeliveryNote(e.target.value)}
                  placeholder="Enter delivery note reference"
                />
              </div>

              <div className="space-y-2">
                <Label>Receiving remarks</Label>
                <Input
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  placeholder="Driver, vehicle or delivery condition"
                />
              </div>

            </div>

            <div className="space-y-4">
              {active.items.map((item) => {
                const qty = Number(delivered[item.id] || 0);
                const rejectQty = Number(rejected[item.id] || 0);

                return (
                  <div
                    key={item.id}
                    className="space-y-4 rounded-lg border p-4"
                  >
                    <div>
                      <p className="font-medium">{item.name}</p>

                      <p className="text-sm text-muted-foreground">
                        Unit: {item.unit}
                      </p>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">

                      <div className="space-y-2">
                        <Label>Quantity physically delivered</Label>

                        <Input
                          type="number"
                          min="0"
                          step="any"
                          value={delivered[item.id] ?? ""}
                          onChange={(e) =>
                            setDelivered((previous) => ({
                              ...previous,
                              [item.id]: e.target.value,
                            }))
                          }
                        />
                      </div>

                      <div className="space-y-2">
                        <Label>Quantity rejected</Label>

                        <Input
                          type="number"
                          min="0"
                          step="any"
                          value={rejected[item.id] ?? ""}
                          onChange={(e) =>
                            setRejected((previous) => ({
                              ...previous,
                              [item.id]: e.target.value,
                            }))
                          }
                        />
                      </div>

                    </div>

                    {rejectQty > 0 && (
                      <div className="space-y-2">
                        <Label>Reason for rejection</Label>

                        <Textarea
                          value={reasons[item.id] ?? ""}
                          onChange={(e) =>
                            setReasons((previous) => ({
                              ...previous,
                              [item.id]: e.target.value,
                            }))
                          }
                        />
                      </div>
                    )}

                    {rejectQty > qty && (
                      <p className="text-sm text-destructive">
                        Rejected quantity cannot exceed delivered quantity.
                      </p>
                    )}

                    <div className="grid gap-4 sm:grid-cols-2">

                      <div className="space-y-2">
                        <Label>Batch / lot number</Label>

                        <Input
                          value={batches[item.id] ?? ""}
                          onChange={(e) =>
                            setBatches((previous) => ({
                              ...previous,
                              [item.id]: e.target.value,
                            }))
                          }
                        />
                      </div>

                      <div className="space-y-2">
                        <Label>Expiry date</Label>

                        <NeoDatePicker
                          value={expiries[item.id] ?? ""}
                          ariaLabel={`Expiry date for ${item.name}`}
                          onChange={(value) =>
                            setExpiries((previous) => ({
                              ...previous,
                              [item.id]: value,
                            }))
                          }
                        />
                      </div>

                    </div>

                    <p className="text-xs text-muted-foreground">
                      Quantity accepted after physical inspection:
                      {" "}{Math.max(qty - rejectQty, 0)} {item.unit}
                    </p>
                  </div>
                );
              })}
            </div>

            <div className="rounded-lg border border-warning/40 bg-tint-warning p-4 text-sm text-on-tint-warning">
              Blind counting is enabled. Stock posting remains locked
              until the A10 database authorization and reconciliation
              controls are installed.
            </div>

            <div className="flex justify-end gap-3">

              <Button
                variant="outline"
                disabled={submitCount.isPending}
                onClick={() => {
                  setPendingConfirmation(null);
                  setSelected(null);
                }}
              >
                Close count
              </Button>

              <Button
                disabled={submitCount.isPending}
                onClick={handleSubmit}
              >
                {submitCount.isPending
                  ? "Submitting count..."
                  : "Submit blind receiving count"}
              </Button>

            </div>

          </div>
        </SectionCard>
      )}

      <dialog
        ref={confirmationRef}
        aria-labelledby="blind-count-confirmation-title"
        aria-describedby="blind-count-confirmation-description"
        aria-busy={submitCount.isPending}
        className="m-auto max-h-[90vh] w-[calc(100%_-_2rem)] max-w-xl overflow-y-auto rounded-lg border bg-background p-6 text-foreground shadow-lg backdrop:bg-foreground/50"
        onCancel={(event) => {
          event.preventDefault();
          cancelConfirmation();
        }}
      >
        {pendingConfirmation && (
          <div className="space-y-4">
            <h2 id="blind-count-confirmation-title" className="text-lg font-semibold">
              Confirm physical receiving count
            </h2>
            <p id="blind-count-confirmation-description" className="text-sm text-muted-foreground">
              Submit this count for independent review? No inventory will be posted at this stage.
            </p>
            <div className="space-y-1 text-sm">
              <p>PO: {pendingConfirmation.orderNumber}</p>
              <p>Supplier: {pendingConfirmation.supplierName}</p>
              <p>Delivery note: {pendingConfirmation.payload.deliveryNote}</p>
              <p className="whitespace-pre-wrap break-words">
                Remarks: {pendingConfirmation.payload.remarks || "Not entered"}
              </p>
            </div>
            <pre className="whitespace-pre-wrap break-words rounded-md border p-4 font-sans text-sm">
              {pendingConfirmation.summary}
            </pre>
            <div className="flex justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={submitCount.isPending}
                onClick={cancelConfirmation}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={submitCount.isPending}
                onClick={confirmSubmission}
              >
                {submitCount.isPending ? "Submitting count..." : "Confirm"}
              </Button>
            </div>
          </div>
        )}
      </dialog>

    </div>
  );
}

function GuardedPage() {
return (
    <OpsGuard path="/inventory/receiving">
      <Page />
    </OpsGuard>
  );
}
