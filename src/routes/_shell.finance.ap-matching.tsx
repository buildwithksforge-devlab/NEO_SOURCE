/**
 * AP three-way matching workspace.
 *
 * One register of payables, each showing whether the purchase order, the goods
 * received and the supplier invoice agree, the journal it produced with its
 * debit and credit totals, and — for a held invoice — the exact lines that
 * disagree. A held invoice cannot become a payable: the database refuses the
 * payment schedule and the payment, and this page says so before the attempt.
 */
import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import {
  InspectorField,
  InspectorSection,
  InspectorSheet,
} from "@/components/common/InspectorSheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  financeHead,
} from "@/components/finance/FinanceShared";
import { money, shortDate, titleCase } from "@/lib/finance";
import { useAuth } from "@/lib/auth";
import {
  payableBlocked,
  useApJournalRegister,
  useApMatchLines,
  type ApRegisterRow,
} from "@/lib/ap-matching";
import { PaymentConveyor } from "@/components/finance/PaymentConveyor";
import { useAdvanceSupplierPayment, useSupplierPayments } from "@/lib/finance-data";

import {
  useAcceptSupplierInvoice,
  useInvoiceDiscrepancies,
  useThreeWayMatch,
} from "@/lib/procurement-data";

export const Route = createFileRoute("/_shell/finance/ap-matching")({
  head: financeHead(
    "AP Three-Way Matching",
    "Purchase order, goods received and supplier invoice line matching with exceptions and journal balances.",
  ),
  component: () => (
    <FinanceGuard feature="ap" action="view">
      <ApMatchingPage />
    </FinanceGuard>
  ),
});

const MATCH_FILTERS = ["all", "held", "review", "matched", "unmatched"];

function MatchPill({ value }: { value: string }) {
  const tone =
    value === "matched"
      ? "border-success/40 text-success"
      : value === "held"
        ? "border-destructive/40 text-destructive"
        : value === "review"
          ? "border-warning/40 text-warning"
          : "border-border text-muted-foreground";
  return (
    <Badge variant="outline" className={tone}>
      {titleCase(value)}
    </Badge>
  );
}

function ApMatchingPage() {
  const { can, isAdmin } = useAuth();
  const canAccept = isAdmin || can("finance", "approve");
  const [filter, setFilter] = useState("all");
  const [inspect, setInspect] = useState<ApRegisterRow | null>(null);
  const [reason, setReason] = useState("");

  const register = useApJournalRegister(filter);
  const lines = useApMatchLines(inspect?.invoice_id);
  const discrepancies = useInvoiceDiscrepancies(inspect?.invoice_id ?? null);
  const rematch = useThreeWayMatch();
  const accept = useAcceptSupplierInvoice();
  // The release conveyor for whatever payment this invoice already has, so a
  // matched payable reaches the journal from the same screen that matched it.
  const payments = useSupplierPayments();
  const advance = useAdvanceSupplierPayment();
  const invoicePayments = ((payments.data ?? []) as Record<string, unknown>[]).filter(
    (p) => inspect && String(p["supplier_invoice_id"] ?? "") === inspect.invoice_id,
  );


  const rows = useMemo(() => register.data ?? [], [register.data]);
  const held = rows.filter((r) => r.match_status === "held");
  const review = rows.filter((r) => r.match_status === "review");
  const unbalanced = rows.filter((r) => r.journal_id && !r.balanced);

  const lead: SummaryFigure = {
    id: "held",
    label: "Blocked from payment",
    value: register.isLoading ? "…" : held.length,
    tone: held.length ? "destructive" : "success",
    hint: "Matching must be resolved before a payable is created",
  };
  const figures: SummaryFigure[] = [
    { id: "review", label: "Needs review", value: register.isLoading ? "…" : review.length, tone: review.length ? "warning" : "default" },
    { id: "matched", label: "Matched", value: register.isLoading ? "…" : rows.filter((r) => r.match_status === "matched").length },
    { id: "journals", label: "Journalised", value: register.isLoading ? "…" : rows.filter((r) => r.journal_id).length },
    { id: "unbalanced", label: "Unbalanced journals", value: register.isLoading ? "…" : unbalanced.length, tone: unbalanced.length ? "destructive" : "success" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="AP three-way matching"
        description="Every payable, matched line by line against its purchase order and goods received, with the journal it produced."
      />
      <SummaryStrip lead={lead} figures={figures} />

      <div className="rounded-xl border border-border/70 bg-card p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Matching status" />
            </SelectTrigger>
            <SelectContent>
              {MATCH_FILTERS.map((f) => (
                <SelectItem key={f} value={f}>
                  {f === "all" ? "All matching states" : titleCase(f)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <FinanceQueryState
          isLoading={register.isLoading}
          error={register.error}
          isEmpty={rows.length === 0}
          empty={
            <FinanceEmpty
              title="No supplier invoices"
              description="Capture a supplier invoice against a purchase order and it will be matched here automatically."
            />
          }
        >
          <DataTable
            unit="payables"
            head={[
              "Invoice",
              "Supplier",
              "Purchase order",
              "Goods receipt",
              "Amount",
              "Matching",
              "Exceptions",
              "Journal",
              "Debit",
              "Credit",
              "Balanced",
            ]}
          >
            {rows.map((r) => (
              <tr
                key={r.invoice_id}
                className="cursor-pointer align-middle hover:bg-muted/40"
                onClick={() => {
                  setInspect(r);
                  setReason("");
                }}
              >
                <td className="py-2 pr-4">
                  <div className="font-medium">{r.invoice_number ?? "—"}</div>
                  <div className="text-xs text-muted-foreground">{shortDate(r.invoice_date)}</div>
                </td>
                <td className="py-2 pr-4">{r.supplier_name ?? "—"}</td>
                <td className="py-2 pr-4">{r.order_number ?? "Not linked"}</td>
                <td className="py-2 pr-4">{r.grn_number ?? "—"}</td>
                <td className="py-2 pr-4">{money(r.amount)}</td>
                <td className="py-2 pr-4"><MatchPill value={r.match_status} /></td>
                <td className="py-2 pr-4">
                  {r.exception_count ? `${r.exception_count} (${r.critical_count} critical)` : "None"}
                </td>
                <td className="py-2 pr-4">{r.journal_number ?? "Not journalised"}</td>
                <td className="py-2 pr-4">{r.journal_id ? money(r.total_debit) : "—"}</td>
                <td className="py-2 pr-4">{r.journal_id ? money(r.total_credit) : "—"}</td>
                <td className="py-2 pr-4">
                  {r.journal_id ? (r.balanced ? "Balanced" : "Out of balance") : "—"}
                </td>
              </tr>
            ))}
          </DataTable>
        </FinanceQueryState>
      </div>

      <InspectorSheet
        open={Boolean(inspect)}
        onOpenChange={(open) => !open && setInspect(null)}
        title={`Invoice ${inspect?.invoice_number ?? ""}`}
        subtitle={inspect?.supplier_name ?? "Supplier invoice"}
        chips={inspect ? <MatchPill value={inspect.match_status} /> : null}
      >
        {inspect ? (
          <div className="space-y-5">
            {payableBlocked(inspect) ? (
              <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                Payable blocked — this invoice is held on three-way matching. A payment schedule or
                supplier payment cannot be created until the exceptions are resolved or the invoice
                is accepted with authority.
              </p>
            ) : null}

            <InspectorSection title="Payable">
              <InspectorField label="Status"><FinStatus value={inspect.status} /></InspectorField>
              <InspectorField label="Amount">{money(inspect.amount)}</InspectorField>
              <InspectorField label="Tax">{money(inspect.tax_amount)}</InspectorField>
              <InspectorField label="Paid">{money(inspect.paid_amount)}</InspectorField>
              <InspectorField label="Purchase order">{inspect.order_number ?? "Not linked"}</InspectorField>
              <InspectorField label="Goods receipt">{inspect.grn_number ?? "—"}</InspectorField>
              <InspectorField label="Property">{inspect.property ?? "—"}</InspectorField>
              <InspectorField label="Due">{shortDate(inspect.due_date)}</InspectorField>
            </InspectorSection>

            <InspectorSection title="Journal header">
              <InspectorField label="Journal">{inspect.journal_number ?? "Not journalised"}</InspectorField>
              <InspectorField label="Journal status">{inspect.journal_status ?? "—"}</InspectorField>
              <InspectorField label="Accounting date">{shortDate(inspect.accounting_date)}</InspectorField>
              <InspectorField label="Total debit">{money(inspect.total_debit)}</InspectorField>
              <InspectorField label="Total credit">{money(inspect.total_credit)}</InspectorField>
              <InspectorField label="Balance">{inspect.journal_id ? (inspect.balanced ? "Balanced" : "Out of balance") : "—"}</InspectorField>
            </InspectorSection>

            <div className="space-y-2">
              <p className="text-sm font-semibold">Line matching</p>
              <FinanceQueryState
                isLoading={lines.isLoading}
                error={lines.error}
                isEmpty={(lines.data ?? []).length === 0}
                empty={
                  <FinanceEmpty
                    title="No invoice lines"
                    description="This invoice was captured as a header total, so there is nothing to match line by line."
                  />
                }
              >
                <DataTable
                  unit="lines"
                  head={["Item", "Ordered", "Accepted", "Already invoiced", "Claimable", "Invoiced", "PO price", "Invoiced price", "State", "Detail"]}
                >
                  {(lines.data ?? []).map((l) => (
                    <tr key={l.line_id} className="align-middle">
                      <td className="py-2 pr-4">{l.description}</td>
                      <td className="py-2 pr-4">{l.ordered_quantity}</td>
                      <td className="py-2 pr-4">{l.accepted_quantity}</td>
                      <td className="py-2 pr-4">{l.other_invoiced_quantity}</td>
                      <td className="py-2 pr-4">{Math.round(l.claimable_quantity * 1000) / 1000}</td>
                      <td className="py-2 pr-4">{l.invoiced_quantity}</td>
                      <td className="py-2 pr-4">{money(l.order_unit_price)}</td>
                      <td className="py-2 pr-4">{money(l.invoiced_unit_price)}</td>
                      <td className="py-2 pr-4"><MatchPill value={l.match_state} /></td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">{l.detail}</td>
                    </tr>
                  ))}
                </DataTable>
              </FinanceQueryState>
            </div>

            {(discrepancies.data ?? []).length ? (
              <div className="space-y-2">
                <p className="text-sm font-semibold">Open exceptions</p>
                <ul className="space-y-1 text-sm">
                  {(discrepancies.data ?? []).map((d) => (
                    <li key={String(d["id"])} className="rounded-md border border-border/70 p-2">
                      <span className="font-medium">{titleCase(String(d["kind"] ?? ""))}</span>{" "}
                      <span className="text-xs text-muted-foreground">
                        ({String(d["severity"] ?? "")})
                      </span>
                      <div className="text-xs text-muted-foreground">{String(d["detail"] ?? "")}</div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="space-y-2">
              <p className="text-sm font-semibold">Payment release</p>
              {invoicePayments.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No payment scheduled yet. Schedule one in Payables once matching is resolved.
                </p>
              ) : (
                <ul className="space-y-2">
                  {invoicePayments.map((p) => (
                    <li
                      key={String(p["id"])}
                      className="flex items-center justify-between gap-3 rounded-md border border-border/70 p-2"
                    >
                      <div className="text-sm">
                        <span className="font-medium">{String(p["payment_number"] ?? "—")}</span>{" "}
                        <span className="text-muted-foreground">{money(p["amount"])}</span>
                        <div className="text-xs text-muted-foreground">
                          <FinStatus value={String(p["status"] ?? "")} />{" "}
                          {p["journal_id"] ? "Journalised" : "Not journalised"}
                        </div>
                      </div>
                      <PaymentConveyor
                        status={String(p["status"] ?? "")}
                        pending={advance.isPending}
                        onAdvance={(action, why) =>
                          advance.mutate({
                            paymentId: String(p["id"]),
                            action,
                            ...(why ? { reason: why } : {}),
                          })
                        }
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-2">

              <Button
                variant="outline"
                onClick={() => rematch.mutate(inspect.invoice_id)}
                disabled={rematch.isPending}
              >
                Re-run matching
              </Button>
              {canAccept && inspect.match_status !== "matched" ? (
                <>
                  <Textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Authority and reason for accepting this invoice despite the exceptions"
                  />
                  <Button
                    disabled={accept.isPending || reason.trim().length < 8}
                    onClick={() =>
                      accept.mutate({ invoiceId: inspect.invoice_id, reason: reason.trim() })
                    }
                  >
                    Accept with authority
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        ) : null}
      </InspectorSheet>
    </div>
  );
}
