import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import {
  EmptyState,
  PastryGuard,
  PastryStatusBadge,
  QueryState,
} from "@/components/pastry/PastryShared";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth";
import {
  PASTRY_UNITS,
  pastryNum,
  pastryStr,
  useRecordPastryWaste,
  useReviewPastryWaste,
  usePastryWaste,
  type PastryRow,
} from "@/lib/pastry-department";

export const Route = createFileRoute("/_shell/pastry/wastage")({
  head: () => ({
    meta: [
      { title: "Pastry Wastage — NEØ" },
      {
        name: "description",
        content:
          "Record bakery wastage — unsold, spoiled or failed batches — and let the Head Pastry Chef review every entry.",
      },
      { property: "og:title", content: "Pastry Wastage — NEØ" },
      {
        property: "og:description",
        content: "Bakery wastage recorded by the chef and reviewed by the Head Pastry Chef.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PastryGuard feature="pastry-waste">
      <PastryWastagePage />
    </PastryGuard>
  ),
});

function PastryWastagePage() {
  const { can } = useAuth();
  const mayReview = can("kitchen", "pastry-waste", "approve");

  const waste = usePastryWaste();
  const record = useRecordPastryWaste();
  const review = useReviewPastryWaste();

  const [open, setOpen] = useState(false);
  const [item, setItem] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState<string>("piece");
  const [reason, setReason] = useState("");
  const [cost, setCost] = useState("");

  const rows = (waste.data ?? []) as PastryRow[];

  return (
    <div>
      <PageHeader
        eyebrow="Pastry & Bakery"
        title="Wastage"
        description="Bakery produces ahead of demand, so wastage is part of the trade. Record it honestly — the Head Pastry Chef reviews every entry and nobody reviews their own."
        actions={<Button onClick={() => setOpen(true)}>Record wastage</Button>}
      />

      <SectionCard title="Recorded wastage" description="Most recent first.">
        <QueryState
          isLoading={waste.isLoading}
          error={waste.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No wastage recorded"
              description="Nothing has been written off in pastry yet."
            />
          }
        >
          <div className="space-y-2">
            {rows.map((r) => {
              const id = String(r["id"]);
              const st = String(r["status"]);
              return (
                <div
                  key={id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 p-3"
                >
                  <div>
                    <p className="text-sm font-medium">{pastryStr(r["ingredient_name"])}</p>
                    <p className="text-xs text-muted-foreground">
                      {pastryNum(r["quantity"])} {pastryStr(r["unit"], "piece")} ·{" "}
                      {pastryStr(r["waste_number"])} ·{" "}
                      {r["occurred_at"] ? new Date(String(r["occurred_at"])).toLocaleString() : "—"}
                    </p>
                    {r["reason"] ? (
                      <p className="mt-1 text-xs text-muted-foreground">{pastryStr(r["reason"])}</p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <PastryStatusBadge status={st} />
                    {mayReview && st === "pending-review" ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => review.mutate({ recordId: id, decision: "approved" })}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const comment = window.prompt("Why is this rejected?");
                            if (!comment?.trim()) return;
                            review.mutate({ recordId: id, decision: "rejected", comment });
                          }}
                        >
                          Reject
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </QueryState>
      </SectionCard>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record pastry wastage</DialogTitle>
            <DialogDescription>Say what was lost, how much, and why.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="waste-item">Product or ingredient</Label>
              <Input id="waste-item" value={item} onChange={(e) => setItem(e.target.value)} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label htmlFor="waste-qty">Quantity</Label>
                <Input
                  id="waste-qty"
                  type="number"
                  min="0"
                  step="0.1"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="waste-unit">Unit</Label>
                <Select value={unit} onValueChange={setUnit}>
                  <SelectTrigger id="waste-unit">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PASTRY_UNITS.map((u) => (
                      <SelectItem key={u} value={u}>
                        {u}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="waste-cost">Est. cost</Label>
                <Input
                  id="waste-cost"
                  type="number"
                  min="0"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="waste-reason">Reason</Label>
              <Textarea
                id="waste-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!item.trim() || record.isPending}
              onClick={async () => {
                await record.mutateAsync({
                  item: item.trim(),
                  quantity: Number(quantity) || 0,
                  unit,
                  reason: reason.trim(),
                  estimatedCost: cost ? Number(cost) : null,
                });
                setItem("");
                setReason("");
                setCost("");
                setOpen(false);
              }}
            >
              Record
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
