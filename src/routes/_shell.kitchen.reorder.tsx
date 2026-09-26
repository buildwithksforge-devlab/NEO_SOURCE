/**
 * Kitchen reorder.
 *
 * The action side of the dashboard's reorder alert: every tracked ingredient at
 * or below its recorded reorder point, what has already been raised against it,
 * and a one-step way to report the shortage to Stores.
 *
 * Nothing is assumed. A quantity is only suggested where a reorder point is
 * actually recorded; an item without one is shown as unconfigured and its
 * quantity is left for the person reporting it to enter.
 */
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import { EmptyState, KitchenGuard, QueryState } from "@/components/kitchen/KitchenShared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { useAuth } from "@/lib/auth";
import { useLiveStockBoard, usePurchaseRequests, type LiveStockItem } from "@/lib/inventory-data";
import { useReportKitchenNeed } from "@/lib/main-kitchen";
import type { Row } from "@/lib/kitchen";

export const Route = createFileRoute("/_shell/kitchen/reorder")({
  head: () => ({
    meta: [
      { title: "Kitchen reorder — NEØ" },
      {
        name: "description",
        content:
          "Ingredients at or below their recorded reorder point, what has already been requisitioned, and a direct way to report the shortage to Stores.",
      },
      { property: "og:title", content: "Kitchen reorder — NEØ" },
      {
        property: "og:description",
        content: "Turn a reorder alert into a recorded stock need without leaving the kitchen.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <KitchenGuard action="needs.view">
      <KitchenReorderPage />
    </KitchenGuard>
  ),
});

const UNITS = ["kg", "g", "litre", "ml", "piece", "pack", "crate", "tray"];

type ReorderRow = LiveStockItem & {
  storeName: string;
  configured: boolean;
  shortfall: number;
};

function KitchenReorderPage() {
  const { can } = useAuth();
  const mayReport = can("kitchen", "needs", "create") || can("kitchen", "needs", "edit");

  const board = useLiveStockBoard();
  const requests = usePurchaseRequests();
  const report = useReportKitchenNeed();

  const [target, setTarget] = useState<ReorderRow | null>(null);
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("kg");
  const [priority, setPriority] = useState("normal");
  const [notes, setNotes] = useState("");

  const stores = board.data?.stores ?? [];

  const rows = useMemo<ReorderRow[]>(() => {
    const out: ReorderRow[] = [];
    for (const store of stores) {
      for (const item of store.items ?? []) {
        const configured = Number(item.reorder_point) > 0;
        if (configured && Number(item.on_hand) > Number(item.reorder_point)) continue;
        if (!configured && Number(item.on_hand) > 0) continue;
        out.push({
          ...item,
          storeName: store.location_name,
          configured,
          shortfall: configured ? Number(item.reorder_point) - Number(item.on_hand) : 0,
        });
      }
    }
    return out.sort((a, b) => Number(a.on_hand) - Number(b.on_hand));
  }, [stores]);

  /** Requisitions still open against each stock item, read from their own lines. */
  const raisedByItem = useMemo(() => {
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

  const unconfigured = rows.filter((r) => !r.configured).length;
  const uncovered = rows.filter((r) => (raisedByItem.get(r.stock_item_id) ?? []).length === 0).length;

  const lead: SummaryFigure = {
    id: "to-reorder",
    label: "Items to reorder",
    value: String(rows.length),
    tone: rows.length > 0 ? "warning" : "success",
    hint: "At or below the recorded reorder point",
  };
  const figures: SummaryFigure[] = [
    {
      id: "uncovered",
      label: "Nothing raised yet",
      value: String(uncovered),
      tone: uncovered > 0 ? "destructive" : "success",
      hint: "No open requisition against the item",
    },
    {
      id: "unconfigured",
      label: "No reorder point set",
      value: String(unconfigured),
      tone: unconfigured > 0 ? "warning" : "default",
      hint: "Listed because they are out of stock",
    },
    { id: "stores", label: "Stores checked", value: String(stores.length), hint: "Ledger-backed balances" },
  ];

  const openDialog = (row: ReorderRow) => {
    setTarget(row);
    setQuantity(row.configured && row.shortfall > 0 ? String(Number(row.shortfall.toFixed(2))) : "");
    setUnit(row.unit && UNITS.includes(row.unit) ? row.unit : "kg");
    setPriority(Number(row.on_hand) <= 0 ? "urgent" : "normal");
    setNotes("");
  };

  const submit = () => {
    if (!target) return;
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) return;
    const trimmed = notes.trim();
    report.mutate(
      {
        item: target.name,
        quantity: qty,
        unit,
        priority,
        ...(trimmed ? { notes: trimmed } : {}),
      },
      { onSuccess: () => setTarget(null) },
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reorder"
        description="Every tracked ingredient at or below its recorded reorder point, with what has already been raised against it. Reporting a need here sends it to Stores — it does not order anything by itself."
      />

      <SummaryStrip lead={lead} figures={figures} />

      <SectionCard
        title="Needs reordering"
        description="An item with no reorder point recorded is shown as unconfigured and appears only when it has run out — it is never assumed safe."
      >
        <QueryState
          isLoading={board.isLoading}
          error={board.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="Nothing to reorder"
              description={
                board.data?.reason ??
                "Every tracked item in this property's stores is above its recorded reorder point."
              }
            />
          }
        >
          <div className="neo-table-scroll overflow-x-auto">
            <table className="neo-stack-table w-full text-sm sm:min-w-[760px]">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  {["Item", "Store", "On hand", "Reorder point", "Short by", "Raised", ""].map((h) => (
                    <th key={h} className="whitespace-nowrap py-2 pr-4 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {rows.map((r) => {
                  const raised = raisedByItem.get(r.stock_item_id) ?? [];
                  return (
                    <tr key={`${r.stock_item_id}-${r.storeName}`} className="align-top">
                      <td className="py-2 pr-4" data-label="Item">
                        <div className="font-medium">{r.name}</div>
                        {r.sku ? <div className="text-xs text-muted-foreground">{r.sku}</div> : null}
                      </td>
                      <td className="py-2 pr-4" data-label="Store">
                        {r.storeName}
                      </td>
                      <td className="py-2 pr-4 tabular-nums" data-label="On hand">
                        {r.on_hand} {r.unit ?? ""}
                      </td>
                      <td className="py-2 pr-4 tabular-nums" data-label="Reorder point">
                        {r.configured ? (
                          `${r.reorder_point} ${r.unit ?? ""}`
                        ) : (
                          <StatusPill tone="warning">Not configured</StatusPill>
                        )}
                      </td>
                      <td className="py-2 pr-4 tabular-nums" data-label="Short by">
                        {r.configured ? r.shortfall.toFixed(2) : "—"}
                      </td>
                      <td className="py-2 pr-4" data-label="Raised">
                        {raised.length > 0 ? (
                          <span className="text-xs">{raised.join(", ")}</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-destructive">
                            <AlertTriangle className="size-3.5" aria-hidden />
                            Nothing raised
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-4" data-label="">
                        {mayReport ? (
                          <Button size="sm" variant="secondary" onClick={() => openDialog(r)}>
                            Report need
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Reported needs are consolidated into a Stores requisition from{" "}
            <Link to="/kitchen/needs" className="text-primary underline-offset-4 hover:underline">
              Stock Needs
            </Link>
            . Physical quantities are corrected in{" "}
            <Link to="/kitchen/stock-count" className="text-primary underline-offset-4 hover:underline">
              Stock count
            </Link>
            .
          </p>
        </QueryState>
      </SectionCard>

      <Dialog open={target !== null} onOpenChange={(open) => (open ? null : setTarget(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Report a stock need</DialogTitle>
            <DialogDescription>
              {target
                ? `${target.name} in ${target.storeName}. On hand ${target.on_hand} ${target.unit ?? ""}.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="reorder-qty">Quantity needed</Label>
              <Input
                id="reorder-qty"
                inputMode="decimal"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder={target?.configured ? "Suggested from the reorder point" : "Enter the quantity"}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="reorder-unit">Unit</Label>
              <Select value={unit} onValueChange={setUnit}>
                <SelectTrigger id="reorder-unit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {UNITS.map((u) => (
                    <SelectItem key={u} value={u}>
                      {u}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="reorder-priority">Priority</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger id="reorder-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="reorder-notes">Notes for Stores</Label>
              <Textarea
                id="reorder-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything Stores needs to know — brand, pack size, when it is needed."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={report.isPending || !(Number(quantity) > 0)}
            >
              {report.isPending ? "Reporting…" : "Report need"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
