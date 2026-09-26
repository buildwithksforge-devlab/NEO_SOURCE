/**
 * General Ledger.
 *
 * Every posted ledger line for the chosen dates, grouped by account and then by
 * accounting period, with the source that produced it and the balance the
 * account carries after it. Figures come from `neo_general_ledger`; nothing on
 * this page recalculates a ledger balance.
 */
import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/DataDisplay";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
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
  DataTable,
  FinanceEmpty,
  FinanceGuard,
  FinanceQueryState,
  financeHead,
} from "@/components/finance/FinanceShared";
import { money, shortDate, titleCase } from "@/lib/finance";
import { useAccounts, useGeneralLedger, type GeneralLedgerLine } from "@/lib/finance-data";

export const Route = createFileRoute("/_shell/finance/general-ledger")({
  head: financeHead(
    "General Ledger",
    "Every posted Finance line grouped by account and period, showing the source transaction, debit, credit and running balance.",
  ),
  component: () => (
    <FinanceGuard feature="gl" action="view">
      <GeneralLedgerPage />
    </FinanceGuard>
  ),
});

const firstOfMonth = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
};
const today = () => new Date().toISOString().slice(0, 10);

type AccountGroup = {
  id: string;
  code: string;
  name: string;
  category: string | null;
  opening: number;
  closing: number;
  debit: number;
  credit: number;
  periods: { period: string; lines: GeneralLedgerLine[] }[];
};

function group(lines: GeneralLedgerLine[]): AccountGroup[] {
  const map = new Map<string, AccountGroup>();
  for (const line of lines) {
    let g = map.get(line.account_id);
    if (!g) {
      g = {
        id: line.account_id,
        code: line.account_code,
        name: line.account_name,
        category: line.account_category,
        opening: line.opening_balance,
        closing: line.opening_balance,
        debit: 0,
        credit: 0,
        periods: [],
      };
      map.set(line.account_id, g);
    }
    const periodName = line.period_name ?? "Unassigned period";
    let p = g.periods.find((x) => x.period === periodName);
    if (!p) {
      p = { period: periodName, lines: [] };
      g.periods.push(p);
    }
    p.lines.push(line);
    g.debit += line.debit;
    g.credit += line.credit;
    g.closing = line.running_balance;
  }
  return [...map.values()].sort((a, b) => a.code.localeCompare(b.code));
}

function GeneralLedgerPage() {
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [account, setAccount] = useState("all");
  const [search, setSearch] = useState("");

  const accounts = useAccounts();
  const ledger = useGeneralLedger(from, to, account === "all" ? null : account);

  const groups = useMemo(() => {
    const rows = ledger.data ?? [];
    const term = search.trim().toLowerCase();
    const filtered = term
      ? rows.filter((r) =>
          `${r.account_code} ${r.account_name} ${r.journal_number ?? ""} ${r.document_number ?? ""} ${r.source_module ?? ""} ${r.description ?? ""}`
            .toLowerCase()
            .includes(term),
        )
      : rows;
    return group(filtered);
  }, [ledger.data, search]);

  const totalDebit = groups.reduce((s, g) => s + g.debit, 0);
  const totalCredit = groups.reduce((s, g) => s + g.credit, 0);
  const lineCount = groups.reduce(
    (s, g) => s + g.periods.reduce((n, p) => n + p.lines.length, 0),
    0,
  );

  const lead: SummaryFigure = {
    id: "lines",
    label: "Posted lines",
    value: ledger.isLoading ? "…" : lineCount,
    hint: `${shortDate(from)} — ${shortDate(to)}`,
  };
  const figures: SummaryFigure[] = [
    { id: "accounts", label: "Accounts with movement", value: ledger.isLoading ? "…" : groups.length },
    { id: "debit", label: "Total debits", value: ledger.isLoading ? "…" : money(totalDebit) },
    { id: "credit", label: "Total credits", value: ledger.isLoading ? "…" : money(totalCredit) },
    {
      id: "diff",
      label: "Debits less credits",
      value: ledger.isLoading ? "…" : money(totalDebit - totalCredit),
      tone: Math.abs(totalDebit - totalCredit) < 0.005 ? "success" : "warning",
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Finance"
        title="General ledger"
        description="Posted lines from every source — rooms and deposits, POS, goods received, payables, events and delivery — grouped by account and period with their running balance."
      />
      <SummaryStrip lead={lead} figures={figures} />

      <div className="grid gap-3 rounded-xl border border-border/70 bg-card p-4 sm:grid-cols-4 sm:items-end">
        <div className="grid gap-1.5">
          <Label htmlFor="gl-from">From</Label>
          <NeoDatePicker id="gl-from" value={from} onChange={setFrom} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="gl-to">To</Label>
          <NeoDatePicker id="gl-to" value={to} onChange={setTo} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="gl-account">Account</Label>
          <Select value={account} onValueChange={setAccount}>
            <SelectTrigger id="gl-account" aria-label="Filter by account">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All accounts</SelectItem>
              {(accounts.data ?? []).map((a) => (
                <SelectItem key={String(a["id"])} value={String(a["id"])}>
                  {String(a["code"])} — {String(a["name"])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="gl-search">Search</Label>
          <Input
            id="gl-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Journal, document or source"
          />
        </div>
      </div>

      <FinanceQueryState
        isLoading={ledger.isLoading}
        error={ledger.error}
        isEmpty={groups.length === 0}
        empty={
          <FinanceEmpty
            title="No posted ledger lines in this range"
            description="Only posted journals appear in the ledger. Widen the dates, clear the filters, or post the pending entries from Posting & Reconciliation."
          />
        }
      >
        <div className="space-y-5">
          {groups.map((g) => (
            <section key={g.id} className="rounded-xl border border-border/70 bg-card">
              <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border/60 px-4 py-3">
                <div>
                  <h2 className="text-sm font-semibold">
                    <span className="font-mono text-xs text-muted-foreground">{g.code}</span>{" "}
                    {g.name}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {g.category ? titleCase(g.category) : "Uncategorised"} · opening{" "}
                    {money(g.opening)}
                  </p>
                </div>
                <dl className="flex gap-6 text-xs">
                  <div>
                    <dt className="text-muted-foreground">Debits</dt>
                    <dd className="font-medium">{money(g.debit)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Credits</dt>
                    <dd className="font-medium">{money(g.credit)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Closing balance</dt>
                    <dd className="font-semibold">{money(g.closing)}</dd>
                  </div>
                </dl>
              </header>

              <div className="px-4 pb-4">
                {g.periods.map((p) => (
                  <div key={p.period} className="pt-3">
                    <p className="pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {p.period}
                    </p>
                    <DataTable
                      unit="lines"
                      head={[
                        "Date",
                        "Journal",
                        "Source",
                        "Document",
                        "Property",
                        "Narrative",
                        "Debit",
                        "Credit",
                        "Balance",
                      ]}
                    >
                      {p.lines.map((l) => (
                        <tr key={l.line_id}>
                          <td className="py-2 pr-4 whitespace-nowrap">
                            {l.accounting_date ? shortDate(l.accounting_date) : "—"}
                          </td>
                          <td className="py-2 pr-4 font-mono text-xs">{l.journal_number ?? "—"}</td>
                          <td className="py-2 pr-4">
                            {l.source_module ? titleCase(l.source_module) : "Manual"}
                            {l.source_document_type ? (
                              <span className="text-muted-foreground">
                                {" "}
                                · {titleCase(l.source_document_type)}
                              </span>
                            ) : null}
                          </td>
                          <td className="py-2 pr-4 font-mono text-xs">
                            {l.document_number ?? "—"}
                          </td>
                          <td className="py-2 pr-4 text-muted-foreground">{l.property ?? "—"}</td>
                          <td className="py-2 pr-4 text-muted-foreground">
                            {l.description ?? "—"}
                          </td>
                          <td className="py-2 pr-4 text-right">
                            {l.debit ? money(l.debit) : "—"}
                          </td>
                          <td className="py-2 pr-4 text-right">
                            {l.credit ? money(l.credit) : "—"}
                          </td>
                          <td className="py-2 pr-4 text-right font-medium">
                            {money(l.running_balance)}
                          </td>
                        </tr>
                      ))}
                    </DataTable>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </FinanceQueryState>
    </div>
  );
}
