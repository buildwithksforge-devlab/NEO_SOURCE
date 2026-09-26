/**
 * Finance exception register.
 *
 * One authoritative dataset (`neo_finance_exception_register`) behind every
 * failed/blocked counter in Finance. A tile that reads "15 blocked" drills
 * into exactly these fifteen rows, each carrying the reason, source, amount,
 * age, property, responsible function, the action that clears it, the last
 * attempt and the underlying error where there is one.
 */
import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { DataTable, FinanceEmpty, FinanceQueryState } from "@/components/finance/FinanceShared";
import { type FinanceExceptionRow, useFinanceExceptions } from "@/lib/finance-posting";
import type { FactScope } from "@/lib/facts";

const money = (v: number, currency: string) =>
  `${currency} ${new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 }).format(v)}`;

const ageLabel = (days: number) =>
  days <= 0 ? "Today" : days === 1 ? "1 day" : `${days} days`;

export function ExceptionRegister({
  scope,
  onRetry,
  retrying = false,
  initialKind = "all",
  moduleFilter = "all",
}: {
  scope: FactScope;
  onRetry?: (row: FinanceExceptionRow) => void;
  retrying?: boolean;
  /** Preselected when a Finance counter drilled in on blocked or failed. */
  initialKind?: string;
  /** Preselected module when a counter drilled in from one module's cell. */
  moduleFilter?: string;
}) {
  const exceptions = useFinanceExceptions(scope);
  const [kind, setKind] = useState(initialKind);
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const all = exceptions.data ?? [];
    const term = search.trim().toLowerCase();
    return all.filter(
      (r) =>
        (kind === "all" || r.kind === kind) &&
        (moduleFilter === "all" || r.module === moduleFilter) &&
        (term === "" ||
          (r.reference ?? "").toLowerCase().includes(term) ||
          r.module.toLowerCase().includes(term) ||
          r.reason.toLowerCase().includes(term)),
    );
  }, [exceptions.data, kind, moduleFilter, search]);


  const blocked = (exceptions.data ?? []).filter((r) => r.kind === "blocked").length;
  const failed = (exceptions.data ?? []).filter((r) => r.kind === "failed").length;

  return (
    <SectionCard
      title="Exception register"
      description={`Every exception Finance is carrying: ${blocked} blocked by a rule, ${failed} failed on posting. Counters elsewhere in Finance read this same list.`}
    >
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="w-44">
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger aria-label="Filter exceptions by kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All exceptions</SelectItem>
              <SelectItem value="blocked">Blocked by a rule</SelectItem>
              <SelectItem value="failed">Failed on posting</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search reference, module or reason"
          aria-label="Search exceptions"
          className="w-full sm:w-72"
        />
        <span className="ml-auto text-sm text-muted-foreground">{rows.length} exception(s)</span>
      </div>

      <FinanceQueryState
        isLoading={exceptions.isLoading}
        error={exceptions.error}
        isEmpty={rows.length === 0}
        empty={
          <FinanceEmpty
            title="No Finance exceptions"
            description="Every operational record in this period is either posted or still moving through its lifecycle."
          />
        }
      >
        <DataTable
          head={[
            "Status",
            "Source",
            "Reference",
            "Amount",
            "Age",
            "Property",
            "Responsible",
            "Reason and action",
            "Last attempt",
            "",
          ]}
        >
          {rows.map((r) => (
            <tr key={`${r.kind}:${r.module}:${r.source_id}`} className="align-top">
              <td className="py-2 pr-4">
                <StatusPill tone={r.kind === "failed" ? "destructive" : "warning"}>
                  {r.kind === "failed" ? "Failed" : "Blocked"}
                </StatusPill>
              </td>
              <td className="py-2 pr-4 capitalize">{r.module}</td>
              <td className="py-2 pr-4 font-mono text-xs">{r.reference ?? r.source_id.slice(0, 8)}</td>
              <td className="py-2 pr-4 tabular-nums">{money(r.amount, r.currency)}</td>
              <td className="py-2 pr-4 text-muted-foreground">{ageLabel(r.age_days)}</td>
              <td className="py-2 pr-4 text-muted-foreground">{r.property ?? "All properties"}</td>
              <td className="py-2 pr-4 text-muted-foreground">{r.responsible}</td>
              <td className="max-w-[38ch] py-2 pr-4">
                <p className="text-foreground">{r.reason}</p>
                <p className="mt-1 flex items-start gap-1 text-xs text-muted-foreground">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                  <span>{r.action}</span>
                </p>
                {r.last_error ? (
                  <p className="mt-1 font-mono text-[11px] text-destructive">{r.last_error}</p>
                ) : null}
              </td>
              <td className="py-2 pr-4 text-muted-foreground">
                {r.last_attempt ? new Date(r.last_attempt).toLocaleString() : "Not attempted"}
                {r.attempts > 0 ? ` · ${r.attempts} attempt(s)` : ""}
              </td>
              <td className="py-2 pr-4 text-right">
                <div className="flex justify-end gap-1">
                  {r.kind === "failed" && onRetry ? (
                    <Button size="sm" variant="outline" disabled={retrying} onClick={() => onRetry(r)}>
                      <RefreshCw className="mr-1 size-3" /> Retry
                    </Button>
                  ) : null}
                  <Button asChild size="sm" variant="ghost">
                    <Link to={r.drill_to}>
                      <ExternalLink className="mr-1 size-3" /> Open
                    </Link>
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </DataTable>
      </FinanceQueryState>
    </SectionCard>
  );
}
