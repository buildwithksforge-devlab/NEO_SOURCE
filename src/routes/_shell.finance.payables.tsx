import { useMemo, useState } from "react";
import { toast } from "sonner";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import {
  InspectorField,
  InspectorSection,
  InspectorSheet,
} from "@/components/common/InspectorSheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DataTable,
  FinanceEmpty,
  FinanceGuard,
  FinanceQueryState,
  FinStatus,
  FormDialog,
  RecordForm,
  financeHead,
  type FieldSpec,
} from "@/components/finance/FinanceShared";
import { SupplierInvoiceDialog } from "@/components/finance/SupplierInvoiceDialog";
import {
  PostingPlanDialog,
  type PostingPlanTarget,
} from "@/components/finance/PostingPlanDialog";
import { money, num, SUPPLIER_PAYMENT_METHODS, shortDate, titleCase } from "@/lib/finance";
import { paymentMethodLabel } from "@/lib/payment-methods";
import { useAuth } from "@/lib/auth";
import { OwnerNextAction } from "@/components/common/OwnerNextAction";
import { supplierPaymentPosition } from "@/lib/workflow-position";
import { PaymentConveyor } from "@/components/finance/PaymentConveyor";
import {
  useBankAccounts,
  useFinanceInsert,
  usePaymentSchedules,
  useReleasePaymentSchedule,
  useSupplierInvoices,
  useSupplierPayments,
  useAdvanceSupplierPayment,
  useSuppliers,
} from "@/lib/finance-data";
import {
  useAcceptSupplierInvoice,
  useInvoiceDiscrepancies,
  useMatchingPolicy,
  useSaveMatchingPolicy,
  useThreeWayMatch,
} from "@/lib/procurement-data";
import { DISCREPANCY_LABELS } from "@/lib/procurement";
import { useApJournalRegister } from "@/lib/ap-matching";

export const Route = createFileRoute("/_shell/finance/payables")({
  head: financeHead(
    "Accounts Payable",
    "Supplier invoices, three-way matching, payment scheduling and approved supplier payments.",
  ),
  component: () => (
    <FinanceGuard feature="ap" action="view">
      <PayablesPage />
    </FinanceGuard>
  ),
});

type Lens = "none" | "variance" | "unpaid" | "held";

function PayablesPage() {
  const { can, isAdmin } = useAuth();
  const canCapture = isAdmin || can("finance", "edit");
  const canAccept = isAdmin || can("finance", "approve");
  // Release authority sits with a finance approver or an owner, never with the
  // person who merely schedules the payment.
  const canRelease = isAdmin || can("finance", "approve");
  const releaseSchedule = useReleasePaymentSchedule();

  const invoices = useSupplierInvoices();
  const payments = useSupplierPayments();
  const advance = useAdvanceSupplierPayment();
  const schedules = usePaymentSchedules();
  const suppliers = useSuppliers();
  const createSchedule = useFinanceInsert("payment_schedules", "finance.payment_schedule.created");
  const [lens, setLens] = useState<Lens>("none");
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [traceTarget, setTraceTarget] = useState<PostingPlanTarget | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");

  const discrepancies = useInvoiceDiscrepancies(inspectId);
  const rematch = useThreeWayMatch();
  const accept = useAcceptSupplierInvoice();

  // Matching truth has one owner: the AP register. Payables never derives its
  // own matched value, variance or match status, so this list and Three-Way
  // Matching can never disagree about the same invoice.
  const register = useApJournalRegister();
  const rows = useMemo(() => {
    const truth = new Map((register.data ?? []).map((r) => [r.invoice_id, r] as const));
    return (invoices.data ?? []).map((row) => {
      const i = row as Record<string, unknown>;
      const t = truth.get(String(i["id"]));
      if (!t) return i;
      return {
        ...i,
        matched_amount: t.matched_amount,
        variance: t.variance,
        // Nothing can be three-way matched without an order or a delivery
        // behind it, whatever an older stored value says.
        match_status: t.order_id || t.receipt_id ? t.match_status : "unmatched",
        order_number: t.order_number,
        grn_number: t.grn_number,
      } as Record<string, unknown>;
    });
  }, [invoices.data, register.data]);
  const outstanding = rows
    .filter((i) => i["status"] !== "paid")
    .reduce((s, i) => s + (num(i["amount"]) - num(i["paid_amount"])), 0);
  const variances = rows.filter((i) => Math.abs(num(i["variance"])) > 0.005);
  const held = rows.filter((i) => String(i["match_status"] ?? "") === "held");
  const unpaid = rows.filter((i) => i["status"] !== "paid");
  const dueSoon = (schedules.data ?? []).filter((s) => s["status"] !== "paid");

  const toggleLens = (next: Lens) => setLens((prev) => (prev === next ? "none" : next));

  const filteredRows = useMemo(() => {
    if (lens === "variance") return variances;
    if (lens === "unpaid") return unpaid;
    if (lens === "held") return held;
    return rows;
  }, [lens, variances, unpaid, held, rows]);


  const lead: SummaryFigure = {
    id: "outstanding",
    label: "Outstanding payables",
    value: invoices.isLoading ? "…" : money(outstanding),
  };
  const figures: SummaryFigure[] = [
    {
      id: "variance",
      label: "With variance",
      value: invoices.isLoading ? "…" : variances.length,
      tone: variances.length ? "warning" : "success",
      hint: "Require review before payment",
      onSelect: () => toggleLens("variance"),
      active: lens === "variance",
    },
    {
      id: "unpaid",
      label: "Unpaid",
      value: invoices.isLoading ? "…" : unpaid.length,
      onSelect: () => toggleLens("unpaid"),
      active: lens === "unpaid",
    },
    {
      id: "held",
      label: "Held by matching",
      value: invoices.isLoading ? "…" : held.length,
      tone: held.length ? "destructive" : "success",
      hint: "Order, delivery and invoice disagree",
      onSelect: () => toggleLens("held"),
      active: lens === "held",
    },
    {
      id: "scheduled",
      label: "Scheduled payments",
      value: schedules.isLoading ? "…" : dueSoon.length,
      hint: "Awaiting release",
    },
    {
      id: "paid",
      label: "Payments made",
      value: payments.isLoading ? "…" : (payments.data ?? []).length,
    },
  ];

  const inspected = filteredRows.find((i) => String(i["id"]) === inspectId) ?? null;
  const [scheduleSupplier, setScheduleSupplier] = useState("");
  const inspectedSupplier = inspected?.["suppliers"] as { name?: string } | null;
  const inspectedIssues = inspectId ? (discrepancies.data ?? []) : [];
  const inspectedHeld = String(inspected?.["match_status"] ?? "") === "held";
  const inspectedPosted = Boolean(inspected?.["journal_id"]);


  // An invoice belongs to exactly one supplier, so the invoice list narrows to
  // whoever is being paid. Offering another supplier's invoice here is how a
  // payment ends up scheduled against the wrong account.
  const schedulableInvoices = useMemo(
    () =>
      rows.filter(
        (i) =>
          i["status"] !== "paid" &&
          (!scheduleSupplier || String(i["supplier_id"] ?? "") === scheduleSupplier),
      ),
    [rows, scheduleSupplier],
  );

  const scheduleFields: FieldSpec[] = [
    {
      name: "supplier_id",
      label: "Supplier",
      type: "select",
      required: true,
      options: (suppliers.data ?? []).map((s) => ({
        value: String(s["id"]),
        label: String(s["name"]),
      })),
    },
    {
      name: "supplier_invoice_id",
      label: scheduleSupplier ? "Supplier invoice" : "Supplier invoice (choose the supplier first)",
      type: "select",
      options: schedulableInvoices.map((i) => ({
        value: String(i["id"]),
        label: `${i["invoice_number"]} — ${money(num(i["amount"]) - num(i["paid_amount"]))} outstanding`,
      })),
    },
    { name: "scheduled_date", label: "Scheduled date", type: "date", required: true },
    { name: "amount", label: "Amount", type: "number", required: true },
    {
      name: "method",
      label: "Method",
      type: "select",
      required: true,
      options: SUPPLIER_PAYMENT_METHODS.map((m) => ({ value: m, label: paymentMethodLabel(m) })),
    },
    { name: "notes", label: "Notes", type: "textarea", span: true },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Finance"
        title="Accounts Payable"
        description="Supplier invoices are matched against the purchase order and goods received note before they can be scheduled or paid."
      />

      <SummaryStrip lead={lead} figures={figures} />

      <Tabs defaultValue="invoices" className="w-full">
        <TabsList className="mb-3">
          <TabsTrigger value="invoices">Supplier invoices</TabsTrigger>
          <TabsTrigger value="schedule">Payment schedule</TabsTrigger>
          <TabsTrigger value="payments">Supplier payments</TabsTrigger>
          <TabsTrigger value="policy">Matching policy</TabsTrigger>
        </TabsList>

        <TabsContent value="invoices" className="mt-0">
          <div className="surface-panel rounded-2xl p-3 sm:p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-foreground">
                {filteredRows.length} invoice(s)
              </p>
              {canCapture ? (
                <Button size="sm" onClick={() => setCaptureOpen(true)}>
                  Capture supplier invoice
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Capturing supplier invoices requires finance edit rights.
                </p>
              )}
            </div>

            <FinanceQueryState
              isLoading={invoices.isLoading}
              error={invoices.error}
              isEmpty={filteredRows.length === 0}
              empty={
                <FinanceEmpty
                  title="No supplier invoices"
                  description="Invoices captured against purchase orders and goods receipts appear here."
                />
              }
            >
              <DataTable
                head={[
                  "Invoice",
                  "Supplier",
                  "Date",
                  "Due",
                  "Amount",
                  "Matched",
                  "Variance",
                  "Match",
                  "Status",
                ]}
              >
                {filteredRows.map((i) => {
                  const sup = i["suppliers"] as { name?: string } | null;
                  return (
                    <tr
                      key={String(i["id"])}
                      className="cursor-pointer hover:bg-muted/40"
                      onClick={() => setInspectId(String(i["id"]))}
                    >
                      <td className="py-2 pr-4 font-mono text-xs">{String(i["invoice_number"])}</td>
                      <td className="py-2 pr-4">{sup?.name ?? "—"}</td>
                      <td className="py-2 pr-4">{shortDate(i["invoice_date"])}</td>
                      <td className="py-2 pr-4">{shortDate(i["due_date"])}</td>
                      <td className="py-2 pr-4">{money(i["amount"])}</td>
                      <td className="py-2 pr-4">{money(i["matched_amount"])}</td>
                      <td className="py-2 pr-4">{money(i["variance"])}</td>
                      <td className="py-2 pr-4">
                        <FinStatus value={String(i["match_status"] ?? "pending")} />
                      </td>

                      <td className="py-2 pr-4">
                        <FinStatus value={String(i["status"])} />
                      </td>
                    </tr>
                  );
                })}
              </DataTable>
            </FinanceQueryState>
          </div>
        </TabsContent>

        <TabsContent value="schedule" className="mt-0">
          <div className="surface-panel rounded-2xl p-3 sm:p-4">
            <div className="mb-3 flex justify-end">
              <FormDialog
                title="Schedule payment"
                description="Queue a supplier payment for a future date."
              >
                {(close) => (
                  <RecordForm
                    fields={scheduleFields}
                    submitLabel="Schedule payment"
                    busy={createSchedule.isPending}
                    onValuesChange={(values) =>
                      setScheduleSupplier(String(values["supplier_id"] ?? ""))
                    }
                    onSubmit={(values) => {
                      const invoiceId = String(values["supplier_invoice_id"] ?? "");
                      const supplierId = String(values["supplier_id"] ?? "");
                      if (invoiceId) {
                        const invoice = rows.find((i) => String(i["id"]) === invoiceId);
                        if (invoice && String(invoice["supplier_id"] ?? "") !== supplierId) {
                          toast.error("That invoice belongs to a different supplier.");
                          return;
                        }
                      }
                      createSchedule.mutate(
                        { ...values, status: "scheduled" },
                        {
                          onSuccess: () => {
                            setScheduleSupplier("");
                            close();
                          },
                        },
                      );
                    }}
                  />
                )}
              </FormDialog>
            </div>
            <FinanceQueryState
              isLoading={schedules.isLoading}
              error={schedules.error}
              isEmpty={(schedules.data ?? []).length === 0}
              empty={
                <FinanceEmpty
                  title="Nothing scheduled"
                  description="Schedule supplier payments to plan the cash requirement for the week."
                />
              }
            >
              <DataTable
                head={["Supplier", "Date", "Amount", "Method", "Status", "Next step"]}
              >
                {(schedules.data ?? []).map((s) => {
                  const sup = s["suppliers"] as { name?: string } | null;
                  const status = String(s["status"]);
                  const releasable = ["scheduled", "approved", "pending", "pending_approval", "draft"].includes(
                    status,
                  );
                  return (
                    <tr key={String(s["id"])}>
                      <td className="py-2 pr-4">{sup?.name ?? "—"}</td>
                      <td className="py-2 pr-4">{shortDate(s["scheduled_date"])}</td>
                      <td className="py-2 pr-4">{money(s["amount"])}</td>
                      <td className="py-2 pr-4">{titleCase(String(s["method"]))}</td>
                      <td className="py-2 pr-4">
                        <FinStatus value={status} />
                      </td>
                      <td className="py-2 pr-4 text-right">
                        {!releasable ? (
                          <span className="text-xs text-muted-foreground">Released</span>
                        ) : canRelease ? (
                          <ReleaseScheduleDialog
                            method={String(s["method"] ?? "")}
                            busy={releaseSchedule.isPending}
                            onRelease={(input) =>
                              releaseSchedule.mutate({ scheduleId: String(s["id"]), ...input })
                            }
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            Awaiting finance release
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </DataTable>
            </FinanceQueryState>
          </div>
        </TabsContent>

        <TabsContent value="payments" className="mt-0">
          <div className="surface-panel rounded-2xl p-3 sm:p-4">
            <FinanceQueryState
              isLoading={payments.isLoading}
              error={payments.error}
              isEmpty={(payments.data ?? []).length === 0}
              empty={
                <FinanceEmpty
                  title="No payments yet"
                  description="Released supplier payments post to the ledger and appear here."
                />
              }
            >
              <DataTable
                head={[
                  "Payment",
                  "Supplier",
                  "Paid",
                  "Amount",
                  "Method",
                  "Reconciled",
                  "Status",
                  "Owner / next action",
                  "Next step",
                ]}
              >
                {(payments.data ?? []).map((p) => {
                  const sup = p["suppliers"] as { name?: string } | null;
                  return (
                    <tr key={String(p["id"])}>
                      <td className="py-2 pr-4 font-mono text-xs">
                        {String(p["payment_number"])}
                      </td>
                      <td className="py-2 pr-4">{sup?.name ?? "—"}</td>
                      <td className="py-2 pr-4">{shortDate(p["paid_on"])}</td>
                      <td className="py-2 pr-4">{money(p["amount"])}</td>
                      <td className="py-2 pr-4">{titleCase(String(p["method"]))}</td>
                      <td className="py-2 pr-4">
                        <FinStatus value={String(p["reconciliation_status"] ?? "pending")} />
                      </td>
                      <td className="py-2 pr-4">
                        <FinStatus value={String(p["status"])} />
                      </td>
                      <td className="py-2 pr-4">
                        <OwnerNextAction position={supplierPaymentPosition(p as never)} />
                      </td>
                      <td className="py-2 pr-4 text-right">
                        <PaymentConveyor
                          status={String(p["status"])}
                          pending={advance.isPending}
                          onAdvance={(action, reason) =>
                            advance.mutate({
                              paymentId: String(p["id"]),
                              action,
                              reason,
                            })
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </DataTable>
            </FinanceQueryState>
          </div>
        </TabsContent>
        <TabsContent value="policy" className="mt-0">
          <MatchingPolicyPanel canEdit={canCapture} />
        </TabsContent>
      </Tabs>

      <SupplierInvoiceDialog
        open={captureOpen}
        onOpenChange={setCaptureOpen}
        suppliers={(suppliers.data ?? []).filter((s) => s["active"] !== false)}
      />

      <PostingPlanDialog target={traceTarget} onClose={() => setTraceTarget(null)} />


      <InspectorSheet
        open={Boolean(inspected)}
        onOpenChange={(open) => {
          if (!open) {
            setInspectId(null);
            setOverrideReason("");
          }
        }}
        title={inspected ? String(inspected["invoice_number"]) : ""}
        subtitle={inspectedSupplier?.name ?? undefined}
        chips={
          inspected ? (
            <>
              <FinStatus value={String(inspected["status"])} />
              <FinStatus value={String(inspected["match_status"] ?? "pending")} />
            </>
          ) : null
        }
      >
        {inspected ? (
          <>
            <InspectorSection title="Invoice">
              <InspectorField label="Date">{shortDate(inspected["invoice_date"])}</InspectorField>
              <InspectorField label="Due">{shortDate(inspected["due_date"])}</InspectorField>
              <InspectorField label="Amount">{money(inspected["amount"])}</InspectorField>
              <InspectorField label="Tax">{money(inspected["tax_amount"])}</InspectorField>
            </InspectorSection>

            <InspectorSection title="Matching">
              <InspectorField label="Matched value">
                {money(inspected["matched_amount"])}
              </InspectorField>
              <InspectorField label="Variance">{money(inspected["variance"])}</InspectorField>
              <InspectorField label="Purchase order">
                {String(
                  inspected["order_number"] ??
                    (inspected["purchase_orders"] as { order_number?: string } | null)
                      ?.order_number ??
                    "Not linked",
                )}
              </InspectorField>
              <InspectorField label="Goods receipt">
                {String(inspected["grn_number"] ?? "Not linked")}
              </InspectorField>
            </InspectorSection>

            <div className="space-y-2 px-1">
              <p className="text-sm font-semibold text-foreground">Matching exceptions</p>
              {discrepancies.isLoading ? (
                <p className="text-sm text-muted-foreground">Checking…</p>
              ) : inspectedIssues.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing outstanding. Order, delivery and invoice agree within the configured
                  tolerance.
                </p>
              ) : (
                <ul className="space-y-2">
                  {inspectedIssues.map((d) => (
                    <li
                      key={String(d["id"])}
                      className="rounded-lg border border-border/60 p-2 text-sm"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">
                          {DISCREPANCY_LABELS[String(d["kind"])] ?? titleCase(String(d["kind"]))}
                        </span>
                        <FinStatus value={String(d["severity"])} />
                      </div>
                      <p className="text-muted-foreground">{String(d["detail"] ?? "")}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <InspectorSection title="Accounting consequence">
              <InspectorField label="Payable journal">
                {inspectedPosted ? "Posted" : "Not yet raised"}
              </InspectorField>
              <InspectorField label="On acceptance">
                Clears goods received not invoiced, records recoverable tax and raises the supplier
                payable.
              </InspectorField>
            </InspectorSection>

            <div className="px-1 pb-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setTraceTarget({
                    module: "supplier_invoice",
                    sourceId: String(inspected["id"]),
                    reference: String(inspected["invoice_number"] ?? ""),
                  })
                }
              >
                Trace to journal
              </Button>
            </div>

            <div className="space-y-2 px-1 pb-4">
              {inspectedHeld && canAccept ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="ap-override">Override reason (required while held)</Label>
                  <Textarea
                    id="ap-override"
                    rows={2}
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    placeholder="Explain why this variance is accepted"
                  />
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={rematch.isPending}
                  onClick={() => rematch.mutate(String(inspected["id"]))}
                >
                  Re-run matching
                </Button>
                {canAccept ? (
                  <Button
                    size="sm"
                    disabled={
                      accept.isPending ||
                      inspectedPosted ||
                      (inspectedHeld && overrideReason.trim() === "")
                    }
                    onClick={() =>
                      accept.mutate(
                        overrideReason.trim()
                          ? { invoiceId: String(inspected["id"]), reason: overrideReason.trim() }
                          : { invoiceId: String(inspected["id"]) },
                      )
                    }
                  >
                    {inspectedPosted ? "Payable raised" : "Accept and raise payable"}
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Accepting an invoice requires finance approval rights.
                  </p>
                )}
              </div>
            </div>
          </>
        ) : null}
      </InspectorSheet>

    </div>
  );
}

/**
 * How strictly an invoice must agree with the order and the delivery before a
 * payable may be raised. Two-way compares the invoice with the order only;
 * three-way also requires the goods to have been accepted.
 */
function MatchingPolicyPanel({ canEdit }: { canEdit: boolean }) {
  const policy = useMatchingPolicy();
  const save = useSaveMatchingPolicy();
  const current = policy.data ?? null;

  const [mode, setMode] = useState<string>("");
  const [pricePct, setPricePct] = useState<string>("");
  const [priceAmount, setPriceAmount] = useState<string>("");
  const [qtyPct, setQtyPct] = useState<string>("");

  const effective = {
    mode: mode || String(current?.["match_mode"] ?? "three-way"),
    pricePct: pricePct === "" ? String(current?.["price_tolerance_pct"] ?? 2) : pricePct,
    priceAmount: priceAmount === "" ? String(current?.["price_tolerance_amount"] ?? 0) : priceAmount,
    qtyPct: qtyPct === "" ? String(current?.["quantity_tolerance_pct"] ?? 0) : qtyPct,
  };

  return (
    <div className="surface-panel space-y-4 rounded-2xl p-3 sm:p-4">
      <div>
        <p className="text-sm font-semibold text-foreground">Matching policy for this property</p>
        <p className="text-sm text-muted-foreground">
          Applies to every supplier invoice captured against this property. Anything outside the
          tolerance is held until an authorised person accepts it with a written reason.
        </p>
      </div>

      <FinanceQueryState isLoading={policy.isLoading} error={policy.error} isEmpty={false} empty={null}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="mp-mode">Matching mode</Label>
            <Select value={effective.mode} onValueChange={setMode} disabled={!canEdit}>
              <SelectTrigger id="mp-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="three-way">Three-way (order, delivery, invoice)</SelectItem>
                <SelectItem value="two-way">Two-way (order and invoice)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mp-price-pct">Price tolerance (%)</Label>
            <Input
              id="mp-price-pct"
              inputMode="decimal"
              value={effective.pricePct}
              onChange={(e) => setPricePct(e.target.value)}
              disabled={!canEdit}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mp-price-amt">Price tolerance (amount per unit)</Label>
            <Input
              id="mp-price-amt"
              inputMode="decimal"
              value={effective.priceAmount}
              onChange={(e) => setPriceAmount(e.target.value)}
              disabled={!canEdit}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mp-qty-pct">Quantity tolerance (%)</Label>
            <Input
              id="mp-qty-pct"
              inputMode="decimal"
              value={effective.qtyPct}
              onChange={(e) => setQtyPct(e.target.value)}
              disabled={!canEdit}
            />
          </div>
        </div>

        {canEdit ? (
          <Button
            size="sm"
            disabled={save.isPending}
            onClick={() =>
              save.mutate({
                match_mode: effective.mode === "two-way" ? "two-way" : "three-way",
                price_tolerance_pct: Number(effective.pricePct) || 0,
                price_tolerance_amount: Number(effective.priceAmount) || 0,
                quantity_tolerance_pct: Number(effective.qtyPct) || 0,
              })
            }
          >
            Save policy
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">
            Changing the matching policy requires finance edit rights.
          </p>
        )}
      </FinanceQueryState>
    </div>
  );
}

/**
 * Releasing a scheduled payable records a real transfer: which account it left,
 * the bank's reference and the value date. NEØ does not move money itself, so
 * the reference is what lets the statement confirm the payment later.
 */
const BANK_METHODS = ["bank_transfer", "bank-transfer", "cheque", "check", "rtgs", "eft"];

function ReleaseScheduleDialog({
  method,
  busy,
  onRelease,
}: {
  method: string;
  busy: boolean;
  onRelease: (input: {
    bankAccountId?: string;
    reference?: string;
    paidOn?: string;
    reason?: string;
  }) => void;
}) {
  const accounts = useBankAccounts();
  const needsBank = BANK_METHODS.includes(method.toLowerCase());
  const [bankAccountId, setBankAccountId] = useState("");
  const [reference, setReference] = useState("");
  const [paidOn, setPaidOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");

  const usable = (accounts.data ?? []).filter((a) => Boolean(a["active"]));

  return (
    <FormDialog
      trigger={<Button size="sm">Release to payment</Button>}
      title="Release payment"
      description="Record the transfer you are making in the bank, with its reference."
    >
      {(close) => (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Paid from account{needsBank ? "" : " (optional)"}</Label>
            <Select value={bankAccountId} onValueChange={setBankAccountId}>
              <SelectTrigger aria-label="Paying account">
                <SelectValue placeholder="Choose an account" />
              </SelectTrigger>
              <SelectContent>
                {usable.map((a) => (
                  <SelectItem key={String(a["id"])} value={String(a["id"])}>
                    {`${String(a["name"])} — ${String(a["bank_name"] ?? "")} ${String(
                      a["account_number_masked"] ?? "",
                    )}`.trim()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {usable.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No active accounts yet. Add one on the Bank Accounts screen first.
              </p>
            ) : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Bank reference{needsBank ? "" : " (optional)"}</Label>
              <Input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Transfer or cheque reference"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Value date</Label>
              <NeoDatePicker value={paidOn} onChange={setPaidOn} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Note (optional)</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </div>
          <Button
            className="w-full"
            disabled={busy || (needsBank && (!bankAccountId || reference.trim() === ""))}
            onClick={() => {
              onRelease({
                ...(bankAccountId ? { bankAccountId } : {}),
                ...(reference.trim() ? { reference: reference.trim() } : {}),
                ...(paidOn ? { paidOn } : {}),
                ...(reason.trim() ? { reason: reason.trim() } : {}),
              });
              close();
            }}
          >
            Record payment
          </Button>
        </div>
      )}
    </FormDialog>
  );
}
