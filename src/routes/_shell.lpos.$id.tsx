import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { DocumentPrintButton } from "@/components/common/DocumentPrintButton";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { QueryState } from "@/components/pms/PmsShared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useTenant } from "@/lib/tenant";
import {
  LPO_ACTIONS,
  DISCREPANCY_LABELS,
  formatDateTime,
  lpoStatusTone,
  money,
  num,
  outstandingQuantity,
  titleCase,
  type Row,
} from "@/lib/procurement";
import {
  useDocumentTrail,
  useLpoAction,
  useResolveDiscrepancy,
  useThreeWayMatch,
} from "@/lib/procurement-data";

export const Route = createFileRoute("/_shell/lpos/$id")({
  head: () => ({
    meta: [
      { title: "Purchase Order Trail — NEØ" },
      {
        name: "description",
        content:
          "Requisition to payment history for a local purchase order, including deliveries, invoices and matching.",
      },
      { property: "og:title", content: "Purchase Order Trail — NEØ" },
      {
        property: "og:description",
        content:
          "Requisition to payment history for a local purchase order, including deliveries, invoices and matching.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

function Row2({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">
        {value === null || value === undefined || value === "" ? "—" : String(value)}
      </span>
    </div>
  );
}

function Page() {
  const { id } = Route.useParams();
  const { tenant } = useTenant();
  const symbol = tenant.regional.currencySymbol;
  const trail = useDocumentTrail(id);
  const action = useLpoAction();
  const match = useThreeWayMatch();
  const resolve = useResolveDiscrepancy();
  const [reason, setReason] = useState("");

  const data = (trail.data ?? {}) as Row;
  const order = (data["order"] ?? {}) as Row;
  const lines = (data["lines"] ?? []) as Row[];
  const receipts = (data["receipts"] ?? []) as Row[];
  const invoices = (data["invoices"] ?? []) as Row[];
  const payments = (data["payments"] ?? []) as Row[];
  const quotations = (data["quotations"] ?? []) as Row[];
  const revisions = (data["revisions"] ?? []) as Row[];
  const audit = (data["audit"] ?? []) as Row[];
  const request = (data["request"] ?? null) as Row | null;
  const approvals = (data["approvals"] ?? []) as Row[];

  const outstanding = useMemo(() => lines.reduce((s, l) => s + outstandingQuantity(l), 0), [lines]);
  const accepted = useMemo(
    () => lines.reduce((s, l) => s + num(l["accepted_quantity"]), 0),
    [lines],
  );
  const rejected = useMemo(
    () => lines.reduce((s, l) => s + num(l["rejected_quantity"]) + num(l["returned_quantity"]), 0),
    [lines],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Link
          to="/procurement"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to procurement
        </Link>
        <DocumentPrintButton
          type="purchase_order"
          id={order["id"] ? String(order["id"]) : null}
          label="Print LPO"
          variant="secondary"
        />
      </div>

      <QueryState
        isLoading={trail.isLoading}
        error={trail.error}
        isEmpty={!order["id"]}
        empty={<p className="py-8 text-sm text-muted-foreground">Purchase order not found.</p>}
      >
        <div className="space-y-6">
          <PageHeader
            eyebrow="Supply Chain"
            title={`LPO ${String(order["order_number"] ?? "")}`}
            description="The complete document trail. Records are never deleted — corrections are cancellations, voids, returns, credit notes or revised versions."
          />

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Order value"
              value={money(order["total_amount"], symbol)}
              hint={`${lines.length} line(s)`}
            />
            <StatCard
              label="Accepted quantity"
              value={accepted.toLocaleString()}
              hint={`${rejected.toLocaleString()} rejected / returned`}
              tone="success"
            />
            <StatCard
              label="Outstanding quantity"
              value={outstanding.toLocaleString()}
              hint={outstanding > 0 ? "Order stays open" : "Nothing outstanding"}
              tone={outstanding > 0 ? "warning" : "default"}
            />
            <StatCard
              label="Invoiced / paid"
              value={`${money(order["invoiced_amount"], symbol)} / ${money(order["paid_amount"], symbol)}`}
              hint={titleCase(String(order["status"] ?? "draft"))}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard
              title="Order header"
              description="Who prepared, checked and approved this order."
            >
              <div className="divide-y divide-border">
                <Row2 label="Status" value={titleCase(String(order["status"] ?? "draft"))} />
                <Row2 label="Supplier" value={(data["supplier"] as Row | null)?.["name"]} />
                <Row2
                  label="Requesting department"
                  value={
                    order["department_id"]
                      ? "Linked"
                      : request?.["department_id"]
                        ? "From requisition"
                        : "—"
                  }
                />
                <Row2 label="Requisition" value={request?.["request_number"]} />
                <Row2 label="Version" value={`v${num(order["version"], 1)}`} />
                <Row2 label="Payment terms" value={order["payment_terms"]} />
                <Row2 label="Delivery address" value={order["delivery_address"]} />
                <Row2 label="Expected delivery" value={order["expected_date"]} />
                <Row2 label="Prepared" value={formatDateTime(order["created_at"])} />
                <Row2 label="Checked" value={formatDateTime(order["checked_at"])} />
                <Row2 label="Approved" value={formatDateTime(order["approved_at"])} />
                <Row2 label="Sent to supplier" value={formatDateTime(order["sent_at"])} />
                <Row2 label="Closed" value={formatDateTime(order["closed_at"])} />
                <Row2
                  label="Close / cancel reason"
                  value={order["close_reason"] ?? order["cancel_reason"] ?? order["void_reason"]}
                />
              </div>
            </SectionCard>

            <SectionCard
              title="Controlled actions"
              description="Every action needs a reason and is written to the audit trail."
            >
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason for this action (required, minimum 5 characters)"
                className="mb-3"
                rows={3}
              />
              <div className="flex flex-wrap gap-2">
                {LPO_ACTIONS.map((a) => (
                  <Button
                    key={a.key}
                    size="sm"
                    variant={a.destructive ? "destructive" : "secondary"}
                    disabled={action.isPending || reason.trim().length < 5}
                    onClick={() =>
                      action.mutate(
                        { orderId: id, action: a.key, reason: reason.trim() },
                        { onSuccess: () => setReason("") },
                      )
                    }
                  >
                    {a.label}
                  </Button>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Closing writes the outstanding balance off with your reason; the order and every
                linked document remain visible for ever.
              </p>
            </SectionCard>
          </div>

          <SectionCard
            title="Order lines"
            description="Ordered, accepted, rejected, returned and still outstanding."
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2">Item</th>
                    <th>Ordered</th>
                    <th>Received</th>
                    <th>Accepted</th>
                    <th>Rejected</th>
                    <th>Returned</th>
                    <th>Outstanding</th>
                    <th className="text-right">Unit price</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {lines.map((l) => (
                    <tr key={String(l["id"])}>
                      <td className="py-2 font-medium">
                        {String(l["item_name"] ?? l["description"] ?? "Item")}
                      </td>
                      <td>{`${num(l["quantity"])} ${String(l["unit"] ?? "")}`}</td>
                      <td>{num(l["received_quantity"])}</td>
                      <td>{num(l["accepted_quantity"])}</td>
                      <td>{num(l["rejected_quantity"])}</td>
                      <td>{num(l["returned_quantity"])}</td>
                      <td
                        className={outstandingQuantity(l) > 0 ? "font-semibold text-warning" : ""}
                      >
                        {outstandingQuantity(l)}
                      </td>
                      <td className="text-right">{money(l["unit_price"], symbol)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>

          <SectionCard
            title="Goods received notes"
            description="Deliveries against this order. Stock increases by the accepted quantity only."
          >
            {receipts.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">No deliveries recorded yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {receipts.map((g) => (
                  <li key={String(g["id"])} className="py-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium">{String(g["grn_number"] ?? "GRN")}</p>
                        <p className="text-xs text-muted-foreground">
                          {`Received ${formatDateTime(g["received_at"])} · delivery note ${String(g["delivery_note_number"] ?? "—")} · value ${money(g["total_value"], symbol)}`}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusPill tone={lpoStatusTone(String(g["status"] ?? ""))}>
                          {titleCase(String(g["status"] ?? "draft"))}
                        </StatusPill>
                        <DocumentPrintButton
                          type="goods_receipt"
                          id={String(g["id"])}
                          label="Print GRN"
                          variant="ghost"
                        />
                      </div>
                    </div>
                    <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                      {((g["lines"] ?? []) as Row[]).map((gl) => (
                        <li key={String(gl["id"])}>
                          {`${String(gl["item_name"] ?? "Item")} — delivered ${num(gl["quantity_received"])}, accepted ${num(gl["quantity_accepted"] ?? gl["quantity_received"])}, rejected ${num(gl["quantity_rejected"])}, damaged ${num(gl["quantity_damaged"])}, returned ${num(gl["quantity_returned"])}${gl["batch_number"] ? ` · batch ${String(gl["batch_number"])}` : ""}${gl["expiry_date"] ? ` · expires ${String(gl["expiry_date"])}` : ""}`}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            title="Supplier invoices & three-way matching"
            description="Order versus delivery versus invoice. Discrepancies hold the invoice for review."
          >
            {invoices.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                No supplier invoices recorded against this order.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {invoices.map((i) => (
                  <li key={String(i["id"])} className="py-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="font-medium">{String(i["invoice_number"] ?? "Invoice")}</p>
                        <p className="text-xs text-muted-foreground">
                          {`${money(i["amount"], symbol)} · ${String(i["invoice_date"] ?? "")} · match ${titleCase(String(i["match_status"] ?? "unmatched"))}`}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusPill tone={lpoStatusTone(String(i["match_status"] ?? ""))}>
                          {titleCase(String(i["match_status"] ?? "unmatched"))}
                        </StatusPill>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={match.isPending}
                          onClick={() => match.mutate(String(i["id"]))}
                        >
                          Run three-way match
                        </Button>
                      </div>
                    </div>
                    <ul className="mt-2 space-y-2">
                      {((i["discrepancies"] ?? []) as Row[])
                        .filter((d) => !d["resolved"])
                        .map((d) => (
                          <li
                            key={String(d["id"])}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs"
                          >
                            <span>
                              <strong>
                                {DISCREPANCY_LABELS[String(d["kind"])] ??
                                  titleCase(String(d["kind"]))}
                                :
                              </strong>{" "}
                              {String(d["detail"])}
                            </span>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={resolve.isPending || reason.trim().length < 5}
                              onClick={() =>
                                resolve.mutate(
                                  { id: String(d["id"]), reason: reason.trim() },
                                  { onSuccess: () => setReason("") },
                                )
                              }
                            >
                              Explain with reason above
                            </Button>
                          </li>
                        ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard
              title="Quotations & selection"
              description="Supplier responses considered before this order."
            >
              {quotations.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">
                  No quotations captured for the source requisition.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {quotations.map((q) => (
                    <li
                      key={String(q["id"])}
                      className="flex items-center justify-between gap-3 py-2 text-sm"
                    >
                      <span>
                        {String(q["quotation_number"] ?? "Quotation")} ·{" "}
                        {money(q["total_amount"], symbol)}
                      </span>
                      <StatusPill tone={q["selected"] ? "success" : "default"}>
                        {q["selected"] ? "Selected" : titleCase(String(q["status"] ?? "received"))}
                      </StatusPill>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            <SectionCard
              title="Payments & revisions"
              description="Settlement records and revised versions of this order."
            >
              <ul className="divide-y divide-border text-sm">
                {payments.map((p) => (
                  <li
                    key={String(p["id"])}
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <span>{String(p["reference"] ?? p["payment_number"] ?? "Payment")}</span>
                    <span className="font-medium">{money(p["amount"], symbol)}</span>
                  </li>
                ))}
                {revisions.map((v) => (
                  <li
                    key={String(v["id"])}
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <span>{`Revision v${num(v["version"], 1)} — ${String(v["order_number"] ?? "")}`}</span>
                    <Link
                      to="/lpos/$id"
                      params={{ id: String(v["id"]) }}
                      className="text-xs text-primary hover:underline"
                    >
                      Open
                    </Link>
                  </li>
                ))}
                {payments.length === 0 && revisions.length === 0 ? (
                  <li className="py-4 text-sm text-muted-foreground">
                    No payments or revised versions yet.
                  </li>
                ) : null}
              </ul>
            </SectionCard>
          </div>

          <SectionCard
            title="Approval and audit history"
            description="Every action, user, timestamp and value change on this trail."
          >
            <ul className="divide-y divide-border text-sm">
              {approvals.map((a) => (
                <li key={String(a["id"])} className="py-2">
                  {`${titleCase(String(a["action"] ?? "action"))} · ${formatDateTime(a["created_at"])}`}
                </li>
              ))}
              {audit.map((a) => (
                <li key={String(a["id"])} className="py-2">
                  <p className="font-medium">{String(a["action"])}</p>
                  <p className="text-xs text-muted-foreground">
                    {`${String(a["user_name"] || "System")} · ${formatDateTime(a["created_at"])}${a["reason"] ? ` · ${String(a["reason"])}` : ""}`}
                  </p>
                </li>
              ))}
              {approvals.length === 0 && audit.length === 0 ? (
                <li className="py-4 text-sm text-muted-foreground">No recorded actions yet.</li>
              ) : null}
            </ul>
          </SectionCard>
        </div>
      </QueryState>
    </div>
  );
}
