import { useMemo, useState } from "react";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { createFileRoute } from "@tanstack/react-router";
import { PackageSearch, Plus, Trash2 } from "lucide-react";
import {
  PageHeader,
  SectionCard,
  StatusPill,
} from "@/components/common/DataDisplay";
import {
  RequisitionWorkspace,
  InspectorSection,
  InspectorField,
  type RequisitionRow,
} from "@/components/common/RequisitionWorkspace";
import { CatalogueGroup, CatalogueRow } from "@/components/common/CatalogueWorkspace";
import type { SummaryFigure } from "@/components/common/SummaryStrip";

import { StockItemNotice } from "@/components/common/StockItemNotice";
import { awaitingReceipt, ConfirmReceiptButton } from "@/components/common/ConfirmReceiptButton";
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
import { DeliveryGuard, EmptyState, QueryState } from "@/components/delivery/DeliveryGuard";
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/pos";
import {
  useDepartmentRequisitions,
  useRaiseRequisition,
  useStockItemOptions,
  type FnbRow,
  type RequisitionLineInput,
} from "@/lib/fnb";
import {
  SUPPLY_PRIORITIES,
  num,
  str,
  useDeliveryDepartment,
  useDeliverySupplyRequests,
  useReviewSupplyRequest,
  type DeliveryRow,
} from "@/lib/delivery-department";

export const Route = createFileRoute("/_shell/delivery/requisitions")({
  head: () => ({
    meta: [
      { title: "Delivery Requisitions & Supply Needs — NEØ" },
      {
        name: "description",
        content:
          "Delivery requisitions to Stores plus the rider supply and equipment needs the Delivery Manager reviews.",
      },
      { property: "og:title", content: "Delivery Requisitions & Supply Needs — NEØ" },
      {
        property: "og:description",
        content:
          "Request delivery bags, packaging and rider equipment from Stores and review rider supply needs.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <DeliveryGuard action="requisitions.view">
      <DeliveryRequisitionsPage />
    </DeliveryGuard>
  ),
});

const STATUS_TONE: Record<string, "success" | "warning" | "destructive" | "default"> = {
  received: "success",
  issued: "success",
  approved: "success",
  fulfilled: "success",
  "partially-issued": "warning",
  "partially-received": "warning",
  "pending-supervisor": "warning",
  "pending-stores": "warning",
  pending: "warning",
  rejected: "destructive",
  cancelled: "destructive",
};

const emptyLine = (): RequisitionLineInput => ({
  description: "",
  unit: "",
  quantity_requested: 0,
});

function DeliveryRequisitionsPage() {
  const { can } = useAuth();
  const department = useDeliveryDepartment();
  const requisitions = useDepartmentRequisitions("all");
  const items = useStockItemOptions();
  const raise = useRaiseRequisition();
  const supply = useDeliverySupplyRequests("all");
  const review = useReviewSupplyRequest();

  const mayRaise = can("delivery", "requisitions.create");
  const mayReview = can("delivery", "requisitions.approve");
  const mayConfirmReceipt = can("delivery", "requisitions.edit");

  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<RequisitionLineInput[]>([emptyLine()]);
  const [requiredDate, setRequiredDate] = useState("");
  const [priority, setPriority] = useState("normal");
  const [reason, setReason] = useState("");
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [selectedReqId, setSelectedReqId] = useState<string | null>(null);

  const departmentId = department.data?.["id"] ? String(department.data["id"]) : null;
  const options = (items.data ?? []) as FnbRow[];

  const rows = useMemo(
    () =>
      ((requisitions.data ?? []) as FnbRow[]).filter((r) =>
        departmentId ? String(r["department_id"] ?? "") === departmentId : true,
      ),
    [requisitions.data, departmentId],
  );

  const supplyRows = (supply.data ?? []) as DeliveryRow[];
  const pendingSupply = supplyRows.filter((r) => String(r["status"]) === "pending");

  const setLine = (index: number, patch: Partial<RequisitionLineInput>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  const submit = () => {
    const payload = lines
      .filter(
        (l) => num(l.quantity_requested) > 0 && (l.stock_item_id || (l.description ?? "").trim()),
      )
      .map((l) => ({ ...l, quantity_requested: num(l.quantity_requested) }));
    raise.mutate(
      {
        lines: payload,
        requiredDate: requiredDate || null,
        priority,
        reason,
        departmentId,
      },
      {
        onSuccess: () => {
          setOpen(false);
          setLines([emptyLine()]);
          setRequiredDate("");
          setReason("");
        },
      },
    );
  };

  return (
    <div>
      <PageHeader
        eyebrow="Delivery Department"
        title="Requisitions & Supply Needs"
        icon={PackageSearch}
        description="Delivery requests what it needs — bags, packaging, rain gear, rider equipment. Stores approves and issues; Delivery never moves a Stores balance itself."
        actions={
          mayRaise ? (
            <Button onClick={() => setOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> New requisition
            </Button>
          ) : null
        }
      />

      <SectionCard
        title="Rider supply & equipment needs"
        description="Riders cannot requisition from Stores directly. They report the need here and the Delivery Manager decides what goes to Stores."
      >
        <QueryState
          isLoading={supply.isLoading}
          error={supply.error}
          isEmpty={supplyRows.length === 0}
          empty={
            <EmptyState
              title="No supply needs reported"
              description="A rider reporting a damaged delivery bag, missing rain gear or a helmet replacement appears here."
            />
          }
        >
          <CatalogueGroup label="Reported by riders" count={supplyRows.length}>
            {supplyRows.map((r) => {
              const id = String(r["id"]);
              const state = String(r["status"] ?? "pending");
              return (
                <CatalogueRow
                  key={id}
                  title={str(r["item"])}
                  subtitle={`${num(r["quantity"])} ${str(r["unit"], "")} · ${titleCase(
                    str(r["priority"], "normal"),
                  )} · ${new Date(String(r["created_at"])).toLocaleString()}${
                    r["notes"] ? ` · ${str(r["notes"], "")}` : ""
                  }`}
                  chips={
                    <StatusPill tone={STATUS_TONE[state] ?? "default"}>
                      {titleCase(state)}
                    </StatusPill>
                  }
                  actions={
                    mayReview && state === "pending" ? (
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Input
                          className="w-40"
                          placeholder="Note (optional)"
                          aria-label={`Review note for ${str(r["item"])}`}
                          value={reviewNotes[id] ?? ""}
                          onChange={(e) => setReviewNotes((p) => ({ ...p, [id]: e.target.value }))}
                        />
                        <Button
                          size="sm"
                          disabled={review.isPending}
                          onClick={() =>
                            review.mutate({
                              requestId: id,
                              decision: "approved",
                              notes: reviewNotes[id] ?? "",
                            })
                          }
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={review.isPending}
                          onClick={() =>
                            review.mutate({
                              requestId: id,
                              decision: "rejected",
                              notes: reviewNotes[id] ?? "",
                            })
                          }
                        >
                          Reject
                        </Button>
                      </div>
                    ) : mayReview && state === "approved" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={review.isPending}
                        onClick={() => review.mutate({ requestId: id, decision: "fulfilled" })}
                      >
                        Mark issued to rider
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {str(r["review_notes"], "—")}
                      </span>
                    )
                  }
                />
              );
            })}
          </CatalogueGroup>
        </QueryState>
      </SectionCard>


      <div className="mt-6">
        <RequisitionWorkspace
          lead={{
            id: "total",
            label: "Stores requisitions",
            value: requisitions.isLoading ? "\u2026" : rows.length,
            hint: "Raised by this department",
          }}
          figures={([
            {
              id: "issued",
              label: "Issued, awaiting receipt",
              value: requisitions.isLoading
                ? "\u2026"
                : rows.filter((r) => String(r["status"] ?? "").includes("issued")).length,
              tone: "warning",
            },
          ] as SummaryFigure[])}
          isLoading={requisitions.isLoading}
          error={requisitions.error}
          rows={rows.map((r) => {
            const state = String(r["status"] ?? "");
            const reqLines = (r["internal_requisition_lines"] as FnbRow[] | null) ?? [];
            return {
              id: String(r["id"]),
              title: str(r["request_number"]),
              subtitle: `Raised ${str(r["request_date"])} \u00b7 Required ${str(r["required_date"])} \u00b7 ${reqLines.length} line${reqLines.length === 1 ? "" : "s"}`,
              chips: (
                <StatusPill tone={STATUS_TONE[state] ?? "default"}>
                  {titleCase(state.replace(/-/g, " "))}
                </StatusPill>
              ),
            } satisfies RequisitionRow;
          })}
          emptyState={
            <EmptyState
              title="No requisitions yet"
              description="Raise a requisition when Delivery needs bags, packaging or rider equipment from Stores."
            />
          }
          selectedId={selectedReqId}
          onSelect={setSelectedReqId}
          renderInspector={(id) => {
            const r = rows.find((row) => String(row["id"]) === id);
            if (!r) return null;
            const state = String(r["status"] ?? "");
            const reqLines = (r["internal_requisition_lines"] as FnbRow[] | null) ?? [];
            return {
              title: str(r["request_number"]),
              subtitle: titleCase(str(r["priority"], "normal")),
              chips: (
                <StatusPill tone={STATUS_TONE[state] ?? "default"}>
                  {titleCase(state.replace(/-/g, " "))}
                </StatusPill>
              ),
              sections: (
                <InspectorSection title="Request">
                  <InspectorField label="Raised">{str(r["request_date"])}</InspectorField>
                  <InspectorField label="Required by">{str(r["required_date"])}</InspectorField>
                  <InspectorField label="Lines">{reqLines.length}</InspectorField>
                  {/* Only the department that raised it confirms custody, and
                      only with its own edit authority — Stores cannot confirm
                      on its behalf. Canonical engine, no second movement. */}
                  {mayConfirmReceipt && awaitingReceipt(r) ? (
                    <div className="pt-2">
                      <ConfirmReceiptButton requisition={r} />
                    </div>
                  ) : null}
                </InspectorSection>
              ),
            };
          }}
        />
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>New Stores requisition</DialogTitle>
            <DialogDescription>
              Stores reviews, approves and issues. Quantities issued update stock, never this
              screen.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <StockItemNotice query={items} />
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="required">Required by</Label>
                <NeoDatePicker
                  id="required"
                  value={requiredDate}
                  onChange={setRequiredDate}
                />
              </div>
              <div>
                <Label>Priority</Label>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUPPLY_PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p}>
                        {titleCase(p)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-3">
              {lines.map((line, index) => (
                <div key={index} className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]">
                  <Select
                    value={line.stock_item_id ?? "free"}
                    onValueChange={(v) => {
                      const item = options.find((o) => String(o["id"]) === v);
                      setLine(index, {
                        stock_item_id: v === "free" ? null : v,
                        description: item ? str(item["name"], "") : (line.description ?? ""),
                        unit: item ? str(item["base_unit"], "") : (line.unit ?? ""),
                      });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Stock item" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="free">Not in Stores catalogue</SelectItem>
                      {options.map((o) => (
                        <SelectItem key={String(o["id"])} value={String(o["id"])}>
                          {str(o["name"])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    placeholder="Description"
                    value={line.description ?? ""}
                    onChange={(e) => setLine(index, { description: e.target.value })}
                  />
                  <Input
                    type="number"
                    min="0"
                    placeholder="Qty"
                    value={line.quantity_requested === 0 ? "" : String(line.quantity_requested)}
                    onChange={(e) =>
                      setLine(index, { quantity_requested: Number(e.target.value) || 0 })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove line"
                    onClick={() =>
                      setLines((prev) =>
                        prev.length === 1 ? prev : prev.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLines((prev) => [...prev, emptyLine()])}
              >
                <Plus className="mr-2 h-4 w-4" /> Add line
              </Button>
            </div>

            <div>
              <Label htmlFor="reason">Reason</Label>
              <Textarea
                id="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="What Delivery needs this for"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={raise.isPending}>
              Send to Stores
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
