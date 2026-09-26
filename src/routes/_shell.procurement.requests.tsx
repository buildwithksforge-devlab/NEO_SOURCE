import { useMemo, useState } from "react";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { createFileRoute } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import { ClipboardList } from "lucide-react";
import { PageHeader, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState } from "@/components/pms/PmsShared";
import {
  RequisitionWorkspace,
  InspectorSection,
  InspectorField,
  type RequisitionRow,
} from "@/components/common/RequisitionWorkspace";
import type { SummaryFigure } from "@/components/common/SummaryStrip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import { useTenant } from "@/lib/tenant";
import { formatMoney, statusTone, titleCase, type Row } from "@/lib/inventory";
import { describeRequestOrigin } from "@/lib/procurement";
import { usePurchaseRequests, useStockLocations, useSuppliers } from "@/lib/inventory-data";
import {
  newAttemptKey,
  useCreateOrderFromRequest,
  useDecideRequisition,
  useSetRequestLinePrice,
  useSubmitRequisition,
} from "@/lib/stores-lifecycle";

export const Route = createFileRoute("/_shell/procurement/requests")({
  head: () => ({
    meta: [
      { title: "Purchase requests — NEØ" },
      {
        name: "description",
        content:
          "Raise, approve and convert departmental requisitions into purchase orders under one controlled lifecycle.",
      },
      { property: "og:title", content: "Purchase requests — NEØ" },
      {
        property: "og:description",
        content:
          "Raise, approve and convert departmental requisitions into purchase orders under one controlled lifecycle.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

const GROUP_LABEL: Record<string, string> = {
  draft: "Drafts and returned requests",
  // A shortage handed over by Stores lands here: Procurement still has to
  // price it and put it in front of an approver.
  submitted: "Received from Stores — to be priced",
  pending_approval: "Awaiting approval",
  approved: "Approved — ready to order",
  ordered: "Ordered",
};

function Page() {
  const { tenant } = useTenant();
  const symbol = tenant.regional.currencySymbol;
  const requests = usePurchaseRequests();
  const suppliers = useSuppliers();
  const locations = useStockLocations();

  const { can } = useAuth();
  const canApprove = can("procurement", "requests", "approve");
  const canOrder = can("procurement", "lpos", "create");
  const canPrice = can("procurement", "requests", "create") || canApprove;

  const submit = useSubmitRequisition();
  const decide = useDecideRequisition();
  const convert = useCreateOrderFromRequest();
  const price = useSetRequestLinePrice();
  const [priceDraft, setPriceDraft] = useState<Record<string, string>>({});

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [convertFor, setConvertFor] = useState<Row | null>(null);
  const [supplierId, setSupplierId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [expected, setExpected] = useState("");
  const [attemptKey, setAttemptKey] = useState(newAttemptKey);

  const [rejectFor, setRejectFor] = useState<Row | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const rows = (requests.data ?? []) as Row[];
  const supplierRows = (suppliers.data ?? []) as Row[];
  const locationRows = (locations.data ?? []) as Row[];

  const grouped = useMemo(
    () => ({
      draft: rows.filter((r) => ["draft", "rejected"].includes(String(r["status"] ?? "draft"))),
      submitted: rows.filter((r) => String(r["status"]) === "submitted"),
      pending_approval: rows.filter((r) => String(r["status"]) === "pending_approval"),
      approved: rows.filter((r) => String(r["status"]) === "approved"),
      ordered: rows.filter((r) => String(r["status"]) === "ordered"),
    }),
    [rows],
  );

  function openConvert(request: Row) {
    setConvertFor(request);
    setSupplierId("");
    setLocationId("");
    setExpected("");
    setAttemptKey(newAttemptKey());
  }

  const groupOf = (r: Row): string => {
    const status = String(r["status"] ?? "draft");
    if (["draft", "rejected"].includes(status)) return GROUP_LABEL["draft"]!;
    if (status === "submitted") return GROUP_LABEL["submitted"]!;
    if (status === "pending_approval") return GROUP_LABEL["pending_approval"]!;
    if (status === "approved") return GROUP_LABEL["approved"]!;
    if (status === "ordered") return GROUP_LABEL["ordered"]!;
    return titleCase(status);
  };

  const workspaceRows: RequisitionRow[] = rows.map((r) => ({
    id: String(r["id"]),
    title: String(r["request_number"] ?? r["title"] ?? "Requisition"),
    subtitle: `${describeRequestOrigin(r)} · ${titleCase(String(r["priority"] ?? "normal"))} · est. ${formatMoney(r["estimated_total"], symbol)}`,
    chips: (
      <StatusPill tone={statusTone(String(r["status"] ?? ""))}>
        {titleCase(String(r["status"] ?? "draft"))}
      </StatusPill>
    ),
    group: groupOf(r),
  }));

  // A query that has not been allowed to run yet is still loading as far as
  // the screen is concerned — otherwise the page briefly claims zero requests.
  const loading = requests.isPending;

  const lead: SummaryFigure = {
    id: "total",
    label: "Purchase requests",
    value: loading ? "…" : rows.length,
  };
  const figures: SummaryFigure[] = [
    {
      id: "from-stores",
      label: "From Stores — to be priced",
      value: loading ? "…" : grouped.submitted.length,
      tone: grouped.submitted.length ? "warning" : "default",
    },
    {
      id: "pending",
      label: "Awaiting approval",
      value: loading ? "…" : grouped.pending_approval.length,
      tone: grouped.pending_approval.length ? "warning" : "success",
    },
    {
      id: "approved",
      label: "Ready to order",
      value: loading ? "…" : grouped.approved.length,
      tone: grouped.approved.length ? "info" : "default",
    },
    {
      id: "ordered",
      label: "Ordered",
      value: loading ? "…" : grouped.ordered.length,
      tone: "success",
    },
  ];

  const renderInspector = (id: string) => {
    const r = rows.find((row) => String(row["id"]) === id);
    if (!r) return null;
    const status = String(r["status"] ?? "draft");
    const linkedOrders = Array.isArray(r["purchase_orders"])
      ? (r["purchase_orders"] as Row[])
      : [];
    const liveOrder = linkedOrders.find(
      (o) => !["cancelled", "voided", "rejected"].includes(String(o["status"] ?? "")),
    );
    const isDraft = ["draft", "rejected"].includes(status);
    // Handed over by Stores: Procurement still owns pricing and submission.
    const isSubmitted = status === "submitted";
    const isPending = status === "pending_approval";
    // One requisition may only ever carry one live purchase order, so the
    // action disappears the moment an order exists — whatever the status says.
    const isApproved = status === "approved" && !liveOrder;
    const lines = Array.isArray(r["purchase_request_lines"])
      ? (r["purchase_request_lines"] as Row[])
      : [];
    const editableLines = canPrice && (isDraft || isSubmitted || isPending);

    return {
      title: String(r["request_number"] ?? r["title"] ?? "Requisition"),
      subtitle: describeRequestOrigin(r),
      chips: (
        <StatusPill tone={statusTone(status)}>{titleCase(status)}</StatusPill>
      ),
      sections: (
        <>
          <InspectorSection title="Request">
            <InspectorField label="Priority">
              {titleCase(String(r["priority"] ?? "normal"))}
            </InspectorField>
            <InspectorField label="Estimated total">
              {formatMoney(r["estimated_total"], symbol)}
            </InspectorField>
            <InspectorField label="Raised from">{describeRequestOrigin(r)}</InspectorField>
            {r["justification"] ? (
              <InspectorField label="Notes">{String(r["justification"])}</InspectorField>
            ) : null}
          </InspectorSection>

          <InspectorSection title={`Requested items (${lines.length})`}>
            {lines.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No items are recorded on this request.
              </p>
            ) : (
              <ul className="space-y-2">
                {lines.map((l) => {
                  const lineId = String(l["id"]);
                  const item = l["stock_items"] as Row | null;
                  const unitPrice = Number(l["estimated_unit_price"] ?? 0);
                  const draft = priceDraft[lineId];
                  return (
                    <li
                      key={lineId}
                      className="rounded-md border border-border px-3 py-2 text-sm"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {String(item?.["name"] ?? l["description"] ?? "Item")}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {`${Number(l["quantity"] ?? 0)} ${String(l["unit"] ?? "unit")}`}
                            {item?.["sku"] ? ` · ${String(item["sku"])}` : ""}
                          </p>
                        </div>
                        <span className="whitespace-nowrap text-xs text-muted-foreground">
                          {unitPrice > 0
                            ? `${formatMoney(unitPrice, symbol)} / ${String(l["unit"] ?? "unit")}`
                            : "No estimated price"}
                        </span>
                      </div>
                      {editableLines ? (
                        <div className="mt-2 flex items-center gap-2">
                          <Input
                            className="h-8 w-32"
                            inputMode="decimal"
                            placeholder="Unit price"
                            value={draft ?? (unitPrice > 0 ? String(unitPrice) : "")}
                            onChange={(e) =>
                              setPriceDraft((d) => ({ ...d, [lineId]: e.target.value }))
                            }
                          />
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={
                              price.isPending ||
                              draft === undefined ||
                              draft.trim() === "" ||
                              Number.isNaN(Number(draft)) ||
                              Number(draft) < 0
                            }
                            onClick={() =>
                              price.mutate(
                                { lineId, unitPrice: Number(draft) },
                                {
                                  onSuccess: () =>
                                    setPriceDraft((d) => {
                                      const next = { ...d };
                                      delete next[lineId];
                                      return next;
                                    }),
                                },
                              )
                            }
                          >
                            Save price
                          </Button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </InspectorSection>
        </>
      ),
      footer: (
        <>
          {isDraft || isSubmitted ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={submit.isPending || lines.length === 0}
              onClick={() => submit.mutate({ requestId: id, attemptKey: newAttemptKey() })}
            >
              Send for approval
            </Button>
          ) : null}
          {isPending && canApprove ? (
            <>
              <Button
                size="sm"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ requestId: id, decision: "approve" })}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setRejectFor(r);
                  setRejectReason("");
                }}
              >
                Reject
              </Button>
            </>
          ) : isPending ? (
            <span className="text-xs text-muted-foreground">Awaiting an authorised buyer</span>
          ) : null}
          {liveOrder ? (
            <span className="text-xs text-muted-foreground">
              {`Purchase order ${String(liveOrder["order_number"] ?? "")} already raised — ${titleCase(String(liveOrder["status"] ?? "draft"))}`}
            </span>
          ) : isApproved && canOrder ? (
            <Button size="sm" onClick={() => openConvert(r)}>
              Raise purchase order
            </Button>
          ) : isApproved ? (
            <span className="text-xs text-muted-foreground">Buyer will raise the order</span>
          ) : null}
        </>
      ),
    };
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Supply Chain"
        title="Purchase requests"
        description="Requisitions are raised by departments, approved by an authorised buyer and only then become a purchase order. Every step is recorded once, even if a submission is retried."
      />

      <RequisitionWorkspace
        lead={lead}
        figures={figures}
        isLoading={loading}
        error={requests.error}
        rows={workspaceRows}
        emptyState={
          <EmptyState
            icon={ClipboardList}
            title="No requisitions yet"
            description="Departments raise requisitions from their stores screen."
          />
        }
        selectedId={selectedId}
        onSelect={setSelectedId}
        renderInspector={renderInspector}
      />

      <Dialog open={Boolean(convertFor)} onOpenChange={(open) => !open && setConvertFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Raise purchase order</DialogTitle>
            <DialogDescription>
              {`Requisition ${String(convertFor?.["request_number"] ?? "")} becomes a draft purchase order with the same lines.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Supplier</Label>
              <Select value={supplierId} onValueChange={setSupplierId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose an approved supplier" />
                </SelectTrigger>
                <SelectContent>
                  {supplierRows.map((s) => (
                    <SelectItem key={String(s["id"])} value={String(s["id"])}>
                      {String(s["name"])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Deliver to store</Label>
              <Select value={locationId} onValueChange={setLocationId}>
                <SelectTrigger>
                  <SelectValue placeholder="Receiving store" />
                </SelectTrigger>
                <SelectContent>
                  {locationRows.map((l) => (
                    <SelectItem key={String(l["id"])} value={String(l["id"])}>
                      {String(l["name"])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="expected">Expected delivery date</Label>
              <NeoDatePicker id="expected" value={expected} onChange={setExpected} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConvertFor(null)}>
              Cancel
            </Button>
            <Button
              disabled={!supplierId || convert.isPending}
              onClick={() =>
                convert.mutate(
                  {
                    requestId: String(convertFor?.["id"]),
                    supplierId,
                    expectedDate: expected || null,
                    locationId: locationId || null,
                    attemptKey,
                  },
                  { onSuccess: () => setConvertFor(null) },
                )
              }
            >
              Raise order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(rejectFor)} onOpenChange={(open) => !open && setRejectFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject requisition</DialogTitle>
            <DialogDescription>
              A written reason is required and is kept with the request.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Why is this being returned?"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectFor(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={rejectReason.trim().length === 0 || decide.isPending}
              onClick={() =>
                decide.mutate(
                  {
                    requestId: String(rejectFor?.["id"]),
                    decision: "reject",
                    reason: rejectReason.trim(),
                  },
                  { onSuccess: () => setRejectFor(null) },
                )
              }
            >
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Every Supply Chain screen writes to stock, money or supplier records, so the
// page itself asks for the capability its route declares — never the shell.
function GuardedPage() {
  return (
    <OpsGuard path="/procurement/requests">
      <Page />
    </OpsGuard>
  );
}
