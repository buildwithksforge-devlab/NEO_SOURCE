import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
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

const db = supabase as any;

export const Route = createFileRoute("/_shell/inventory/receiving")({
  component: GuardedPage,
});

function Page() {
  const orders = useReceivableOrders();

  const submitCount = useMutation({
    mutationFn: async (payload: {
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
    }) => {
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
      toast.success(
        "Blind receiving count submitted. Awaiting reconciliation."
      );
      setSelected(null);
    },

    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

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
    if (!active) return;

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

    submitCount.mutate({
      orderId: active.id,
      locationId: active.deliver_to_location_id ?? "",
      deliveryNote: deliveryNote.trim(),
      remarks,
      lines,
    });
  }

  return (
    <div className="space-y-6">

      <PageHeader
        eyebrow="Supply Chain"
        title="Blind Goods Receiving"
        description="Count what physically arrived. Purchase order quantities and prices are hidden until the receiving count is submitted."
      />

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

                        <Input
                          type="date"
                          value={expiries[item.id] ?? ""}
                          onChange={(e) =>
                            setExpiries((previous) => ({
                              ...previous,
                              [item.id]: e.target.value,
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

            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
              Blind counting is enabled. Stock posting remains locked
              until the A10 database authorization and reconciliation
              controls are installed.
            </div>

            <div className="flex justify-end gap-3">

              <Button
                variant="outline"
                onClick={() => setSelected(null)}
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
