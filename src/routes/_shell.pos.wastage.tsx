import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
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
import { EmptyState, PosGuard, QueryState } from "@/components/pos/PosShared";
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

export const Route = createFileRoute("/_shell/pos/wastage")({
  head: () => ({
    meta: [
      { title: "F&B Wastage Log — NEØ" },
      {
        name: "description",
        content:
          "Record restaurant and coffee station wastage with a written reason, then have it reviewed by the department head before it counts against cost.",
      },
      { property: "og:title", content: "F&B Wastage Log — NEØ" },
      {
        property: "og:description",
        content:
          "Wastage capture and review for the Food & Beverage department, with cost by category.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PosGuard action="wastage.view" path="/pos/wastage">
      <WastagePage />
    </PosGuard>
  ),
});

const CATEGORIES = [
  "preparation",
  "spoilage",
  "breakage",
  "over-production",
  "customer-return",
  "expiry",
];

const TONE: Record<string, "success" | "warning" | "destructive" | "default"> = {
  approved: "success",
  pending: "warning",
  rejected: "destructive",
};

function WastagePage() {
  const { can, user } = useAuth();
  const showCost = useVisibility().canSeeCost("production-cost");
  const [status, setStatus] = useState("all");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    item: "",
    quantity: "",
    unit: "",
    category: "preparation",
    reason: "",
    cost: "",
  });

  const records = useWasteRecords(status);
  const record = useRecordWaste();
  const review = useReviewWaste();

  const mayRecord = can("pos", "wastage.create");
  const mayReview = can("pos", "wastage.approve");

  const rows = (records.data ?? []) as FnbRow[];
  const summary = useMemo(() => summariseWaste(rows), [rows]);

  const submit = () =>
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
          setForm({
            item: "",
            quantity: "",
            unit: "",
            category: "preparation",
            reason: "",
            cost: "",
          });
        },
      },
    );

  return (
    <div>
      <PageHeader
        eyebrow="Food & Beverage"
        title="Wastage Log"
        description="Every write-off carries a written reason and a named recorder. The department head reviews it — nobody can approve their own wastage."
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

      {showCost && summary.byCategory.size > 0 ? (
        <SectionCard title="Cost by category" className="mb-6">
          <div className="grid gap-3 sm:grid-cols-3">
            {[...summary.byCategory.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([category, cost]) => (
                <div key={category} className="rounded-lg border border-border/70 p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    {titleCase(category.replace(/-/g, " "))}
                  </p>
                  <p className="text-lg font-semibold">{money(cost)}</p>
                </div>
              ))}
          </div>
        </SectionCard>
      ) : null}

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
              description="Log preparation loss, spoilage or breakage as it happens so cost of sales stays honest."
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
            <DialogTitle>Record wastage</DialogTitle>
            <DialogDescription>
              A written reason is required — the record goes to your department head for review.
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
                  placeholder="kg, litres, pieces"
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
