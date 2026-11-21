/**
 * Payroll in the cashbook.
 *
 * Wages are one of the largest movements out of the bank, so the cashbook shows
 * each pay period that ends inside the selected dates, what it costs and
 * whether it has reached the books yet. Every figure is produced by the same
 * guarded payroll routine that posts the period, so this panel and the finance
 * books can never disagree, and an unposted period is shown as money still to
 * leave rather than money already gone.
 */
import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { SectionCard } from "@/components/common/DataDisplay";
import { DataTable, FinanceEmpty, FinanceQueryState } from "@/components/finance/FinanceShared";
import { StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { moneyWithCode, shortDate } from "@/lib/finance";
import { usePayrollPeriods } from "@/lib/hr-data";
import { payrollTotals, usePayrollLedger } from "@/lib/hr-payroll";

export function PayrollCashSection({ from, to }: { from: string; to: string }) {
  const periods = usePayrollPeriods();

  const inRange = useMemo(() => {
    const rows = periods.data ?? [];
    return rows
      .filter((p) => {
        const end = String(p["period_end"] ?? "");
        return end !== "" && end >= from && end <= to;
      })
      .slice(0, 12);
  }, [periods.data, from, to]);

  const ledger = usePayrollLedger(inRange);

  const lines = ledger.byPeriod.map(({ period, rows }) => {
    const totals = payrollTotals(rows);
    const posted = Boolean(period["posted_journal_id"]);
    return {
      id: String(period["id"]),
      name: String(period["name"] ?? "Pay period"),
      range: `${shortDate(period["period_start"])} – ${shortDate(period["period_end"])}`,
      employees: totals.employees,
      gross: totals.gross,
      deductions: totals.deductions,
      net: totals.net,
      currency: totals.employees ? totals.currency : null,
      posted,
      postedAt: period["posted_at"] ? shortDate(period["posted_at"]) : null,
      missing: totals.missing,
    };
  });

  const currencies = [...new Set(lines.flatMap((line) => line.currency ? [line.currency] : []))];
  const currency = currencies.length === 1 ? currencies[0] : undefined;
  const netPosted = currency ? lines.filter((l) => l.posted).reduce((s, l) => s + Math.round(l.net * 100), 0) / 100 : 0;
  const netPending = currency ? lines.filter((l) => !l.posted).reduce((s, l) => s + Math.round(l.net * 100), 0) / 100 : 0;

  return (
    <SectionCard
      title="Payroll"
      description={
        periods.error || ledger.error
          ? "Payroll calculations need review; no combined total is shown."
          : periods.isLoading || ledger.isLoading
            ? "Loading payroll calculations before showing totals."
          : lines.length
          ? currency
            ? `Pay periods ending in this range · ${moneyWithCode(netPosted, currency)} net already posted to the books · ${moneyWithCode(netPending, currency)} net not yet posted.`
            : "Pay periods ending in this range. Compare each period in its own currency; no combined currency total is shown."
          : "Pay periods ending in this range, what they cost and whether they have reached the books."
      }
      actions={
        <Button asChild size="sm" variant="outline">
          <Link to="/finance/payroll-journal">Open payroll journal</Link>
        </Button>
      }
    >
      <FinanceQueryState
        isLoading={periods.isLoading || ledger.isLoading}
        error={periods.error ?? ledger.error}
        isEmpty={lines.length === 0}
        empty={
          <FinanceEmpty
            title="No pay periods"
            description="No payroll period ends inside the selected dates."
          />
        }
      >
        {(
          <DataTable
            head={["Pay period", "Staff", "Gross", "Deductions", "Net pay", "Posting"]}
            unit="periods"
          >
            {lines.map((l) => (
              <tr key={l.id} className="align-top">
                <td className="py-2 pr-4">
                  <div className="font-medium">{l.name}</div>
                  <div className="text-xs text-muted-foreground">{l.range}</div>
                </td>
                <td className="py-2 pr-4 tabular-nums">
                  {l.employees}
                  {l.missing ? (
                    <div className="text-xs text-destructive">{l.missing} without a pay record</div>
                  ) : null}
                </td>
                <td className="py-2 pr-4 tabular-nums">{l.currency ? moneyWithCode(l.gross, l.currency) : "—"}</td>
                <td className="py-2 pr-4 tabular-nums">{l.currency ? moneyWithCode(l.deductions, l.currency) : "—"}</td>
                <td className="py-2 pr-4 font-medium tabular-nums">{l.currency ? moneyWithCode(l.net, l.currency) : "—"}</td>
                <td className="py-2 pr-4">
                  <StatusPill tone={l.posted ? "success" : "warning"}>
                    {l.posted ? `Posted${l.postedAt ? ` ${l.postedAt}` : ""}` : "Not posted"}
                  </StatusPill>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </FinanceQueryState>
    </SectionCard>
  );
}
