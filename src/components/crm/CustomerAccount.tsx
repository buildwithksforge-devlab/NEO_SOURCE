/**
 * Customer account and billing.
 *
 * The money side of a guest profile: the credit line that the corporate account
 * carries (when the guest bills to one), every invoice raised against the
 * customer, the money they have paid, credit notes issued and the latest
 * statement position. Every figure is read from the same invoice, payment and
 * statement records the cashbook and the reconciliation panel read — nothing
 * here is estimated, and nothing is shown as a credit limit unless a credit
 * line has actually been configured.
 */
import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useCustomerChildren, titleCase } from "@/lib/crm";

type Row = Record<string, unknown>;

const money = (value: unknown, currency = "KES") => {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "—";
  return `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const day = (value: unknown) => (value ? new Date(String(value)).toLocaleDateString() : "—");

/** The credit line, when the guest bills through a corporate account. */
function useCreditLine(corporateAccountId: string | null) {
  return useQuery({
    queryKey: ["crm-credit-line", corporateAccountId],
    enabled: Boolean(corporateAccountId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("corporate_accounts")
        .select("id, legal_name, corporate_credit_settings(*)")
        .eq("id", corporateAccountId as string)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as Row | null;
    },
  });
}

function Table({
  columns,
  rows,
  empty,
}: {
  columns: string[];
  rows: Array<Array<React.ReactNode>>;
  empty: string;
}) {
  if (!rows.length) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        {empty}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            {columns.map((c) => (
              <th key={c} className="py-2 pr-4 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i} className="border-b border-border/60 last:border-0">
              {cells.map((cell, j) => (
                <td key={j} className="py-2 pr-4 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CustomerAccount({
  customerId,
  corporateAccountId,
}: {
  customerId: string;
  corporateAccountId: string | null;
}) {
  const invoices = useCustomerChildren<Row>("invoices", customerId, "issue_date");
  const payments = useCustomerChildren<Row>("payments", customerId, "paid_at");
  const creditNotes = useCustomerChildren<Row>("credit_notes", customerId, "issue_date");
  const statements = useCustomerChildren<Row>("customer_statements", customerId, "period_end");
  const creditLine = useCreditLine(corporateAccountId);

  const settings = (creditLine.data?.["corporate_credit_settings"] ?? null) as Row | Row[] | null;
  const credit = (Array.isArray(settings) ? settings[0] : settings) ?? null;

  const totals = useMemo(() => {
    const invoiceRows = invoices.data ?? [];
    const billed = invoiceRows.reduce((sum, r) => sum + Number(r["total"] ?? 0), 0);
    const outstanding = invoiceRows
      .filter((r) => String(r["status"] ?? "") !== "cancelled")
      .reduce((sum, r) => sum + Number(r["balance"] ?? 0), 0);
    const paid = (payments.data ?? [])
      .filter((r) => String(r["status"] ?? "completed") !== "reversed")
      .reduce((sum, r) => sum + Number(r["amount"] ?? 0), 0);
    const credited = (creditNotes.data ?? []).reduce((sum, r) => sum + Number(r["total"] ?? 0), 0);
    return { billed, outstanding, paid, credited };
  }, [invoices.data, payments.data, creditNotes.data]);

  const limit = credit ? Number(credit["credit_limit"] ?? 0) : null;
  const available = limit === null ? null : limit - totals.outstanding;

  const lead: SummaryFigure = {
    id: "outstanding",
    label: "Outstanding",
    value: money(totals.outstanding),
    hint: "Invoiced and not yet settled",
  };
  const figures: SummaryFigure[] = [
    { id: "billed", label: "Billed", value: money(totals.billed) },
    { id: "received", label: "Received", value: money(totals.paid) },
    { id: "credited", label: "Credited back", value: money(totals.credited) },
    {
      id: "limit",
      label: "Credit limit",
      value: limit === null ? "No credit line" : money(limit),
      hint:
        limit === null
          ? "This guest settles on departure; a credit line is configured on a corporate account."
          : `Available ${money(available)}`,
    },
  ];

  const latest = (statements.data ?? [])[0] ?? null;

  return (
    <div className="space-y-6">
      <SummaryStrip lead={lead} figures={figures} />

      <SectionCard
        title="Credit line"
        description="Credit is granted on the corporate account this guest bills to."
      >
        {credit ? (
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Account</dt>
              <dd>{String(creditLine.data?.["legal_name"] ?? "—")}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Credit limit</dt>
              <dd>{money(credit["credit_limit"])}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Payment terms</dt>
              <dd>{credit["payment_terms_days"] ? `${credit["payment_terms_days"]} days` : "Not set"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <StatusPill>{titleCase(String(credit["status"] ?? "active"))}</StatusPill>
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Currently owed</dt>
              <dd>{money(totals.outstanding)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Still available</dt>
              <dd>{money(available)}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            No credit line is configured for this guest. Charges are settled on departure, or through a
            corporate account once one is linked on the Contact tab.
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="Invoices"
        description="Every invoice raised against this guest, with what is still owed."
        actions={
          <Button asChild size="sm" variant="outline">
            <Link to="/finance/receivables">Open receivables</Link>
          </Button>
        }
      >
        <Table
          columns={["Invoice", "Issued", "Due", "Total", "Paid", "Balance", "Status"]}
          empty="No invoice has been raised for this guest."
          rows={(invoices.data ?? []).map((r) => [
            String(r["invoice_number"] ?? "—"),
            day(r["issue_date"]),
            day(r["due_date"]),
            money(r["total"], String(r["currency"] ?? "KES")),
            money(r["amount_paid"], String(r["currency"] ?? "KES")),
            money(r["balance"], String(r["currency"] ?? "KES")),
            <StatusPill key="s">{titleCase(String(r["status"] ?? "draft"))}</StatusPill>,
          ])}
        />
      </SectionCard>

      <SectionCard
        title="Payments received"
        description="Money received from this guest, as posted to the cashbook."
        actions={
          <Button asChild size="sm" variant="outline">
            <Link to="/finance/cashbook">Open cashbook</Link>
          </Button>
        }
      >
        <Table
          columns={["Receipt", "Received", "Method", "Amount", "Posted", "Status"]}
          empty="No payment has been received from this guest yet."
          rows={(payments.data ?? []).map((r) => [
            String(r["receipt_number"] ?? "—"),
            day(r["paid_at"] ?? r["created_at"]),
            titleCase(String(r["method"] ?? "—")),
            money(r["amount"], String(r["currency"] ?? "KES")),
            r["posted_journal_id"] ? "Posted to the books" : "Not yet posted",
            <StatusPill key="s">{titleCase(String(r["status"] ?? "completed"))}</StatusPill>,
          ])}
        />
      </SectionCard>

      <SectionCard title="Credit notes" description="Amounts credited back against invoices.">
        <Table
          columns={["Note", "Issued", "Reason", "Total", "Status"]}
          empty="No credit note has been issued to this guest."
          rows={(creditNotes.data ?? []).map((r) => [
            String(r["note_number"] ?? "—"),
            day(r["issue_date"]),
            String(r["reason"] ?? "—"),
            money(r["total"], String(r["currency"] ?? "KES")),
            <StatusPill key="s">{titleCase(String(r["status"] ?? "draft"))}</StatusPill>,
          ])}
        />
      </SectionCard>

      <SectionCard
        title="Latest statement"
        description="The last statement period issued for this account."
      >
        {latest ? (
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Statement</dt>
              <dd>{String(latest["statement_number"] ?? "—")}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Period</dt>
              <dd>
                {day(latest["period_start"])} — {day(latest["period_end"])}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Opening</dt>
              <dd>{money(latest["opening_balance"], String(latest["currency"] ?? "KES"))}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Closing</dt>
              <dd>{money(latest["closing_balance"], String(latest["currency"] ?? "KES"))}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Over 90 days</dt>
              <dd>{money(latest["bucket_over_90"], String(latest["currency"] ?? "KES"))}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">No statement has been issued for this guest.</p>
        )}
      </SectionCard>
    </div>
  );
}
