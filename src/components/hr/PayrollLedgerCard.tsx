/**
 * Payroll ledger.
 *
 * One line per employee per pay period: gross, allowances, deductions, net and
 * where that period stands with the finance books. Every figure comes from the
 * same guarded routine that posts payroll, so the ledger cannot drift from what
 * was written to the books.
 */

import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { BookText, FileText } from "lucide-react";
import { SectionCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { QueryState } from "@/components/common/StateSystem";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoneyExact } from "@/lib/money-format";
import { usePayrollLedger, type PayrollComputationRow } from "@/lib/hr-payroll";
import { shortDate, titleCase, type Row } from "@/lib/hr";
import { Button } from "@/components/ui/button";
import { SalarySlipDialog } from "@/components/hr/SalarySlipDialog";

type Tone = "default" | "info" | "success" | "warning" | "destructive";

type LedgerLine = {
  key: string;
  period: Row;
  periodId: string;
  periodName: string;
  periodRange: string;
  employee: PayrollComputationRow;
  statusLabel: string;
  statusTone: Tone;
  posted: boolean;
};

function periodStatus(period: Row): { label: string; tone: Tone; posted: boolean } {
  if (period["posted_journal_id"]) {
    return { label: `Posted ${shortDate(period["posted_at"])}`, tone: "success", posted: true };
  }
  const status = String(period["status"] ?? "");
  if (status === "approved" || status === "locked") {
    return { label: "Ready to post", tone: "warning", posted: false };
  }
  return { label: titleCase(status) || "Draft", tone: "default", posted: false };
}

export function PayrollLedgerCard({ periods }: { periods: Row[] }) {
  const recent = useMemo(() => periods.slice(0, 12), [periods]);
  const ledger = usePayrollLedger(recent);
  const [search, setSearch] = useState("");
  const [periodFilter, setPeriodFilter] = useState("all");
  const [postedFilter, setPostedFilter] = useState("all");
  const [slip, setSlip] = useState<LedgerLine | null>(null);

  const lines = useMemo<LedgerLine[]>(() => {
    const out: LedgerLine[] = [];
    for (const { period, rows } of ledger.byPeriod) {
      const id = String(period["id"]);
      const state = periodStatus(period);
      for (const employee of rows) {
        out.push({
          key: `${id}:${employee.employee_id}`,
          period,
          periodId: id,
          periodName: String(period["name"] ?? "Period"),
          periodRange: `${shortDate(period["period_start"])} → ${shortDate(period["period_end"])}`,
          employee,
          statusLabel: state.label,
          statusTone: state.tone,
          posted: state.posted,
        });
      }
    }
    return out;
  }, [ledger.byPeriod]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return lines.filter((l) => {
      if (periodFilter !== "all" && l.periodId !== periodFilter) return false;
      if (postedFilter === "posted" && !l.posted) return false;
      if (postedFilter === "unposted" && l.posted) return false;
      if (needle && !l.employee.full_name.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [lines, search, periodFilter, postedFilter]);

  const currency = filtered[0]?.employee.currency ?? "KES";
  const sum = (pick: (r: PayrollComputationRow) => number) =>
    filtered.reduce((total, l) => total + pick(l.employee), 0);

  return (
    <SectionCard
      title="Payroll ledger"
      description="Every employee's pay period with its gross, allowances, deductions, net and posting status."
      icon={BookText}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search employee"
            className="h-9 w-48"
          />
          <Select value={periodFilter} onValueChange={setPeriodFilter}>
            <SelectTrigger className="h-9 w-48">
              <SelectValue placeholder="All periods" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All periods</SelectItem>
              {recent.map((p) => (
                <SelectItem key={String(p["id"])} value={String(p["id"])}>
                  {String(p["name"] ?? "Period")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={postedFilter} onValueChange={setPostedFilter}>
            <SelectTrigger className="h-9 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Posted and not</SelectItem>
              <SelectItem value="posted">Posted only</SelectItem>
              <SelectItem value="unposted">Not yet posted</SelectItem>
            </SelectContent>
          </Select>
        </div>
      }
    >
      <QueryState
        isLoading={ledger.isLoading}
        error={ledger.error}
        isEmpty={filtered.length === 0}
        empty="No payroll lines for this selection."
      >
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            {filtered.length} lines · gross {formatMoneyExact(sum((r) => r.gross_pay), currency)} ·
            deductions {formatMoneyExact(sum((r) => r.deductions), currency)} · net{" "}
            {formatMoneyExact(sum((r) => r.net_pay), currency)}
          </p>
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Pay period</TableHead>
                  <TableHead className="text-right">Gross</TableHead>
                  <TableHead className="text-right">Allowances</TableHead>
                  <TableHead className="text-right">Deductions</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                  <TableHead>Posting</TableHead>
                  <TableHead className="text-right">Slip</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((l) => (
                  <TableRow key={l.key}>
                    <TableCell>
                      <Link
                        to="/hr/employees/$id"
                        params={{ id: l.employee.employee_id }}
                        className="font-medium hover:underline"
                      >
                        {l.employee.full_name}
                      </Link>
                      {l.employee.missing_compensation ? (
                        <div className="text-xs text-warning">No pay record on profile</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">
                      {l.periodName}
                      <div className="text-xs text-muted-foreground">{l.periodRange}</div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoneyExact(l.employee.gross_pay, l.employee.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoneyExact(l.employee.allowances, l.employee.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoneyExact(l.employee.deductions, l.employee.currency)}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMoneyExact(l.employee.net_pay, l.employee.currency)}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={l.statusTone}>{l.statusLabel}</StatusPill>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => setSlip(l)}>
                        <FileText className="mr-2 size-4" /> Salary slip
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
          <SalarySlipDialog
            period={slip?.period ?? null}
            employee={slip?.employee ?? null}
            onOpenChange={(open) => (open ? null : setSlip(null))}
          />
        </>
      </QueryState>
    </SectionCard>
  );
}
