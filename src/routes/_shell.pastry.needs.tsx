import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, PastryGuard, QueryState } from "@/components/pastry/PastryShared";
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
  PASTRY_NEED_UNITS,
  pastryNum,
  pastryStr,
  useRequisitionPastryNeeds,
  useReportPastryNeed,
  usePastryStockNeeds,
  type PastryRow,
} from "@/lib/pastry-department";

export const Route = createFileRoute("/_shell/pastry/needs")({
  head: () => ({
    meta: [
      { title: "Pastry Stock Needs — NEØ" },
      {
        name: "description",
        content:
          "Pastry Chefs report what the bakery is short of; only the Head Pastry Chef consolidates those needs into a single Stores requisition.",
      },
      { property: "og:title", content: "Pastry Stock Needs — NEØ" },
      {
        property: "og:description",
        content: "From a reported bakery shortage to one consolidated Stores requisition.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PastryGuard feature="pastry-needs">
      <PastryNeedsPage />
    </PastryGuard>
  ),
});

function needTone(status: string): "success" | "warning" | "destructive" | "default" {
  if (status === "requisitioned" || status === "closed") return "success";
  if (status === "declined") return "destructive";
  if (status === "acknowledged") return "warning";
  return "default";
}

function PastryNeedsPage() {
  const { can } = useAuth();
  const mayRequisition = can("kitchen", "pastry-requisition", "create");

  const [status, setStatus] = useState("all");
  const needs = usePastryStockNeeds(status);
  const report = useReportPastryNeed();
  const requisition = useRequisitionPastryNeeds();

  const [open, setOpen] = useState(false);
  const [item, setItem] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState<string>("kg");
  const [priority, setPriority] = useState("normal");
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const rows = (needs.data ?? []) as PastryRow[];
  const selectable = rows.filter((r) => ["reported", "acknowledged"].includes(String(r["status"])));
  const chosen = selectable.filter((r) => selected[String(r["id"])]).map((r) => String(r["id"]));

  return (
    <div>
      <PageHeader
        eyebrow="Pastry & Bakery"
        title="Stock needs"
        description="Anyone in pastry can flag a shortage. Only the Head Pastry Chef turns those flags into a requisition, so Stores receives one consolidated request per department."
        actions={
          <>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-40" aria-label="Filter by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["all", "reported", "acknowledged", "requisitioned", "declined", "closed"].map(
                  (s) => (
                    <SelectItem key={s} value={s}>
                      {titleCase(s)}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
            <Button onClick={() => setOpen(true)}>Report a need</Button>
            {mayRequisition ? (
              <Button
                variant="outline"
                disabled={chosen.length === 0 || requisition.isPending}
                onClick={async () => {
                  await requisition.mutateAsync({ needIds: chosen });
                  setSelected({});
                }}
              >
                Send {chosen.length || ""} to Stores
              </Button>
            ) : null}
          </>
        }
      />

      <SectionCard title="Reported needs" description="Most recent first.">
        <QueryState
          isLoading={needs.isLoading}
          error={needs.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No needs reported"
              description="Pastry has not flagged any shortage."
            />
          }
        >
          <div className="space-y-2">
            {rows.map((r) => {
              const id = String(r["id"]);
              const st = String(r["status"]);
              const canSelect = mayRequisition && ["reported", "acknowledged"].includes(st);
              return (
                <div
                  key={id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 p-3"
                >
                  <div className="flex items-start gap-3">
                    {canSelect ? (
                      <Checkbox
                        checked={Boolean(selected[id])}
                        onCheckedChange={(v) => setSelected((s) => ({ ...s, [id]: Boolean(v) }))}
                        aria-label={`Select ${pastryStr(r["item"])}`}
                      />
                    ) : null}
                    <div>
                      <p className="text-sm font-medium">{pastryStr(r["item"])}</p>
                      <p className="text-xs text-muted-foreground">
                        {pastryNum(r["quantity"])} {pastryStr(r["unit"], "kg")} ·{" "}
                        {titleCase(pastryStr(r["priority"], "normal"))}
                      </p>
                      {r["notes"] ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {pastryStr(r["notes"])}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <StatusPill tone={needTone(st)}>{titleCase(st)}</StatusPill>
                </div>
              );
            })}
          </div>
        </QueryState>
      </SectionCard>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Report a pastry stock need</DialogTitle>
            <DialogDescription>
              This goes to the Head Pastry Chef, not straight to Stores.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="need-item">Item</Label>
              <Input
                id="need-item"
                value={item}
                onChange={(e) => setItem(e.target.value)}
                placeholder="Baking flour"
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label htmlFor="need-qty">Quantity</Label>
                <Input
                  id="need-qty"
                  type="number"
                  min="0"
                  step="0.1"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="need-unit">Unit</Label>
                <Select value={unit} onValueChange={setUnit}>
                  <SelectTrigger id="need-unit">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PASTRY_NEED_UNITS.map((u) => (
                      <SelectItem key={u} value={u}>
                        {u}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="need-priority">Priority</Label>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger id="need-priority">
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
              disabled={!item.trim() || report.isPending}
              onClick={async () => {
                await report.mutateAsync({
                  item: item.trim(),
                  quantity: Number(quantity) || 0,
                  unit,
                  priority,
                  notes: notes.trim(),
                });
                setItem("");
                setNotes("");
                setOpen(false);
              }}
            >
              Send to Head Pastry Chef
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
