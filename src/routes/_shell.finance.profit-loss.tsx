/**
 * Profit & loss.
 *
 * Built only from posted journal lines dated into the chosen period for the
 * selected property. Nothing is estimated, accrued in the browser or carried
 * forward: an account appears because money was actually posted to it. A
 * period with nothing posted says so instead of presenting zeros as a result.
 */
import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import { Label } from "@/components/ui/label";
import { NeoDatePicker } from "@/components/common/DatePicker";
import {
  DataTable,
  FinanceEmpty,
  FinanceGuard,
  FinanceQueryState,
  financeHead,
} from "@/components/finance/FinanceShared";
import { money, num, shortDate } from "@/lib/finance";
import { useFinanceCtx, useFinanceFactScope, useTrialBalance } from "@/lib/finance-data";

export const Route = createFileRoute("/_shell/finance/profit-loss")({
  head: financeHead(
    "Profit & Loss",
    "Revenue, cost of sales and operating expenses for a chosen period and property, taken from posted journals only.",
  ),
  component: () => (
    <FinanceGuard feature="reports" action="view">
      <ProfitLossPage />
    </FinanceGuard>
  ),
});

type PlLine = { id: string; code: string; name: string; amount: number };
type PlGroup = { key: string; title: string; description: string; lines: PlLine[]; total: number };

/** Income accounts read as credits, cost accounts as debits. */
const CREDIT_CATEGORIES = new Set(["revenue", "other_income"]);

function ProfitLossPage() {
  const { branchId } = useFinanceCtx();
  const scope = useFinanceFactScope();
  const [from, setFrom] = useState(scope.from);
  const [to, setTo] = useState(scope.to);

  const trial = useTrialBalance(from, to, branchId);

  const groups = useMemo<PlGroup[]>(() => {
    const spec: Array<{ key: string; title: string; description: string }> = [
      { key: "revenue", title: "Revenue", description: "Income recognised from posted journals." },
      { key: "other_income", title: "Other income", description: "Income outside the trading lines." },
      { key: "cost_of_sales", title: "Cost of sales", description: "Direct cost of what was sold." },
      {
        key: "operating_expense",
        title: "Operating expenses",
        description: "Running cost posted into this period.",
      },
    ];
    const rows = (trial.data ?? []) as Array<Record<string, unknown>>;
    return spec.map((g) => {
      const lines = rows
        .filter((r) => String(r["category"] ?? "") === g.key)
        .map((r) => {
          const debit = num(r["debit"]);
          const credit = num(r["credit"]);
          return {
            id: String(r["account_id"] ?? r["code"] ?? ""),
            code: String(r["code"] ?? ""),
            name: String(r["name"] ?? ""),
            amount: CREDIT_CATEGORIES.has(g.key) ? credit - debit : debit - credit,
          };
        })
        .filter((l) => Math.abs(l.amount) > 0.005)
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
      return { ...g, lines, total: lines.reduce((s, l) => s + l.amount, 0) };
    });
  }, [trial.data]);

  const totalFor = (key: string) => groups.find((g) => g.key === key)?.total ?? 0;
  const revenue = totalFor("revenue");
  const otherIncome = totalFor("other_income");
  const costOfSales = totalFor("cost_of_sales");
  const expenses = totalFor("operating_expense");
  const grossProfit = revenue - costOfSales;
  const netResult = revenue + otherIncome - costOfSales - expenses;
  const margin = revenue > 0 ? (netResult / revenue) * 100 : null;

  const nothingPosted = groups.every((g) => g.lines.length === 0);

  const lead: SummaryFigure = {
    id: "net",
    label: netResult < 0 ? "Net loss" : "Net profit",
    value: money(netResult),
    hint: `${shortDate(from)} – ${shortDate(to)} · posted journals only`,
    tone: netResult < 0 ? "destructive" : "success",
  };
  const figures: SummaryFigure[] = [
    { id: "revenue", label: "Revenue", value: money(revenue) },
    { id: "gross", label: "Gross profit", value: money(grossProfit), hint: "Revenue less cost of sales" },
    { id: "expenses", label: "Operating expenses", value: money(expenses) },
    {
      id: "margin",
      label: "Net margin",
      value: margin === null ? "—" : `${margin.toFixed(1)}%`,
      hint: margin === null ? "No revenue posted" : "Net result over revenue",
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Profit & Loss"
        description="Revenue and cost by account for the chosen period and property, taken from posted journals only."
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
        title="Statement"
        description="Every account with movement in the period, grouped as it is reported."
      >
        <FinanceQueryState
          isLoading={trial.isLoading}
          error={trial.error}
          isEmpty={nothingPosted}
          empty={
            <FinanceEmpty
              title="Nothing posted in this period"
              description={`No journal was posted between ${shortDate(from)} and ${shortDate(to)} for this property. This is not a zero result — there is simply nothing recorded to report.`}
            />
          }
        >
          <div className="space-y-6">
            {groups
              .filter((g) => g.lines.length > 0)
              .map((g) => (
                <div key={g.key} className="space-y-2">
                  <div>
                    <p className="text-sm font-semibold text-foreground">{g.title}</p>
                    <p className="text-xs text-muted-foreground">{g.description}</p>
                  </div>
                  <DataTable head={["Account", "Amount"]} unit="accounts" pageSize={50}>
                    {g.lines.map((l) => (
                      <tr key={`${g.key}-${l.id}`}>
                        <td className="py-2 pr-4">
                          <span className="font-mono text-xs text-muted-foreground">{l.code}</span>{" "}
                          {l.name}
                        </td>
                        <td className="py-2 pr-4 tabular-nums">{money(l.amount)}</td>
                      </tr>
                    ))}
                    <tr key={`${g.key}-total`} className="font-medium">
                      <td className="py-2 pr-4">Total {g.title.toLowerCase()}</td>
                      <td className="py-2 pr-4 tabular-nums">{money(g.total)}</td>
                    </tr>
                  </DataTable>
                </div>
              ))}

            <div className="rounded-xl border border-border/70 p-4">
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Gross profit</dt>
                  <dd className="tabular-nums font-medium">{money(grossProfit)}</dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Other income</dt>
                  <dd className="tabular-nums font-medium">{money(otherIncome)}</dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">Operating expenses</dt>
                  <dd className="tabular-nums font-medium">{money(expenses)}</dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="font-semibold">{netResult < 0 ? "Net loss" : "Net profit"}</dt>
                  <dd className="tabular-nums font-semibold">{money(netResult)}</dd>
                </div>
              </dl>
            </div>
          </div>
        </FinanceQueryState>
      </SectionCard>
    </div>
  );
}
