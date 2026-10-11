import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { PageHeader, SectionCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { EmptyState, OpsGuard, QueryState } from "@/components/operations/OpsShared";
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
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/operations";
import {
  MAINTENANCE_MATERIALS,
  maintStr,
  useMaintenanceMaterialNeeds,
  useReportMaintenanceNeed,
  useReviewMaintenanceNeed,
  type MaintRow,
} from "@/lib/maintenance-department";

export const Route = createFileRoute("/_shell/maintenance/supplies")({
  head: () => ({
    meta: [
      { title: "Maintenance Materials & Needs — NEØ" },
      {
        name: "description",
        content:
          "Officers and ground workers report the materials they need; the Maintenance Manager decides what goes to Stores as a requisition.",
      },
      { property: "og:title", content: "Maintenance Materials & Needs — NEØ" },
      {
        property: "og:description",
        content: "Report spares, tools and consumables needed for maintenance and grounds work.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="maintenance" action="supplies.view">
      <MaintenanceSuppliesPage />
    </OpsGuard>
  ),
});

const TONE: Record<string, "success" | "warning" | "destructive" | "default"> = {
  requisitioned: "success",
  acknowledged: "warning",
  pending: "warning",
  declined: "destructive",
  closed: "default",
};

function MaintenanceSuppliesPage() {
  const { can } = useAuth();
  const needs = useMaintenanceMaterialNeeds();
  const report = useReportMaintenanceNeed();
  const review = useReviewMaintenanceNeed();
  const mayReport = can("maintenance", "supplies.create");
  const mayReview =
    can("maintenance", "requisitions.create") || can("maintenance", "supplies.approve");

  const [open, setOpen] = useState(false);
  const [item, setItem] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState("unit");
  const [priority, setPriority] = useState("normal");
  const [notes, setNotes] = useState("");

  const rows = (needs.data ?? []) as MaintRow[];
  const openCount = rows.filter((r) =>
    ["pending", "acknowledged"].includes(String(r["status"])),
  ).length;

  return (
    <div>
      <PageHeader
        eyebrow="Maintenance Department"
        title="Materials & needs"
        description="Report what the work needs. Only the Maintenance Manager turns a need into a Stores requisition."
        actions={
          mayReport ? (
            <Button onClick={() => setOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> Report a need
            </Button>
          ) : null
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <SectionCard title="Awaiting the Manager">
          <p className="text-3xl font-semibold">{openCount}</p>
        </SectionCard>
        <SectionCard title="Sent to Stores">
          <p className="text-3xl font-semibold">
            {rows.filter((r) => String(r["status"]) === "requisitioned").length}
          </p>
        </SectionCard>
        <SectionCard title="Reported (last 200)">
          <p className="text-3xl font-semibold">{rows.length}</p>
        </SectionCard>
      </div>

      <SectionCard
        title="Reported needs"
        description="Spares, tools, consumables and grounds materials."
      >
        <QueryState
          isLoading={needs.isLoading}
          error={needs.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No material needs reported"
              description="A technician short of a tap washer, or a ground worker out of mower fuel, reports it here."
            />
          }
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Quantity</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Reported</TableHead>
                  <TableHead>Status</TableHead>
                  {mayReview ? <TableHead className="text-right">Decision</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const status = String(r["status"] ?? "pending");
                  return (
                    <TableRow key={String(r["id"])}>
                      <TableCell className="font-medium">{maintStr(r["item"])}</TableCell>
                      <TableCell>
                        {maintStr(r["quantity"], "0")} {maintStr(r["unit"], "unit")}
                      </TableCell>
                      <TableCell>{titleCase(maintStr(r["priority"], "normal"))}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r["created_at"] ? new Date(String(r["created_at"])).toLocaleString() : "—"}
                      </TableCell>
                      <TableCell>
                        <StatusPill tone={TONE[status] ?? "default"}>
                          {titleCase(status)}
                        </StatusPill>
                      </TableCell>
                      {mayReview ? (
                        <TableCell className="text-right">
                          {["pending", "acknowledged"].includes(status) ? (
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={review.isPending}
                                onClick={() =>
                                  review.mutate({
                                    needId: String(r["id"]),
                                    decision: "acknowledge",
                                  })
                                }
                              >
                                Acknowledge
                              </Button>
                              <Button
                                size="sm"
                                disabled={review.isPending}
                                onClick={() =>
                                  review.mutate({
                                    needId: String(r["id"]),
                                    decision: "requisition",
                                  })
                                }
                              >
                                Send to Stores
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={review.isPending}
                                onClick={() =>
                                  review.mutate({ needId: String(r["id"]), decision: "decline" })
                                }
                              >
                                Decline
                              </Button>
                            </div>
                          ) : (
                            <span className="text-sm text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      ) : null}
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
            <DialogTitle>Report a material need</DialogTitle>
            <DialogDescription>
              This goes to the Maintenance Manager, not straight to Stores.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="item">Item</Label>
              <Input
                id="item"
                value={item}
                onChange={(e) => setItem(e.target.value)}
                list="maintenance-materials"
                placeholder="e.g. Light bulbs"
              />
              <datalist id="maintenance-materials">
                {MAINTENANCE_MATERIALS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <Label htmlFor="qty">Quantity</Label>
                <Input
                  id="qty"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="unit">Unit</Label>
                <Input id="unit" value={unit} onChange={(e) => setUnit(e.target.value)} />
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
              <Label htmlFor="need-notes">What it is for</Label>
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
                  { item, quantity: Number(quantity) || 1, unit, priority, notes },
                  {
                    onSuccess: () => {
                      setOpen(false);
                      setItem("");
                      setNotes("");
                    },
                  },
                )
              }
            >
              Report need
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
