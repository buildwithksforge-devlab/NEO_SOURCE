/**
 * NEØ system-wide reporting standard.
 *
 * Every report in the product answers the same five questions in the same way:
 *
 *  1. WHAT — KPIs computed from canonical records only. A figure that cannot be
 *     computed is reported as "not available", never as zero and never invented.
 *  2. AGAINST WHAT — the immediately preceding period of identical length, so a
 *     number always carries a direction rather than sitting alone.
 *  3. FROM WHERE — every row can be opened at its source record.
 *  4. WHAT IS WRONG — exceptions are listed explicitly instead of being averaged
 *     away inside a headline.
 *  5. DOES IT ADD UP — the export carries a TOTAL row, and that total is
 *     reconciled against the KPI shown on screen before the file is offered.
 *
 * This module is pure: no React, no Supabase, no formatting opinions. It is the
 * arithmetic and the reconciliation contract that every report shares.
 */

export type ReportPeriod = { from: string; to: string };

const DAY = 86_400_000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function utc(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function iso(stamp: number): string {
  const dt = new Date(stamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Whole days covered by an inclusive period. */
export function periodDays(period: ReportPeriod): number {
  if (!ISO.test(period.from) || !ISO.test(period.to)) return 0;
  const span = Math.round((utc(period.to) - utc(period.from)) / DAY) + 1;
  return span > 0 ? span : 0;
}

/**
 * The comparison period is the identical-length window immediately before the
 * selected one. Same length matters: comparing a 7-day week against a 31-day
 * month is the classic way a report lies without stating anything false.
 */
export function previousPeriod(period: ReportPeriod): ReportPeriod | null {
  const days = periodDays(period);
  if (days <= 0) return null;
  const end = utc(period.from) - DAY;
  return { from: iso(end - (days - 1) * DAY), to: iso(end) };
}

export type Comparison = {
  current: number;
  previous: number;
  delta: number;
  /** Null when the previous period is zero — a percentage would be meaningless. */
  percent: number | null;
  direction: "up" | "down" | "flat";
};

export function compare(current: number, previous: number): Comparison {
  const delta = current - previous;
  const percent = previous === 0 ? null : (delta / Math.abs(previous)) * 100;
  return {
    current,
    previous,
    delta,
    percent,
    direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
  };
}

/**
 * Plain-language comparison wording. Reports say what changed, not just by how
 * much, and they say "no comparable activity" rather than showing a fake +100%.
 */
export function comparisonLabel(c: Comparison, unit = ""): string {
  if (c.previous === 0 && c.current === 0) return "No activity in either period";
  if (c.percent === null) return "No comparable activity in the previous period";
  if (c.direction === "flat") return "Unchanged on the previous period";
  const sign = c.direction === "up" ? "+" : "−";
  const suffix = unit ? ` ${unit}` : "";
  return `${sign}${Math.abs(c.percent).toFixed(1)}% (${sign}${Math.abs(c.delta).toLocaleString()}${suffix}) on the previous period`;
}

/* ------------------------------------------------------------------ *
 * Exceptions
 * ------------------------------------------------------------------ */

export type ReportException = {
  id: string;
  /** What is wrong, in operator language. */
  title: string;
  detail: string;
  severity: "high" | "medium" | "low";
  /** Where to go to deal with it, when a source record exists. */
  recordId?: string;
};

export type ExceptionRule<T> = {
  id: string;
  severity: ReportException["severity"];
  /** True when this row is an exception. */
  when: (row: T) => boolean;
  title: (row: T) => string;
  detail: (row: T) => string;
  recordId?: (row: T) => string | undefined;
};

/** Applies the rules in order and returns one exception per matching row. */
export function collectExceptions<T>(rows: readonly T[], rules: readonly ExceptionRule<T>[]): ReportException[] {
  const out: ReportException[] = [];
  rows.forEach((row, index) => {
    for (const rule of rules) {
      if (!rule.when(row)) continue;
      const recordId = rule.recordId?.(row);
      out.push({
        id: `${rule.id}:${recordId ?? index}`,
        title: rule.title(row),
        detail: rule.detail(row),
        severity: rule.severity,
        ...(recordId ? { recordId } : {}),
      });
    }
  });
  const order = { high: 0, medium: 1, low: 2 } as const;
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

/* ------------------------------------------------------------------ *
 * Export + reconciliation
 * ------------------------------------------------------------------ */

export type ReportColumn<T> = {
  key: string;
  header: string;
  value: (row: T) => string | number;
  /** Marks a numeric column that must be summed into the TOTAL row. */
  total?: boolean;
};

export type Reconciliation = {
  column: string;
  onScreen: number;
  exported: number;
  difference: number;
  reconciled: boolean;
};

/**
 * A report export is only trustworthy if its totals equal the figures the
 * operator is looking at. Tolerance is a currency cent, so floating point noise
 * does not raise a false alarm while a genuine mismatch always does.
 */
export function reconcileTotals<T>(
  rows: readonly T[],
  columns: readonly ReportColumn<T>[],
  onScreen: Record<string, number>,
  tolerance = 0.01,
): Reconciliation[] {
  return columns
    .filter((c) => c.total && c.key in onScreen)
    .map((c) => {
      const exported = rows.reduce((sum, row) => sum + Number(c.value(row) || 0), 0);
      const expected = Number(onScreen[c.key] ?? 0);
      const difference = Number((exported - expected).toFixed(6));
      return {
        column: c.key,
        onScreen: expected,
        exported,
        difference,
        reconciled: Math.abs(difference) <= tolerance,
      };
    });
}

function csvCell(value: string | number): string {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

/** CSV with a header row, the rows themselves and a reconciling TOTAL row. */
export function toReportCsv<T>(rows: readonly T[], columns: readonly ReportColumn<T>[]): string {
  const header = columns.map((c) => csvCell(c.header)).join(",");
  const body = rows.map((row) => columns.map((c) => csvCell(c.value(row))).join(","));
  const totals = columns.map((c, index) => {
    if (c.total) {
      return csvCell(rows.reduce((sum, row) => sum + Number(c.value(row) || 0), 0));
    }
    return csvCell(index === 0 ? "TOTAL" : "");
  });
  return [header, ...body, totals.join(",")].join("\n");
}
