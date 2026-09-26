import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PackagePlus } from "lucide-react";
import { PageHeader, SectionCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { StockItemNotice } from "@/components/common/StockItemNotice";
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
import {
  awaitingReceipt,
  ConfirmReceiptButton,
} from "@/components/common/ConfirmReceiptButton";
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/pms";
import { useDepartmentRequisitions, useRaiseRequisition, useStockItemOptions } from "@/lib/fnb";
import {
  str,
  useFrontOfficeDepartment,
  useFrontOfficeStockNeeds,
  type FrontOfficeRow,
} from "@/lib/front-office-department";

export const Route = createFileRoute("/_shell/pms/requisitions")({
  head: () => ({
    meta: [
      { title: "Front Office Requisitions — NEØ" },
      {
        name: "description",
        content:
          "Front Office requisitions to Inventory & Stores: raise a request for desk consumables and follow it through to the store issue.",
      },
      { property: "og:title", content: "Front Office Requisitions — NEØ" },
      {
        property: "og:description",
        content:
          "Raise and track Front Office requisitions. Stores owns every stock balance and issue.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PmsGuard action="requisitions.view">
      <FrontOfficeRequisitionsPage />
    </PmsGuard>
  ),
});

const REQ_TONE: Record<string, "success" | "warning" | "destructive" | "default"> = {
  draft: "default",
  submitted: "warning",
  approved: "success",
  issued: "success",
  received: "success",
  rejected: "destructive",
  cancelled: "destructive",
};

function FrontOfficeRequisitionsPage() {
  const { can } = useAuth();
  const mayRaise = can("pms", "requisitions.create");
  // The department that raised the requisition confirms what it received.
  const mayConfirm = can("front-office", "requisitions", "edit");

  const department = useFrontOfficeDepartment();
  const requisitions = useDepartmentRequisitions();
  const stockItems = useStockItemOptions();
  const pendingNeeds = useFrontOfficeStockNeeds("pending");
  const raise = useRaiseRequisition();

  const [open, setOpen] = useState(false);
  const [stockItem, setStockItem] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");

  const stockRows = (stockItems.data ?? []) as FrontOfficeRow[];
  const departmentId = department.data?.["id"] ? String(department.data["id"]) : null;
  const rows = ((requisitions.data ?? []) as FrontOfficeRow[]).filter((r) =>
    departmentId ? String(r["department_id"] ?? "") === departmentId : true,
  );
  const pendingCount = ((pendingNeeds.data ?? []) as FrontOfficeRow[]).length;

  const submit = () => {
    const chosen = stockRows.find((r) => String(r["id"]) === stockItem);
    raise.mutate(
      {
        lines: [
          {
            stock_item_id: stockItem || null,
            description: chosen ? str(chosen["name"], "") : "",
            unit: chosen ? str(chosen["base_unit"], "unit") : "unit",
            quantity_requested: Number(quantity) || 0,
          },
        ],
        priority: "normal",
        reason: reason || "Front Office supplies",
        departmentId,
      },
      {
        onSuccess: () => {
          setOpen(false);
          setStockItem("");
          setQuantity("1");
          setReason("");
        },
      },
    );
  };

  return (
    <div>
      <PageHeader
        eyebrow="Front Office"
        title="Requisitions to Stores"
        description="Front Office → Inventory & Stores → Store Issue → Front Office. The desk can request and track, never adjust a balance."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link to="/pms/supplies">
                Reported needs{pendingCount ? ` (${pendingCount})` : ""}
              </Link>
            </Button>
            {mayRaise ? (
              <Button onClick={() => setOpen(true)}>
                <PackagePlus className="mr-2 h-4 w-4" /> Raise requisition
              </Button>
            ) : null}
          </div>
        }
      />

      <SectionCard
        title="Front Office requisitions"
        description="Every requisition raised for this department, with the status Stores has set."
      >
        <QueryState
          isLoading={requisitions.isLoading}
          error={requisitions.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No requisitions raised"
              description="Raise a requisition for front desk consumables and follow it through to the store issue."
            />
          }
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Request</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Lines</TableHead>
                  <TableHead>Raised</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Receipt</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const status = String(r["status"] ?? "draft");
                  const lines = (r["internal_requisition_lines"] ?? []) as FrontOfficeRow[];
                  const dept = (r["departments"] ?? {}) as FrontOfficeRow;
                  return (
                    <TableRow key={String(r["id"])}>
                      <TableCell className="font-medium">{str(r["request_number"])}</TableCell>
                      <TableCell>{str(dept["name"], "—")}</TableCell>
                      <TableCell>{lines.length}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r["created_at"]
                          ? new Date(String(r["created_at"])).toLocaleDateString()
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <StatusPill tone={REQ_TONE[status] ?? "default"}>
                          {titleCase(status.replace(/-/g, " "))}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="text-right">
                        {mayConfirm && awaitingReceipt(r) ? (
                          <ConfirmReceiptButton requisition={r} />
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
            <DialogTitle>Raise a Front Office requisition</DialogTitle>
            <DialogDescription>
              Stores receives the request and issues the stock. Front Office tracks it but never
              moves a balance.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <StockItemNotice query={stockItems} />
            <div>
              <Label>Stock item</Label>
              <Select value={stockItem} onValueChange={setStockItem}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a stock item" />
                </SelectTrigger>
                <SelectContent>
                  {stockRows.map((r) => (
                    <SelectItem key={String(r["id"])} value={String(r["id"])}>
                      {str(r["name"])} · {str(r["base_unit"], "unit")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="fo-req-qty">Quantity</Label>
              <Input
                id="fo-req-qty"
                type="number"
                min="1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="fo-req-reason">Reason</Label>
              <Textarea
                id="fo-req-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Front desk consumables for the week"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={raise.isPending || !stockItem || Number(quantity) <= 0}
            >
              Send to Stores
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
