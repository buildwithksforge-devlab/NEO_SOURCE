import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { QueryState } from "@/components/pms/PmsShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStockItems, useStockLocations } from "@/lib/inventory-data";
import { titleCase, type Row } from "@/lib/inventory";
import {
  newTransferAttemptKey,
  useCancelTransfer,
  useCreateTransfer,
  useReceiveTransfer,
  useStoreTransfers,
  type TransferLineInput,
  type TransferRow,
} from "@/lib/stock-transfers";

export const Route = createFileRoute("/_shell/inventory/transfers")({
  head: () => ({
    meta: [
      { title: "Store transfers — NEØ" },
      {
        name: "description",
        content:
          "Move stock between two stores of the same property. The source is deducted on dispatch and the destination credited on receipt, exactly once.",
      },
      { property: "og:title", content: "Store transfers — NEØ" },
      {
        property: "og:description",
        content:
          "Dispatch and receive stock between stores, with a full in-transit trail and no double posting.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type Draft = { stockItemId: string; quantity: string };

function statusTone(status: string): "default" | "secondary" | "outline" | "destructive" {
  if (status === "completed" || status === "received") return "default";
  if (status === "cancelled") return "destructive";
  if (status === "in-transit") return "secondary";
  return "outline";
}

function Page() {
  const locations = useStockLocations();
  const items = useStockItems();
  const transfers = useStoreTransfers("all");
  const create = useCreateTransfer();
  const receive = useReceiveTransfer();
  const cancel = useCancelTransfer();

  const [fromLocationId, setFromLocationId] = useState("");
  const [toLocationId, setToLocationId] = useState("");
  const [reason, setReason] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([{ stockItemId: "", quantity: "" }]);
  const [attemptKey, setAttemptKey] = useState(newTransferAttemptKey);

  const locationRows = (locations.data ?? []) as Row[];
  const itemRows = (items.data ?? []) as Row[];
  const transferRows = (transfers.data ?? []) as TransferRow[];

  const lines: TransferLineInput[] = drafts
    .filter((d) => d.stockItemId && Number(d.quantity) > 0)
    .map((d) => ({ stock_item_id: d.stockItemId, quantity: Number(d.quantity) }));

  const sameStore = Boolean(fromLocationId) && fromLocationId === toLocationId;

  function submit() {
    create.mutate(
      { fromLocationId, toLocationId, lines, reason: reason.trim(), attemptKey },
      {
        onSuccess: () => {
          setDrafts([{ stockItemId: "", quantity: "" }]);
          setReason("");
          setAttemptKey(newTransferAttemptKey());
        },
      },
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Supply Chain"
        title="Store transfers"
        description="Stock moving between two stores of this property. The source store is deducted when the transfer is dispatched and the destination credited only when it is received — the property total never changes."
      />

      <SectionCard
        title="Create a transfer"
        description="Choose where the stock is leaving from, where it is going, and what is moving."
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>From store</Label>
              <Select value={fromLocationId} onValueChange={setFromLocationId}>
                <SelectTrigger>
                  <SelectValue placeholder="Source store" />
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
              <Label>To store</Label>
              <Select value={toLocationId} onValueChange={setToLocationId}>
                <SelectTrigger>
                  <SelectValue placeholder="Destination store" />
                </SelectTrigger>
                <SelectContent>
                  {locationRows.map((l) => (
                    <SelectItem key={String(l["id"])} value={String(l["id"])}>
                      {String(l["name"])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {sameStore ? (
                <p className="text-xs text-destructive">
                  A transfer needs two different stores.
                </p>
              ) : null}
            </div>
          </div>

          <div className="space-y-3">
            {drafts.map((d, i) => (
              <div key={`transfer-line-${i}`} className="flex flex-wrap items-end gap-3">
                <div className="min-w-56 flex-1 space-y-2">
                  <Label>Item</Label>
                  <Select
                    value={d.stockItemId}
                    onValueChange={(v) =>
                      setDrafts((rows) =>
                        rows.map((r, idx) => (idx === i ? { ...r, stockItemId: v } : r)),
                      )
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Stock item" />
                    </SelectTrigger>
                    <SelectContent>
                      {itemRows.map((it) => (
                        <SelectItem key={String(it["id"])} value={String(it["id"])}>
                          {String(it["name"])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-32 space-y-2">
                  <Label htmlFor={`transfer-qty-${i}`}>Quantity</Label>
                  <Input
                    id={`transfer-qty-${i}`}
                    type="number"
                    min={0}
                    step="0.01"
                    value={d.quantity}
                    onChange={(e) =>
                      setDrafts((rows) =>
                        rows.map((r, idx) => (idx === i ? { ...r, quantity: e.target.value } : r)),
                      )
                    }
                  />
                </div>
                {drafts.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDrafts((rows) => rows.filter((_, idx) => idx !== i))}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDrafts((rows) => [...rows, { stockItemId: "", quantity: "" }])}
            >
              Add another item
            </Button>
          </div>

          <div className="space-y-2">
            <Label htmlFor="transfer-reason">Reason or reference</Label>
            <Textarea
              id="transfer-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Bar top-up, kitchen replenishment, moving stock to the cold room…"
            />
          </div>

          <div className="flex justify-end">
            <Button
              disabled={
                !fromLocationId ||
                !toLocationId ||
                sameStore ||
                lines.length === 0 ||
                reason.trim().length === 0 ||
                create.isPending
              }
              onClick={submit}
            >
              Dispatch transfer
            </Button>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Transfers"
        description="In transit until the destination store confirms receipt."
      >
        <QueryState
          isLoading={transfers.isLoading}
          error={transfers.error}
          isEmpty={transferRows.length === 0}
          empty={
            <p className="py-6 text-sm text-muted-foreground">
              No stock has been transferred between stores yet.
            </p>
          }
        >
          <ul className="divide-y divide-border">
            {transferRows.map((t) => {
              const status = String(t["status"] ?? "");
              const tLines = (t["stock_transfer_lines"] ?? []) as Row[];
              return (
                <li key={String(t["id"])} className="space-y-2 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium">
                        {String(t["transfer_number"] ?? "Transfer")}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {String((t["from_store"] as Row | null)?.["name"] ?? "Source")} →{" "}
                          {String((t["to_store"] as Row | null)?.["name"] ?? "Destination")}
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {tLines
                          .map(
                            (l) =>
                              `${Number(l["quantity"] ?? 0)} × ${String((l["stock_items"] as Row | null)?.["name"] ?? "item")}`,
                          )
                          .join(", ") || "No lines recorded"}
                      </p>
                      {t["reason"] ? (
                        <p className="text-xs text-muted-foreground">{String(t["reason"])}</p>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={statusTone(status)}>{titleCase(status || "draft")}</Badge>
                      {status === "in-transit" ? (
                        <>
                          <Button
                            size="sm"
                            disabled={receive.isPending}
                            onClick={() => receive.mutate(String(t["id"]))}
                          >
                            Confirm receipt
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={cancel.isPending}
                            onClick={() =>
                              cancel.mutate({
                                transferId: String(t["id"]),
                                reason: "Cancelled before receipt",
                              })
                            }
                          >
                            Cancel
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </QueryState>
      </SectionCard>
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/inventory/transfers">
      <Page />
    </OpsGuard>
  );
}
