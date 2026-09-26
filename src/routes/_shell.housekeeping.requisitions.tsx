import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PackagePlus } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, OpsGuard, QueryState } from "@/components/operations/OpsShared";
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
import {
  awaitingReceipt,
  ConfirmReceiptButton,
} from "@/components/common/ConfirmReceiptButton";
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/operations";
import { useDepartmentRequisitions, useRaiseRequisition, useStockItemOptions } from "@/lib/fnb";
import {
  str,
  useHousekeepingDepartment,
  useHousekeepingStockNeeds,
  type HkRow,
} from "@/lib/housekeeping-department";

export const Route = createFileRoute("/_shell/housekeeping/requisitions")({
  head: () => ({
    meta: [
      { title: "Housekeeping Requisitions — NEØ" },
      {
        name: "description",
        content:
          "Housekeeping requisitions to Inventory & Stores: request linen, chemicals and amenities and follow them to the store issue.",
      },
      { property: "og:title", content: "Housekeeping Requisitions — NEØ" },
      {
        property: "og:description",
        content:
          "Raise and track Housekeeping requisitions. Stores owns every stock balance and issue.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="housekeeping" action="requisitions.view">
      <HousekeepingRequisitionsPage />
    </OpsGuard>
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

function HousekeepingRequisitionsPage() {
  const { can } = useAuth();
  const mayRaise = can("housekeeping", "requisitions.create");
  // The requesting department confirms what it actually received.
  const mayConfirm = can("housekeeping", "requisitions", "edit");

  const department = useHousekeepingDepartment();
  const requisitions = useDepartmentRequisitions();
  const stockItems = useStockItemOptions();
  const pendingNeeds = useHousekeepingStockNeeds("pending");
  const raise = useRaiseRequisition();

  const [open, setOpen] = useState(false);
  const [stockItem, setStockItem] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");

  const stockRows = (stockItems.data ?? []) as HkRow[];
  const departmentId = department.data?.["id"] ? String(department.data["id"]) : null;
  const rows = ((requisitions.data ?? []) as HkRow[]).filter((r) =>
    departmentId ? String(r["department_id"] ?? "") === departmentId : true,
  );
  const pendingCount = ((pendingNeeds.data ?? []) as HkRow[]).length;

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
        reason: reason || "Housekeeping supplies",
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
        eyebrow="Housekeeping"
        title="Requisitions to Stores"
        description="Housekeeping → Inventory & Stores → Store Issue → Housekeeping. The department requests and tracks, never adjusts a balance."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link to="/housekeeping/supplies">
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
        title="Housekeeping requisitions"
        description="Every requisition raised for this department, with the status Stores has set."
      >
        <QueryState
          isLoading={requisitions.isLoading}
          error={requisitions.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No requisitions yet"
              description="Raise a requisition when a reported supply need has to be filled by Stores."
            />
          }
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Required</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Receipt</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const status = str(row["status"], "draft");
                  return (
                    <TableRow key={String(row["id"])}>
                      <TableCell className="font-medium">
                        {str(row["request_number"], "—")}
                      </TableCell>
                      <TableCell>{str(row["reason"], "—")}</TableCell>
                      <TableCell>{str(row["required_date"], "—")}</TableCell>
                      <TableCell>
                        <StatusPill tone={REQ_TONE[status] ?? "default"}>
                          {titleCase(status)}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="text-right">
                        {mayConfirm && awaitingReceipt(row) ? (
                          <ConfirmReceiptButton requisition={row} />
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </QueryState>
      </SectionCard>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Raise a Housekeeping requisition</DialogTitle>
            <DialogDescription>
              Stores receives, approves and issues. Housekeeping confirms receipt of what is issued.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <StockItemNotice query={stockItems} />
            <div className="space-y-2">
              <Label>Stock item</Label>
              <Select value={stockItem} onValueChange={setStockItem}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose an item held by Stores" />
                </SelectTrigger>
                <SelectContent>
                  {stockRows.map((r) => (
                    <SelectItem key={String(r["id"])} value={String(r["id"])}>
                      {str(r["name"], "Item")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="req-qty">Quantity</Label>
              <Input
                id="req-qty"
                type="number"
                min="1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="req-reason">Reason</Label>
              <Textarea
                id="req-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={raise.isPending || !stockItem}>
              Send to Stores
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
