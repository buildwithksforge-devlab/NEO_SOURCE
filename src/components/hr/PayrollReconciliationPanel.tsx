/**
 * Payroll reconciliation.
 *
 * Sets what payroll calculated for the period against what actually reached
 * the finance books, line by line. Differences are shown, never corrected
 * silently — the journal and the payroll records both stay as recorded.
 */

import { useMemo } from "react";
import { CheckCircle2, Scale, TriangleAlert } from "lucide-react";
import { SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, QueryState } from "@/components/hr/HrShared";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoneyExact } from "@/lib/money-format";
import { shortDateTime, type Row } from "@/lib/hr";
import { useJournal } from "@/lib/finance-data";
import {
  payrollTotals,
  usePayrollComputation,
  usePayrollPostingSettings,
} from "@/lib/hr-payroll";

const num = (v: unknown) => (v == null ? 0 : Number(v) || 0);
const str = (v: unknown, f = "") => (v == null ? f : String(v));

/** Each payroll bucket, the account it was configured to land in and its side. */
const BUCKETS = [
  { key: "base", label: "Basic pay", account: "salary_expense_account_id", side: "debit" },
  { key: "allowances", label: "Allowances", account: "allowance_expense_account_id", side: "debit" },
  { key: "bonuses", label: "Bonuses and commission", account: "bonus_expense_account_id", side: "debit" },
  {
    key: "reimbursements",
    label: "Reimbursements",
    account: "reimbursement_expense_account_id",
    side: "debit",
  },
  {
    key: "deductions",
    label: "Deductions payable",
    account: "deduction_liability_account_id",
    side: "credit",
  },
  { key: "net", label: "Net pay payable", account: "net_pay_liability_account_id", side: "credit" },
] as const;

export function PayrollReconciliationPanel({ period }: { period: Row | undefined }) {
  const periodId = period ? String(period["id"]) : undefined;
  const journalId = period ? (period["posted_journal_id"] as string | null) : null;
  const computation = usePayrollComputation(periodId);
  const settings = usePayrollPostingSettings(period ? (period["branch_id"] as string | null) : null);
  const journal = useJournal(journalId ?? null);

  const rows = computation.data ?? [];
  const totals = useMemo(() => payrollTotals(rows), [rows]);
  const lines = (journal.data?.["journal_entry_lines"] ?? []) as Row[];

  const comparison = useMemo(() => {
    const cfg = (settings.data ?? {}) as Row;
    return BUCKETS.map((b) => {
      const expected = Number((totals as unknown as Record<string, number>)[b.key] ?? 0);
      const accountId = str(cfg[b.account]);
      const matching = lines.filter((l) => str(l["account_id"]) === accountId);
      const posted = matching.reduce(
        (t, l) => t + num(l[b.side === "debit" ? "debit" : "credit"]),
        0,
      );
      const account = (matching[0]?.["chart_of_accounts"] ?? null) as Row | null;
      return {
        ...b,
        expected,
        posted,
        difference: Math.round((posted - expected) * 100) / 100,
        accountLabel: account
          ? `${str(account["code"])} — ${str(account["name"])}`
          : accountId
            ? "Account configured, nothing posted to it"
            : "No account chosen",
      };
    });
  }, [totals, lines, settings.data]);

  const debits = lines.reduce((t, l) => t + num(l["debit"]), 0);
  const credits = lines.reduce((t, l) => t + num(l["credit"]), 0);
  const outOfBalance = Math.round((debits - credits) * 100) / 100;
  const mismatches = comparison.filter((c) => c.difference !== 0);
  const unmatchedLines = lines.filter(
    (l) =>
      !BUCKETS.some(
        (b) => str((settings.data as Row | null)?.[b.account]) === str(l["account_id"]),
      ),
  );

  return (
    <SectionCard
      title="Reconciliation"
      description="What payroll calculated for this period against what the finance books actually hold."
      icon={Scale}
    >
      {!journalId ? (
        <EmptyState
          title="Not posted yet"
          description="Once this period is posted, its journal is compared here line by line against the payroll figures."
        />
      ) : (
        <QueryState
          isLoading={journal.isLoading || computation.isLoading || settings.isLoading}
          error={journal.error ?? computation.error ?? settings.error}
          isEmpty={lines.length === 0}
          empty={
            <EmptyState
              title="Journal has no lines"
              description="The period records a journal reference, but no lines were read back. Open the journal in Finance to inspect it."
            />
          }
        >
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="Posted debits" value={formatMoneyExact(debits, totals.currency)} />
              <StatCard label="Posted credits" value={formatMoneyExact(credits, totals.currency)} />
              <StatCard
                label="Journal balance"
                value={formatMoneyExact(Math.abs(outOfBalance), totals.currency)}
                tone={outOfBalance === 0 ? "success" : "destructive"}
              />
              <StatCard
                label="Lines out of step"
                value={String(mismatches.length)}
                tone={mismatches.length ? "warning" : "success"}
              />
            </div>

            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              {mismatches.length === 0 && outOfBalance === 0 ? (
                <>
                  <CheckCircle2 className="size-4 text-success" />
                  Every payroll figure matches the posted journal.
                </>
              ) : (
                <>
                  <TriangleAlert className="size-4 text-warning" />
                  Payroll and the books differ. Nothing is adjusted automatically — review the
                  journal in Finance.
                </>
              )}
              {journal.data ? (
                <span className="ml-auto">
                  {str(journal.data["entry_number"] ?? journal.data["reference"], "Journal")} ·
                  posted {shortDateTime(period?.["posted_at"])}
                </span>
              ) : null}
            </p>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Payroll figure</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Calculated</TableHead>
                  <TableHead className="text-right">In the books</TableHead>
                  <TableHead className="text-right">Difference</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {comparison.map((c) => (
                  <TableRow key={c.key}>
                    <TableCell className="font-medium">{c.label}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {c.accountLabel}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoneyExact(c.expected, totals.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoneyExact(c.posted, totals.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c.difference === 0
                        ? formatMoneyExact(0, totals.currency)
                        : formatMoneyExact(c.difference, totals.currency)}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={c.difference === 0 ? "success" : "warning"}>
                        {c.difference === 0 ? "Matched" : "Differs"}
                      </StatusPill>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {unmatchedLines.length ? (
              <div className="rounded-lg border border-dashed border-border/70 bg-muted/40 p-3 text-sm">
                <p className="mb-1 font-medium">
                  {unmatchedLines.length} journal line
                  {unmatchedLines.length === 1 ? "" : "s"} on accounts payroll does not use
                </p>
                <ul className="list-disc space-y-1 pl-6 text-muted-foreground">
                  {unmatchedLines.map((l) => {
                    const a = (l["chart_of_accounts"] ?? null) as Row | null;
                    return (
                      <li key={str(l["id"])}>
                        {a ? `${str(a["code"])} — ${str(a["name"])}` : "Account"} ·{" "}
                        {formatMoneyExact(num(l["debit"]) || num(l["credit"]), totals.currency)}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </div>
        </QueryState>
      )}
    </SectionCard>
  );
}
