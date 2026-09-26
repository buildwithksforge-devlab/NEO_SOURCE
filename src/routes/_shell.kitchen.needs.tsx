import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, StatusPill } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import {
  InspectorField,
  InspectorSection,
  InspectorSheet,
} from "@/components/common/InspectorSheet";
import { EmptyState, KitchenGuard, QueryState } from "@/components/kitchen/KitchenShared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/kitchen";
import {
  kitchenNum,
  kitchenStr,
  needTone,
  useKitchenStockNeeds,
  useReportKitchenNeed,
  useRequisitionKitchenNeeds,
  useReviewKitchenNeed,
  type KitchenRow,
} from "@/lib/main-kitchen";

export const Route = createFileRoute("/_shell/kitchen/needs")({
  head: () => ({
    meta: [
      { title: "Kitchen Stock Needs — NEØ" },
      {
        name: "description",
        content:
          "Report Main Kitchen stock needs and, as Head Chef, consolidate them into a single Stores requisition.",
      },
      { property: "og:title", content: "Kitchen Stock Needs — NEØ" },
      {
        property: "og:description",
        content: "One route from a chef's reported shortage to an approved Stores requisition.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <KitchenGuard action="needs.view">
      <KitchenNeedsPage />
    </KitchenGuard>
  ),
});

const UNITS = ["kg", "g", "litre", "ml", "piece", "pack", "crate", "tray"];

type Lens = "none" | "urgent" | "requisitioned";

function KitchenNeedsPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState("all");
  const needs = useKitchenStockNeeds(status);
  const report = useReportKitchenNeed();
  const review = useReviewKitchenNeed();
  const requisition = useRequisitionKitchenNeeds();

  // Only the Kitchen Manager / Head Chef holds the requisition capability.
  const mayRequisition = can("kitchen", "requisitions", "create");
  const mayReview = can("kitchen", "needs", "edit");

  const [open, setOpen] = useState(false);
  const [item, setItem] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState("kg");
  const [priority, setPriority] = useState("normal");
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [lens, setLens] = useState<Lens>("none");
  const [inspectId, setInspectId] = useState<string | null>(null);

  const rows = (needs.data ?? []) as KitchenRow[];
  const selectable = rows.filter((r) => ["reported", "acknowledged"].includes(String(r["status"])));
  const selectedIds = Object.keys(selected).filter((id) => selected[id]);
  const requisitionedCount = rows.filter((r) => String(r["status"]) === "requisitioned").length;
  const urgentCount = selectable.filter((r) => String(r["priority"]) === "urgent").length;

  const toggleLens = (next: Lens) => setLens((prev) => (prev === next ? "none" : next));

  const visible = useMemo(
    () =>
      rows.filter((r) => {
        if (lens === "urgent") return String(r["priority"]) === "urgent";
        if (lens === "requisitioned") return String(r["status"]) === "requisitioned";
        return true;
      }),
    [rows, lens],
  );

  const inspected = rows.find((r) => String(r["id"]) === inspectId) ?? null;
  const inspectedStatus = inspected ? String(inspected["status"] ?? "reported") : "reported";

  const leadFigure: SummaryFigure = {
    id: "open",
    label: "Open needs",
    value: needs.isLoading ? "…" : selectable.length,
    hint: "Reported or acknowledged",
  };
  const figures: SummaryFigure[] = [
    {
      id: "urgent",
      label: "Urgent",
      value: needs.isLoading ? "…" : urgentCount,
      tone: urgentCount ? "warning" : "success",
      onSelect: () => toggleLens("urgent"),
      active: lens === "urgent",
    },
    {
      id: "requisitioned",
      label: "Requisitioned",
      value: needs.isLoading ? "…" : requisitionedCount,
      tone: "success",
      onSelect: () => toggleLens("requisitioned"),
      active: lens === "requisitioned",
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Main Kitchen"
        title="Stock needs & requisitions"
        description="Chefs and supervisors report what the kitchen is short of. The Kitchen Manager / Head Chef is the only role that turns those needs into a Stores requisition."
        actions={<Button onClick={() => setOpen(true)}>Report a need</Button>}
      />

      <SummaryStrip
        lead={leadFigure}
        figures={figures}
        actions={
          <>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["all", "reported", "acknowledged", "requisitioned", "declined", "closed"].map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {mayRequisition ? (
              <Button
                disabled={requisition.isPending || selectedIds.length === 0}
                onClick={() =>
                  requisition.mutate({ needIds: selectedIds }, { onSuccess: () => setSelected({}) })
                }
              >
                Requisition {selectedIds.length > 0 ? `(${selectedIds.length})` : ""}
              </Button>
            ) : null}
          </>
        }
      />

      <QueryState
        isLoading={needs.isLoading}
        error={needs.error}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            title="No needs reported"
            description="Report a shortage and it goes straight to the Head Chef for requisition."
          />
        }
      >
        <div className="surface-panel rounded-2xl p-2">
          <div className="space-y-1.5">
            {visible.map((r) => {
              const id = String(r["id"]);
              const rowStatus = String(r["status"] ?? "reported");
              const canSelect = mayRequisition && ["reported", "acknowledged"].includes(rowStatus);
              return (
                <div
                  key={id}
                  className="flex min-w-0 items-center gap-3 rounded-xl border border-transparent p-2.5 hover:border-outline-subtle hover:bg-muted/40"
                >
                  {canSelect ? (
                    <Checkbox
                      checked={Boolean(selected[id])}
                      onCheckedChange={(v) => setSelected((prev) => ({ ...prev, [id]: Boolean(v) }))}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : null}
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
                    onClick={() => setInspectId(id)}
                  >
                    <div className="min-w-0">
                      <p className="neo-line-1 font-medium">
                        {kitchenStr(r["item"])} — {kitchenNum(r["quantity"])} {kitchenStr(r["unit"], "kg")}
                      </p>
                      <p className="neo-line-1 text-sm text-muted-foreground">
                        {titleCase(kitchenStr(r["priority"], "normal"))} ·{" "}
                        {r["created_at"] ? new Date(String(r["created_at"])).toLocaleString() : "—"}
                      </p>
                    </div>
                    <StatusPill tone={needTone(rowStatus)}>{titleCase(rowStatus)}</StatusPill>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </QueryState>

      <InspectorSheet
        open={Boolean(inspected)}
        onOpenChange={(next) => !next && setInspectId(null)}
        title={inspected ? kitchenStr(inspected["item"]) : ""}
        subtitle={inspected ? `${kitchenNum(inspected["quantity"])} ${kitchenStr(inspected["unit"], "kg")}` : undefined}
        chips={
          inspected ? (
            <StatusPill tone={needTone(inspectedStatus)}>{titleCase(inspectedStatus)}</StatusPill>
          ) : null
        }
        footer={
          inspected && mayReview && inspectedStatus === "reported" ? (
            <>
              <Button
                variant="outline"
                disabled={review.isPending}
                onClick={() => review.mutate({ needId: String(inspected["id"]), decision: "acknowledge" })}
              >
                Acknowledge
              </Button>
              <Button
                variant="ghost"
                disabled={review.isPending}
                onClick={() => review.mutate({ needId: String(inspected["id"]), decision: "decline" })}
              >
                Decline
              </Button>
            </>
          ) : null
        }
      >
        {inspected ? (
          <InspectorSection title="Details">
            <InspectorField label="Priority">{titleCase(kitchenStr(inspected["priority"], "normal"))}</InspectorField>
            <InspectorField label="Reported">
              {inspected["created_at"] ? new Date(String(inspected["created_at"])).toLocaleString() : "—"}
            </InspectorField>
            <InspectorField label="Notes">
              {kitchenStr(inspected["notes"], "No notes given")}
            </InspectorField>
          </InspectorSection>
        ) : null}
      </InspectorSheet>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Report a stock need</DialogTitle>
            <DialogDescription>
              This does not order anything — it tells the Head Chef what the kitchen is short of.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="need-item">Item</Label>
              <Input
                id="need-item"
                value={item}
                onChange={(e) => setItem(e.target.value)}
                placeholder="e.g. Beef fillet"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <Label htmlFor="need-qty">Quantity</Label>
                <Input
                  id="need-qty"
                  type="number"
                  min="0"
                  step="0.01"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </div>
              <div>
                <Label>Unit</Label>
                <Select value={unit} onValueChange={setUnit}>
                  <SelectTrigger>
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
              <div>
                <Label>Priority</Label>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["low", "normal", "high", "urgent"].map((p) => (
                      <SelectItem key={p} value={p}>
                        {titleCase(p)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label htmlFor="need-notes">Notes</Label>
              <Textarea id="need-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={report.isPending || !item.trim()}
              onClick={() =>
                report.mutate(
                  { item, quantity: Number(quantity) || 0, unit, priority, notes },
                  {
                    onSuccess: () => {
                      setOpen(false);
                      setItem("");
                      setQuantity("1");
                      setNotes("");
                    },
                  },
                )
              }
            >
              Report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
