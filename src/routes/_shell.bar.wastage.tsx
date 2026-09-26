import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { BarGuard, EmptyState, QueryState } from "@/components/bar/BarShared";
import { filterToBarScope, useBarScopeIds } from "@/lib/bar";
import { useAuth } from "@/lib/auth";
import { useVisibility } from "@/lib/visibility";
import { money, titleCase } from "@/lib/pos";
import {
  num,
  str,
  summariseWaste,
  useRecordWaste,
  useReviewWaste,
  useWasteRecords,
  type FnbRow,
} from "@/lib/fnb";

export const Route = createFileRoute("/_shell/bar/wastage")({
  head: () => ({
    meta: [
      { title: "Bar Wastage & Spillage — NEØ" },
      {
        name: "description",
        content:
          "Log bar spillage, breakage and over-pour with a written reason. The Bar Manager reviews every record before it counts against beverage cost.",
      },
      { property: "og:title", content: "Bar Wastage & Spillage — NEØ" },
      {
        property: "og:description",
        content: "Bar wastage capture and review with cost by category.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <BarGuard action="wastage.view">
      <BarWastagePage />
    </BarGuard>
  ),
});

const CATEGORIES = ["spillage", "breakage", "over-pour", "spoilage", "customer-return", "expiry"];

const TONE: Record<string, "success" | "warning" | "destructive" | "default"> = {
  approved: "success",
  pending: "warning",
  rejected: "destructive",
};

function BarWastagePage() {
  const { can, user } = useAuth();
  const showCost = useVisibility().canSeeCost("production-cost");
  const [status, setStatus] = useState("all");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    item: "",
    quantity: "",
    unit: "",
    category: "spillage",
    reason: "",
    cost: "",
  });

  const records = useWasteRecords(status);
  const record = useRecordWaste();
  const review = useReviewWaste();

  const mayRecord = can("bar", "wastage.create");
  const mayReview = can("bar", "wastage.approve");

  const barScope = useBarScopeIds();
  const rows = useMemo(
    () => filterToBarScope((records.data ?? []) as FnbRow[], barScope.data, "station_id"),
    [records.data, barScope.data],
  );
  const summary = useMemo(() => summariseWaste(rows), [rows]);

  const submit = () => {
    // The write-off is a cost entry and a reviewed record: it needs an item,
    // a real quantity and a written reason before it leaves this dialog.
    if (!form.item.trim()) {
      toast.error("Name the item that was wasted.");
      return;
    }
    if (!(Number(form.quantity) > 0)) {
      toast.error("Enter a quantity greater than zero.");
      return;
    }
    if (!form.reason.trim()) {
      toast.error("A written reason is required before the Bar Manager can review this.");
      return;
    }
    record.mutate(
      {
        item: form.item,
        quantity: Number(form.quantity) || 0,
        unit: form.unit,
        category: form.category,
        reason: form.reason,
        estimatedCost: form.cost === "" ? null : Number(form.cost) || 0,
      },
      {
        onSuccess: () => {
          setOpen(false);
          setForm({ item: "", quantity: "", unit: "", category: "spillage", reason: "", cost: "" });
        },
      },
    );
  };


  return (
    <div>
      <PageHeader
        eyebrow="Bar Department"
        title="Wastage & Spillage"
        description="Every write-off carries a written reason and a named recorder. The Bar Manager reviews it — nobody approves their own wastage."
        actions={
          mayRecord ? (
            <Button onClick={() => setOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> Record wastage
            </Button>
          ) : null
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-4">
        <SectionCard title="Wastage cost">
          <p className="text-3xl font-semibold">{showCost ? money(summary.cost) : "Restricted"}</p>
        </SectionCard>
        <SectionCard title="Awaiting review">
          <p className="text-3xl font-semibold">{summary.pending}</p>
        </SectionCard>
        <SectionCard title="Approved">
          <p className="text-3xl font-semibold">{summary.approved}</p>
        </SectionCard>
        <SectionCard title="Records">
          <p className="text-3xl font-semibold">{summary.count}</p>
        </SectionCard>
      </div>

      <SectionCard
        title="Wastage records"
        actions={
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["all", "pending", "approved", "rejected"].map((s) => (
                <SelectItem key={s} value={s}>
                  {s === "all" ? "All statuses" : titleCase(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        <QueryState
          isLoading={records.isLoading}
          error={records.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No wastage recorded"
              description="Log spillage, breakage or over-pour as it happens so beverage cost stays honest."
            />
          }
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead>Quantity</TableHead>
                  <TableHead>Category</TableHead>
                  {showCost ? <TableHead>Cost</TableHead> : null}
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const state = str(r["status"], "pending");
                  const mine = String(r["recorded_by"] ?? "") === (user?.id ?? "");
                  return (
                    <TableRow key={String(r["id"])}>
                      <TableCell className="font-medium">{str(r["waste_number"])}</TableCell>
                      <TableCell>
                        {String(r["occurred_at"] ?? "")
                          .slice(0, 16)
                          .replace("T", " ")}
                      </TableCell>
                      <TableCell>{str(r["ingredient_name"])}</TableCell>
                      <TableCell>
                        {num(r["quantity"])} {str(r["unit"], "")}
                      </TableCell>
                      <TableCell>
                        {titleCase(str(r["category"], "other").replace(/-/g, " "))}
                      </TableCell>
                      {showCost ? <TableCell>{money(num(r["estimated_cost"]))}</TableCell> : null}
                      <TableCell>
                        <StatusPill tone={TONE[state] ?? "default"}>{titleCase(state)}</StatusPill>
                      </TableCell>
                      <TableCell className="text-right">
                        {mayReview && state === "pending" && !mine ? (
                          <span className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                review.mutate({ wasteId: String(r["id"]), decision: "approve" })
                              }
                            >
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                review.mutate({ wasteId: String(r["id"]), decision: "reject" })
                              }
                            >
                              Reject
                            </Button>
                          </span>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </SectionCard>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record bar wastage</DialogTitle>
            <DialogDescription>
              A written reason is required — the record goes to the Bar Manager for review.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="item">Item</Label>
              <Input
                id="item"
                value={form.item}
                onChange={(e) => setForm({ ...form, item: e.target.value })}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <Label htmlFor="qty">Quantity</Label>
                <Input
                  id="qty"
                  type="number"
                  min="0"
                  value={form.quantity}
                  onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="unit">Unit</Label>
                <Input
                  id="unit"
                  placeholder="bottles, tots, litres"
                  value={form.unit}
                  onChange={(e) => setForm({ ...form, unit: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="cost">Estimated cost</Label>
                <Input
                  id="cost"
                  type="number"
                  min="0"
                  value={form.cost}
                  onChange={(e) => setForm({ ...form, cost: e.target.value })}
                />
              </div>
            </div>
            <div>
              <Label>Category</Label>
              <Select
                value={form.category}
                onValueChange={(v) => setForm({ ...form, category: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {titleCase(c.replace(/-/g, " "))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="reason">Reason</Label>
              <Textarea
                id="reason"
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={record.isPending}>
              Record wastage
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
