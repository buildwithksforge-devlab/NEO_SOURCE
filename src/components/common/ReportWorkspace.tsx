/**
 * Shared presentation for the NEØ reporting standard.
 *
 * Every report renders the same four elements through these primitives:
 * KPIs with an honest period comparison, an exception list that links to the
 * offending source record, a drill-down hint, and an export whose totals are
 * reconciled against what is on screen before the download is offered.
 */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TONE_BORDER, TONE_TINT, type Tone } from "@/lib/tone";
import {
  comparisonLabel,
  reconcileTotals,
  toReportCsv,
  type Comparison,
  type ReportColumn,
  type ReportException,
  type ReportPeriod,
} from "@/lib/reporting-standard";

export type ReportKpi = {
  id: string;
  label: string;
  /** Rendered figure. Pass "Not available" when the source cannot be computed. */
  value: ReactNode;
  comparison?: Comparison | undefined;
  unit?: string;
  hint?: string;
  tone?: Tone;
};

function DirectionIcon({ direction }: { direction: Comparison["direction"] }) {
  const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : ArrowRight;
  return <Icon className="size-3.5 shrink-0" aria-hidden="true" />;
}

export function ReportKpiGrid({ kpis, className }: { kpis: ReportKpi[]; className?: string }) {
  return (
    <div className={cn("grid gap-3 sm:grid-cols-2 xl:grid-cols-4", className)}>
      {kpis.map((kpi) => (
        <div key={kpi.id} className="min-w-0 rounded-xl border border-border bg-card p-4">
          <p className="neo-line-1 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {kpi.label}
          </p>
          <p className="neo-atomic mt-1 text-xl font-semibold text-foreground">{kpi.value}</p>
          {kpi.comparison ? (
            <p className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
              <DirectionIcon direction={kpi.comparison.direction} />
              <span className="truncate">{comparisonLabel(kpi.comparison, kpi.unit ?? "")}</span>
            </p>
          ) : null}
          {kpi.hint ? <p className="mt-0.5 text-xs text-muted-foreground">{kpi.hint}</p> : null}
        </div>
      ))}
    </div>
  );
}

/** States the comparison window explicitly so nobody has to infer it. */
export function ReportPeriodNote({
  period,
  previous,
}: {
  period: ReportPeriod;
  previous: ReportPeriod | null;
}) {
  return (
    <p className="text-xs text-muted-foreground">
      {period.from} → {period.to}
      {previous ? ` · compared with ${previous.from} → ${previous.to}` : " · no comparable earlier period"}
    </p>
  );
}

const SEVERITY_TONE: Record<ReportException["severity"], Tone> = {
  high: "destructive",
  medium: "warning",
  low: "info",
};

export function ReportExceptions({
  exceptions,
  onOpenRecord,
  emptyLabel = "No exceptions in this period.",
}: {
  exceptions: ReportException[];
  onOpenRecord?: (recordId: string) => void;
  emptyLabel?: string;
}) {
  if (exceptions.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <ul className="space-y-2" data-testid="report-exceptions">
      {exceptions.map((exception) => {
        const tone = SEVERITY_TONE[exception.severity];
        return (
          <li
            key={exception.id}
            className={cn(
              "flex min-w-0 flex-wrap items-start justify-between gap-3 rounded-lg border p-3",
              TONE_TINT[tone],
              TONE_BORDER[tone],
            )}
          >
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{exception.title}</span>
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{exception.detail}</p>
            </div>
            {exception.recordId && onOpenRecord ? (
              <Button size="sm" variant="outline" onClick={() => onOpenRecord(exception.recordId!)}>
                Open record
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Export button that refuses to hand over a file whose totals disagree with the
 * screen. A mismatch is shown, not swallowed.
 */
export function ReportExportButton<T>({
  rows,
  columns,
  onScreenTotals,
  filename,
  label = "Export CSV",
}: {
  rows: readonly T[];
  columns: readonly ReportColumn<T>[];
  onScreenTotals: Record<string, number>;
  filename: string;
  label?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const reconciliations = useMemo(
    () => reconcileTotals(rows, columns, onScreenTotals),
    [rows, columns, onScreenTotals],
  );
  const mismatch = reconciliations.find((r) => !r.reconciled);

  function download() {
    if (mismatch) {
      setError(
        `Export withheld: the ${mismatch.column} total (${mismatch.exported}) does not match the figure on screen (${mismatch.onScreen}).`,
      );
      return;
    }
    setError(null);
    const csv = toReportCsv(rows, columns);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <Button variant="outline" onClick={download} disabled={rows.length === 0}>
        <Download className="mr-2 size-4" aria-hidden="true" /> {label}
      </Button>
      {error ? (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="report-export-reconciled">
          Totals reconcile with the figures shown above.
        </p>
      )}
    </div>
  );
}
