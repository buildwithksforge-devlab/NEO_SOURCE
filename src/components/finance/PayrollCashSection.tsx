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
import { money, shortDate } from "@/lib/finance";
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
      posted,
      postedAt: period["posted_at"] ? shortDate(period["posted_at"]) : null,
      missing: totals.missing,
    };
  });

  const netPosted = lines.filter((l) => l.posted).reduce((s, l) => s + l.net, 0);
  const netPending = lines.filter((l) => !l.posted).reduce((s, l) => s + l.net, 0);

  return (
    <SectionCard
      title="Payroll"
      description={
        lines.length
          ? `Pay periods ending in this range · ${money(netPosted)} net already posted to the books · ${money(netPending)} net not yet posted.`
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
                <td className="py-2 pr-4 tabular-nums">{money(l.gross)}</td>
                <td className="py-2 pr-4 tabular-nums">{money(l.deductions)}</td>
                <td className="py-2 pr-4 font-medium tabular-nums">{money(l.net)}</td>
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
