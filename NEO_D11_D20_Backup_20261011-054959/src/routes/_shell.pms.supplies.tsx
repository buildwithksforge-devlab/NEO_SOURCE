import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Send } from "lucide-react";
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
import { EmptyState, PmsGuard, QueryState } from "@/components/pms/PmsShared";
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/pms";
import {
  FO_PRIORITIES,
  FO_SUPPLY_SUGGESTIONS,
  num,
  str,
  useFrontOfficeStockNeeds,
  useReportStockNeed,
  useReviewStockNeed,
  type FrontOfficeRow,
} from "@/lib/front-office-department";

export const Route = createFileRoute("/_shell/pms/supplies")({
  head: () => ({
    meta: [
      { title: "Front Desk Supplies — NEØ" },
      {
        name: "description",
        content:
          "Front desk supply needs: receptionists report what the desk is short of and the Front Office Manager reviews every request.",
      },
      { property: "og:title", content: "Front Desk Supplies — NEØ" },
      {
        property: "og:description",
        content:
          "Report and review front desk supply needs. Stock balances stay owned by Inventory & Stores.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PmsGuard action="stock_needs.view">
      <FrontDeskSuppliesPage />
    </PmsGuard>
  ),
});

const NEED_TONE: Record<string, "success" | "warning" | "destructive" | "default"> = {
  pending: "warning",
  acknowledged: "default",
  requisitioned: "success",
  declined: "destructive",
  closed: "default",
};

function FrontDeskSuppliesPage() {
  const { can } = useAuth();
  const mayReport = can("pms", "stock_needs.create");
  const mayReview = can("pms", "requisitions.create");

  const needs = useFrontOfficeStockNeeds("all");
  const report = useReportStockNeed();
  const review = useReviewStockNeed();

  const [needOpen, setNeedOpen] = useState(false);
  const [item, setItem] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unit, setUnit] = useState("unit");
  const [priority, setPriority] = useState("normal");
  const [notes, setNotes] = useState("");

  const rows = (needs.data ?? []) as FrontOfficeRow[];
  const pending = rows.filter((r) => String(r["status"] ?? "pending") === "pending");

  const submitNeed = () =>
    report.mutate(
      { item, quantity: Number(quantity) || 0, unit, priority, notes },
      {
        onSuccess: () => {
          setNeedOpen(false);
          setItem("");
          setQuantity("1");
          setNotes("");
        },
      },
    );

  return (
    <div>
      <PageHeader
        eyebrow="Front Office"
        title="Front Desk Supplies"
        description="Report what the desk is short of. The Front Office Manager reviews each need and requisitions it from Inventory & Stores — Front Office never adjusts a stock balance."
        actions={
          <div className="flex flex-wrap gap-2">
            {mayReview ? (
              <Button variant="outline" asChild>
                <Link to="/pms/requisitions">Requisitions to Stores</Link>
              </Button>
            ) : null}
            {mayReport ? (
              <Button onClick={() => setNeedOpen(true)}>
                <Send className="mr-2 h-4 w-4" /> Report stock need
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <SectionCard title="Pending review">
          <p className="text-3xl font-semibold">{needs.isLoading ? "—" : pending.length}</p>
        </SectionCard>
        <SectionCard title="Requisitioned">
          <p className="text-3xl font-semibold">
            {rows.filter((r) => String(r["status"]) === "requisitioned").length}
          </p>
        </SectionCard>
        <SectionCard title="Urgent open">
          <p className="text-3xl font-semibold">
            {pending.filter((r) => String(r["priority"]) === "urgent").length}
          </p>
        </SectionCard>
      </div>

      <SectionCard
        title="Reported stock needs"
        description="Raised by the front desk. Only a manager with requisition authority can requisition or decline a need."
      >
        <QueryState
          isLoading={needs.isLoading}
          error={needs.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No stock needs reported"
              description="When the desk runs low on registration cards, receipt rolls or key cards, report it here and the manager picks it up."
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
                  <TableHead className="text-right">Decision</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const id = String(r["id"]);
                  const status = String(r["status"] ?? "pending");
                  const openState = status === "pending" || status === "acknowledged";
                  return (
                    <TableRow key={id}>
                      <TableCell className="font-medium">
                        {str(r["item"])}
                        {r["notes"] ? (
                          <div className="text-xs font-normal text-muted-foreground">
                            {str(r["notes"], "")}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {num(r["quantity"])} {str(r["unit"], "unit")}
                      </TableCell>
                      <TableCell>{titleCase(str(r["priority"], "normal"))}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r["created_at"] ? new Date(String(r["created_at"])).toLocaleString() : "—"}
                      </TableCell>
                      <TableCell>
                        <StatusPill tone={NEED_TONE[status] ?? "default"}>
                          {titleCase(status)}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="space-x-2 text-right">
                        {mayReview && openState ? (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={review.isPending}
                              onClick={() => review.mutate({ needId: id, decision: "requisition" })}
                            >
                              Requisitioned
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={review.isPending}
                              onClick={() => review.mutate({ needId: id, decision: "decline" })}
                            >
                              Decline
                            </Button>
                          </>
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

      <Dialog open={needOpen} onOpenChange={setNeedOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Report a stock need</DialogTitle>
            <DialogDescription>
              This goes to the Front Office Manager, who raises the Stores requisition. It never
              changes a stock balance.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="fo-need-item">Item</Label>
              <Input
                id="fo-need-item"
                value={item}
                onChange={(e) => setItem(e.target.value)}
                placeholder="e.g. Guest registration cards"
                list="fo-supply-suggestions"
              />
              <datalist id="fo-supply-suggestions">
                {FO_SUPPLY_SUGGESTIONS.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <Label htmlFor="fo-need-qty">Quantity</Label>
                <Input
                  id="fo-need-qty"
                  type="number"
                  min="1"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="fo-need-unit">Unit</Label>
                <Input id="fo-need-unit" value={unit} onChange={(e) => setUnit(e.target.value)} />
              </div>
              <div>
                <Label>Priority</Label>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FO_PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p}>
                        {titleCase(p)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label htmlFor="fo-need-notes">Notes</Label>
              <Textarea
                id="fo-need-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNeedOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={submitNeed}
              disabled={report.isPending || !item.trim() || Number(quantity) <= 0}
            >
              Report need
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
