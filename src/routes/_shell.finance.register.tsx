/**
 * The shared transaction register, read by day.
 *
 * Room charges, folios, purchase orders, point of sale, deliveries, supplier
 * invoices and payments are read from ONE lifecycle source
 * (`neo_financial_lifecycle_register`), which matches the module's canonical
 * record to the accounting record for the same transaction. The operational
 * position and the money position are shown side by side and never translated
 * into each other; where the two records disagree the row is flagged so it can
 * be investigated instead of quietly averaged away.
 */
import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
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
  FinStatus,
  financeHead,
} from "@/components/finance/FinanceShared";
import { money, shortDate, titleCase } from "@/lib/finance";
import { useFinanceFactScope } from "@/lib/finance-data";
import {
  FAMILY_LABELS,
  summariseLifecycle,
  useFinancialLifecycle,
  type LifecycleRow,
} from "@/lib/financial-lifecycle";
import { financialStatusLabel } from "@/lib/financial-state";
import { usePaymentLifecycle } from "@/lib/payment-lifecycle";

export const Route = createFileRoute("/_shell/finance/register")({
  head: financeHead(
    "Transaction Register",
    "Every room charge, folio, purchase order, sale and supplier payment in one register, grouped by day, with the money position of each.",
  ),
  component: () => (
    <FinanceGuard feature="reconciliation" action="view">
      <RegisterPage />
    </FinanceGuard>
  ),
});

const label = (m: string) => FAMILY_LABELS[m] ?? titleCase(m);

function RegisterPage() {
  const scope = useFinanceFactScope();
  const [familyFilter, setFamilyFilter] = useState<string>("all");
  const [stateFilter, setStateFilter] = useState<string>("all");
  const [onlyDisagreements, setOnlyDisagreements] = useState(false);

  const register = useFinancialLifecycle({
    branchId: scope.branchId,
    from: scope.from,
    to: scope.to,
  });

  const rows = useMemo(() => {
    const all = register.data ?? [];
    return all.filter(
      (r) =>
        (familyFilter === "all" || r.family === familyFilter) &&
        (stateFilter === "all" || r.financialStatus === stateFilter) &&
        (!onlyDisagreements || r.disagreement),
    );
  }, [register.data, familyFilter, stateFilter, onlyDisagreements]);

  const families = useMemo(
    () => Array.from(new Set((register.data ?? []).map((r) => r.family))).sort(),
    [register.data],
  );

  // The canonical payment lifecycle supplies the proven journal for every
  // collection, so a payment row in this register never lacks the journal the
  // ledger already holds.
  const lifecycle = usePaymentLifecycle({
    branchId: scope.branchId,
    from: scope.from,
    to: scope.to,
  });
  const journalByPayment = useMemo(() => {
    const map = new Map<string, string>();
    for (const l of lifecycle.data ?? []) {
      if (l.journalNumber) map.set(l.paymentId, l.journalNumber);
    }
    return map;
  }, [lifecycle.data]);

  const days = useMemo(() => groupByDay(rows), [rows]);
  const totals = useMemo(() => summariseLifecycle(rows), [rows]);

  const lead: SummaryFigure = {
    id: "recorded",
    label: "Recorded",
    value: money(totals.recorded),
    hint: `${totals.count} transactions`,
  };
  const figures: SummaryFigure[] = [
    { id: "posted", label: "In the ledger", value: money(totals.posted) },
    { id: "awaiting", label: "Awaiting posting", value: money(totals.awaiting) },
    {
      id: "stuck",
      label: "Needs attention",
      value: money(totals.stuck),
      hint: totals.stuckCount ? `${totals.stuckCount} held or failed` : "Nothing held",
      tone: totals.stuckCount ? "destructive" : "default",
    },
    {
      id: "disagreements",
      label: "Records disagreeing",
      value: String(totals.disagreements),
      hint: totals.disagreements
        ? "The operation and the ledger hold different positions"
        : "Both records agree",
      tone: totals.disagreements ? "destructive" : "default",
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Finance"
        title="Transaction register"
        description="One lifecycle per transaction, shared by every module. What the operation says and what the money says are shown side by side, day by day."
      />

      <SummaryStrip lead={lead} figures={figures} />

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Label className="text-xs text-muted-foreground">Source</Label>
          <Select value={familyFilter} onValueChange={setFamilyFilter}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Everything</SelectItem>
              {families.map((m) => (
                <SelectItem key={m} value={m}>
                  {label(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Money position</Label>
          <Select value={stateFilter} onValueChange={setStateFilter}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any</SelectItem>
              <SelectItem value="not-applicable">No accounting effect</SelectItem>
              <SelectItem value="pending">Not due yet</SelectItem>
              <SelectItem value="eligible">Awaiting posting</SelectItem>
              <SelectItem value="posted">In the ledger</SelectItem>
              <SelectItem value="blocked">Held</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="reversed">Reversed</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Agreement</Label>
          <Select
            value={onlyDisagreements ? "conflict" : "all"}
            onValueChange={(v) => setOnlyDisagreements(v === "conflict")}
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All transactions</SelectItem>
              <SelectItem value="conflict">Only records that disagree</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">
          {shortDate(scope.from)} – {shortDate(scope.to)}
        </p>
      </div>

      <FinanceQueryState
        isLoading={register.isLoading}
        error={register.error}
        isEmpty={rows.length === 0}
        empty={
          <FinanceEmpty
            title="Nothing recorded for this period"
            description="Transactions appear here as rooms, folios, sales, orders and supplier documents are worked on."
          />
        }
      >
        <div className="space-y-8">
          {days.map((day) => (
            <section key={day.date} className="space-y-3">
              <header className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold">{shortDate(day.date)}</h2>
                <p className="text-xs text-muted-foreground">
                  {day.rows.length} transactions · {money(day.total)} recorded ·{" "}
                  {money(day.posted)} in the ledger
                </p>
              </header>

              <p className="text-xs text-muted-foreground">
                {day.byFamily.map((m) => `${label(m.family)} ${money(m.total)}`).join("  ·  ")}
              </p>

              <DataTable
                head={["Reference", "Source", "Operation", "Money", "Amount", "Next step"]}
                unit="transactions"
              >
                {day.rows.map((r) => (
                  <tr key={`${r.family}:${r.sourceId}`}>
                    <td className="py-2 pr-4 font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        {r.reference ?? "—"}
                        {r.disagreement ? (
                          <AlertTriangle
                            className="h-3.5 w-3.5 text-destructive"
                            aria-label={`The operation records ${financialStatusLabel(
                              r.canonicalFinancialState,
                            )} while the ledger records ${financialStatusLabel(r.financialStatus)}`}
                          />
                        ) : null}
                      </span>
                      {r.journalNumber ?? journalByPayment.get(r.sourceId) ? (
                        <span className="block text-xs text-muted-foreground">
                          {r.journalNumber ?? journalByPayment.get(r.sourceId)}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4">{label(r.family)}</td>
                    <td className="py-2 pr-4">
                      <FinStatus value={r.operationalState ?? "—"} />
                    </td>
                    <td className="py-2 pr-4">
                      <FinStatus value={r.financialStatus} />
                    </td>
                    <td className="py-2 pr-4 tabular-nums">{money(r.amount)}</td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">
                      {r.blocker ?? r.lastError ?? r.nextAction ?? "—"}
                    </td>
                  </tr>
                ))}
              </DataTable>
            </section>
          ))}
        </div>
      </FinanceQueryState>
    </div>
  );
}

type Day = {
  date: string;
  rows: LifecycleRow[];
  total: number;
  posted: number;
  byFamily: Array<{ family: string; total: number }>;
};

/** Newest day first; a transaction belongs to the day it happened, not today. */
function groupByDay(rows: LifecycleRow[]): Day[] {
  const buckets = new Map<string, LifecycleRow[]>();
  for (const r of rows) {
    const key =
      r.accountingDate ?? ((r.occurredAt ?? r.updatedAt ?? "").slice(0, 10) || "undated");
    const list = buckets.get(key) ?? [];
    list.push(r);
    buckets.set(key, list);
  }
  return Array.from(buckets.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, list]) => {
      const perFamily = new Map<string, number>();
      for (const r of list) perFamily.set(r.family, (perFamily.get(r.family) ?? 0) + r.amount);
      return {
        date,
        rows: list.sort((a, b) => ((a.occurredAt ?? "") < (b.occurredAt ?? "") ? 1 : -1)),
        total: list.reduce((a, r) => a + r.amount, 0),
        posted: list
          .filter((r) => r.financialStatus === "posted")
          .reduce((a, r) => a + r.amount, 0),
        byFamily: Array.from(perFamily.entries())
          .map(([family, total]) => ({ family, total }))
          .sort((a, b) => b.total - a.total),
      };
    });
}
