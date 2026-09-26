/**
 * The cashbook.
 *
 * One screen for the money position: every bank, M-Pesa, card settlement and
 * cash account, the posted book balance of each from the general ledger, the
 * statement position where statements have been imported, money received,
 * invoices still owed and the real total cash balance. Nothing here is
 * estimated — every figure comes from posted journal lines, imported statement
 * entries or the invoice and payment records themselves.
 */
import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import { Label } from "@/components/ui/label";
import { NeoDatePicker } from "@/components/common/DatePicker";
import {
  DataTable,
  FinanceEmpty,
  FinanceGuard,
  FinanceQueryState,
  FinStatus,
  financeHead,
} from "@/components/finance/FinanceShared";
import { money, num, shortDate, titleCase } from "@/lib/finance";
import {
  useBankAccounts,
  useAccounts,
  useFinanceFactScope,
  useGeneralLedger,
  useInvoices,
  useStatementEntries,
} from "@/lib/finance-data";
import { usePaymentLifecycle } from "@/lib/payment-lifecycle";
import { useCorporateAccounts } from "@/lib/frontdesk-ops";
import { PayrollCashSection } from "@/components/finance/PayrollCashSection";
import { RecordReceiptDialog } from "@/components/finance/RecordReceiptDialog";

export const Route = createFileRoute("/_shell/finance/cashbook")({
  head: financeHead(
    "Cashbook",
    "Every bank, mobile money and cash account with its posted balance, money in and out, outstanding invoices and the real cash position.",
  ),
  component: () => (
    <FinanceGuard feature="reconciliation" action="view">
      <CashbookPage />
    </FinanceGuard>
  ),
});

/** An account belongs in the cashbook when it is a cash or bank asset account. */
function isCashAccount(row: Record<string, unknown>): boolean {
  const group = String(row["account_group"] ?? "").toLowerCase();
  const name = String(row["name"] ?? "").toLowerCase();
  if (String(row["category"] ?? "") !== "asset") return false;
  return (
    group.includes("cash") ||
    group.includes("bank") ||
    name.includes("cash on hand") ||
    name.includes("bank") ||
    name.includes("mpesa") ||
    name.includes("m-pesa")
  );
}

function CashbookPage() {
  const scope = useFinanceFactScope();
  const [from, setFrom] = useState(scope.from);
  const [to, setTo] = useState(scope.to);

  const accounts = useAccounts();
  const bankAccounts = useBankAccounts();
  const ledger = useGeneralLedger(from, to, null);
  const receiptsQuery = usePaymentLifecycle({ branchId: scope.branchId, from, to });
  const invoices = useInvoices("all");
  const statements = useStatementEntries(null);
  const creditAccounts = useCorporateAccounts("");

  const cashAccountIds = useMemo(() => {
    const ids = new Set<string>();
    for (const a of accounts.data ?? []) {
      if (isCashAccount(a as Record<string, unknown>)) ids.add(String(a["id"]));
    }
    // A bank account that names its ledger account belongs here even when the
    // chart groups it somewhere else.
    for (const b of bankAccounts.data ?? []) {
      const gl = b["gl_account_id"];
      if (gl) ids.add(String(gl));
    }
    return ids;
  }, [accounts.data, bankAccounts.data]);

  const lines = useMemo(
    () => (ledger.data ?? []).filter((l) => cashAccountIds.has(l.account_id)),
    [ledger.data, cashAccountIds],
  );

  /** Posted balance per ledger account: the last running balance in the period. */
  const balanceByAccount = useMemo(() => {
    const map = new Map<
      string,
      { code: string; name: string; opening: number; in: number; out: number; balance: number }
    >();
    for (const a of accounts.data ?? []) {
      const id = String(a["id"]);
      if (!cashAccountIds.has(id)) continue;
      map.set(id, {
        code: String(a["code"] ?? ""),
        name: String(a["name"] ?? ""),
        opening: 0,
        in: 0,
        out: 0,
        balance: 0,
      });
    }
    for (const l of lines) {
      const entry = map.get(l.account_id);
      if (!entry) continue;
      entry.opening = l.opening_balance;
      entry.in += l.debit;
      entry.out += l.credit;
      entry.balance = l.running_balance;
    }
    for (const entry of map.values()) {
      if (entry.in === 0 && entry.out === 0) entry.balance = entry.opening;
    }
    return map;
  }, [accounts.data, cashAccountIds, lines]);

  const statementByAccount = useMemo(() => {
    const map = new Map<string, { balance: number; unmatched: number }>();
    for (const e of statements.data ?? []) {
      const id = String(e["bank_account_id"] ?? "");
      if (!id) continue;
      const current = map.get(id) ?? { balance: 0, unmatched: 0 };
      const amount = num(e["amount"]);
      const signed = String(e["direction"] ?? "") === "out" ? -amount : amount;
      current.balance += signed;
      if (String(e["status"] ?? "") === "unreconciled") current.unmatched += 1;
      map.set(id, current);
    }
    return map;
  }, [statements.data]);

  const totalBalance = useMemo(
    () => [...balanceByAccount.values()].reduce((sum, a) => sum + a.balance, 0),
    [balanceByAccount],
  );
  const moneyIn = useMemo(() => lines.reduce((s, l) => s + l.debit, 0), [lines]);
  const moneyOut = useMemo(() => lines.reduce((s, l) => s + l.credit, 0), [lines]);

  const outstandingInvoices = useMemo(
    () =>
      (invoices.data ?? []).filter(
        (i) => num(i["balance"]) > 0.005 && !["cancelled", "void", "draft"].includes(String(i["status"] ?? "")),
      ),
    [invoices.data],
  );
  const owed = outstandingInvoices.reduce((s, i) => s + num(i["balance"]), 0);

  /**
   * What each credit customer owes is the sum of its own unpaid invoices — not
   * a stored figure that can drift from the books.
   */
  const customerAccounts = useMemo(() => {
    const owedByAccount = new Map<string, number>();
    for (const i of outstandingInvoices) {
      const id = String(i["corporate_account_id"] ?? "");
      if (!id) continue;
      owedByAccount.set(id, (owedByAccount.get(id) ?? 0) + num(i["balance"]));
    }
    return (creditAccounts.data ?? []).map((a) => {
      const id = String(a["id"]);
      const settings = (Array.isArray(a["corporate_credit_settings"])
        ? a["corporate_credit_settings"][0]
        : a["corporate_credit_settings"]) as Record<string, unknown> | null | undefined;
      const rawLimit = settings?.["credit_limit"];
      return {
        id,
        name: String(a["legal_name"] ?? "—"),
        accountNumber: String(a["account_number"] ?? "—"),
        status: String(settings?.["credit_status"] ?? a["account_status"] ?? ""),
        limit: rawLimit === null || rawLimit === undefined ? null : num(rawLimit),
        owed: owedByAccount.get(id) ?? 0,
      };
    });
  }, [creditAccounts.data, outstandingInvoices]);

  // Receipts come from the one canonical lifecycle, so the stage shown here is
  // the stage the posted journal proves — never a status word from a module.
  const receipts = useMemo(
    () => (receiptsQuery.data ?? []).filter((p) => p.stage !== "unsuccessful"),
    [receiptsQuery.data],
  );

  const lead: SummaryFigure = {
    id: "balance",
    label: "Cash and bank balance",
    value: money(totalBalance),
    hint: "Posted ledger position",
  };
  const figures: SummaryFigure[] = [
    { id: "in", label: "Money in", value: money(moneyIn), hint: `${shortDate(from)} – ${shortDate(to)}` },
    { id: "out", label: "Money out", value: money(moneyOut), hint: `${shortDate(from)} – ${shortDate(to)}` },
    {
      id: "owed",
      label: "Still owed to us",
      value: money(owed),
      hint: `${outstandingInvoices.length} open invoice${outstandingInvoices.length === 1 ? "" : "s"}`,
    },
  ];

  const loading = accounts.isLoading || ledger.isLoading || bankAccounts.isLoading;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cashbook"
        description="Bank, mobile money and cash accounts with their posted balances, the money that moved, what is still owed and the real cash position."
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label>From</Label>
          <NeoDatePicker value={from} onChange={setFrom} />
        </div>
        <div className="space-y-1">
          <Label>To</Label>
          <NeoDatePicker value={to} onChange={setTo} />
        </div>
      </div>

      <SummaryStrip lead={lead} figures={figures} />

      <SectionCard
        title="Accounts"
        description="Each cash and bank account with its opening position, movement and closing balance for the period."
      >
        <FinanceQueryState
          isLoading={loading}
          error={ledger.error ?? accounts.error}
          isEmpty={balanceByAccount.size === 0}
          empty={
            <FinanceEmpty
              title="No cash or bank accounts"
              description="No cash or bank ledger accounts are configured for this property yet."
            />
          }
        >
          {(
            <DataTable
              head={["Account", "Opening", "In", "Out", "Balance", "Statement", "Unmatched"]}
              unit="accounts"
            >
              {[...balanceByAccount.entries()].map(([id, a]) => {
                const bank = (bankAccounts.data ?? []).find(
                  (b) => String(b["gl_account_id"] ?? "") === id,
                );
                const statement = bank ? statementByAccount.get(String(bank["id"])) : undefined;
                const drift = statement ? Math.abs(statement.balance - a.balance) > 0.005 : false;
                return (
                  <tr key={id} className="align-top">
                    <td className="py-2 pr-4">
                      <div className="font-medium">
                        {a.code} — {a.name}
                      </div>
                      {bank ? (
                        <div className="text-xs text-muted-foreground">
                          {String(bank["name"])} · {titleCase(String(bank["account_kind"] ?? ""))}
                          {bank["account_number_masked"] ? ` · ${String(bank["account_number_masked"])}` : ""}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4 tabular-nums">{money(a.opening)}</td>
                    <td className="py-2 pr-4 tabular-nums">{money(a.in)}</td>
                    <td className="py-2 pr-4 tabular-nums">{money(a.out)}</td>
                    <td className="py-2 pr-4 font-medium tabular-nums">{money(a.balance)}</td>
                    <td className="py-2 pr-4 tabular-nums">
                      {statement ? (
                        <span className={drift ? "text-destructive" : undefined}>
                          {money(statement.balance)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">No statement</span>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {statement && statement.unmatched > 0 ? (
                        <span className="inline-flex items-center gap-1 text-destructive">
                          <AlertTriangle className="size-3.5" aria-hidden />
                          {statement.unmatched}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </DataTable>
          )}
        </FinanceQueryState>
      </SectionCard>

      <SectionCard
        title="Cashbook entries"
        description="Every posted movement through a cash or bank account in the period, newest last."
      >
        <FinanceQueryState
          isLoading={ledger.isLoading}
          error={ledger.error}
          isEmpty={lines.length === 0}
          empty={
            <FinanceEmpty
              title="No movements"
              description="No cash or bank movements were posted in this period."
            />
          }
        >
          {(
            <DataTable
              head={["Date", "Account", "Document", "Description", "In", "Out", "Balance"]}
              unit="entries"
            >
              {lines.map((l) => (
                <tr key={l.line_id}>
                  <td className="py-2 pr-4 whitespace-nowrap">{shortDate(l.accounting_date ?? "")}</td>
                  <td className="py-2 pr-4">{l.account_code}</td>
                  <td className="py-2 pr-4">{l.document_number ?? l.journal_number ?? "—"}</td>
                  <td className="py-2 pr-4">{l.description ?? "—"}</td>
                  <td className="py-2 pr-4 tabular-nums">{l.debit ? money(l.debit) : "—"}</td>
                  <td className="py-2 pr-4 tabular-nums">{l.credit ? money(l.credit) : "—"}</td>
                  <td className="py-2 pr-4 tabular-nums">{money(l.running_balance)}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </FinanceQueryState>
      </SectionCard>

      <PayrollCashSection from={from} to={to} />

      <SectionCard
        title="Money received"
        description="Every receipt read from the one canonical payment lifecycle, with the stage each has actually reached."
      >
        <FinanceQueryState
          isLoading={receiptsQuery.isLoading}
          error={receiptsQuery.error}
          isEmpty={receipts.length === 0}
          empty={<FinanceEmpty title="No receipts" description="No receipts have been recorded yet." />}
        >
          {(
            <DataTable head={["Receipt", "Paid", "Method", "Amount", "Stage", "Journal"]} unit="receipts">
              {receipts.map((p) => (
                <tr key={p.paymentId}>
                  <td className="py-2 pr-4">{p.receiptNumber ?? "—"}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{shortDate(p.paidAt ?? "")}</td>
                  <td className="py-2 pr-4">{titleCase(p.method ?? "")}</td>
                  <td className="py-2 pr-4 tabular-nums">{money(p.amount)}</td>
                  <td className="py-2 pr-4">
                    <FinStatus value={p.stageLabel} />
                  </td>
                  <td className="py-2 pr-4 text-xs text-muted-foreground">
                    {p.journalNumber ?? "—"}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </FinanceQueryState>
      </SectionCard>

      <SectionCard
        title="Customer accounts"
        description="Credit customers, what each owes against its approved limit, and the credit still available."
      >
        <FinanceQueryState
          isLoading={creditAccounts.isLoading}
          error={creditAccounts.error}
          isEmpty={customerAccounts.length === 0}
          empty={
            <FinanceEmpty
              title="No credit customers"
              description="No customer account has been set up for this property yet."
            />
          }
        >
          {(
            <DataTable
              head={["Customer", "Account", "Status", "Credit limit", "Owed", "Available"]}
              unit="accounts"
            >
              {customerAccounts.map((c) => (
                <tr key={c.id}>
                  <td className="py-2 pr-4">{c.name}</td>
                  <td className="py-2 pr-4">{c.accountNumber}</td>
                  <td className="py-2 pr-4">
                    <FinStatus value={c.status} />
                  </td>
                  <td className="py-2 pr-4 tabular-nums">
                    {c.limit === null ? "Not configured" : money(c.limit)}
                  </td>
                  <td className="py-2 pr-4 font-medium tabular-nums">{money(c.owed)}</td>
                  <td className="py-2 pr-4 tabular-nums">
                    {c.limit === null ? "—" : money(c.limit - c.owed)}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </FinanceQueryState>
      </SectionCard>

      <SectionCard title="Invoices still owed" description="Issued invoices with a balance outstanding.">
        <FinanceQueryState
          isLoading={invoices.isLoading}
          error={invoices.error}
          isEmpty={outstandingInvoices.length === 0}
          empty={<FinanceEmpty title="Nothing outstanding" description="No invoice is currently outstanding." />}
        >
          {(
            <DataTable head={["Invoice", "Issued", "Due", "Billed to", "Total", "Balance", "Status", "Receipt"]} unit="invoices">
              {outstandingInvoices.map((i) => (
                <tr key={String(i["id"])}>
                  <td className="py-2 pr-4">{String(i["invoice_number"] ?? "—")}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{shortDate(String(i["issue_date"] ?? ""))}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{shortDate(String(i["due_date"] ?? ""))}</td>
                  <td className="py-2 pr-4">
                    {(i["corporate_accounts"] as { legal_name?: string } | null)?.legal_name ??
                      (i["customers"] as { full_name?: string } | null)?.full_name ??
                      "—"}
                  </td>
                  <td className="py-2 pr-4 tabular-nums">{money(num(i["total"]))}</td>
                  <td className="py-2 pr-4 font-medium tabular-nums">{money(num(i["balance"]))}</td>
                  <td className="py-2 pr-4">
                    <FinStatus value={String(i["status"] ?? "")} />
                  </td>
                  <td className="py-2 pr-4">
                    <RecordReceiptDialog invoice={i} />
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </FinanceQueryState>
      </SectionCard>
    </div>
  );
}
