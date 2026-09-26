/**
 * Export of the reconciled canonical facts.
 *
 * The file contains exactly what Dashboard, Analytics and Finance render for
 * the selected property and period: the shared fact list, the stream-level
 * reconciliation, and the provenance (source RPCs, period, timezone, currency,
 * last reconciliation). Nothing is recomputed here — an unknown value is
 * exported as an empty cell, never as a zero.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  FACTS,
  factCurrency,
  factGeneratedAt,
  factTimezone,
  factValue,
  type FactPayload,
  type FactScope,
  type ReconciliationRow,
} from "@/lib/facts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const rpc = (fn: string, args: Record<string, unknown>) =>
  (supabase as any).rpc(fn, args) as Promise<{ data: any; error: { message: string } | null }>;

export type ReconciliationMeta = {
  authorised: boolean;
  sources: string[];
  timezone: string | null;
  currency: string | null;
  receipts_posted: number;
  receipts_failed: number;
  receipts_skipped: number;
  last_posted_at: string | null;
  last_reconciled_at: string | null;
  last_failure_at: string | null;
  generated_at: string | null;
};

/** Data-source status shown next to every shared fact surface. */
export function useReconciliationMeta(scope: FactScope, enabled = true) {
  return useQuery({
    queryKey: ["neo-facts", "meta", scope.branchId, scope.from, scope.to],
    enabled,
    refetchInterval: 60_000,
    queryFn: async (): Promise<ReconciliationMeta> => {
      const { data, error } = await rpc("neo_reconciliation_meta", {
        _branch: scope.branchId,
        _from: scope.from,
        _to: scope.to,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as ReconciliationMeta;
    },
  });
}

const cell = (value: unknown) => {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const FACT_EXPORT_COLUMNS = [
  "Section",
  "Item",
  "Value",
  "Unit",
  "Eligibility rule",
] as const;

export function factExportCsv(input: {
  facts: FactPayload | undefined;
  paths: string[];
  reconciliation: ReconciliationRow[];
  meta?: ReconciliationMeta | undefined;
  scope: FactScope;
  scopeLabel: string;
}): string {
  const currency = factCurrency(input.facts);
  const moneyAllowed = input.facts?.["monetary_authorised"] === true;
  const rows: (string | number)[][] = [];

  const provenance: [string, unknown][] = [
    ["Property scope", input.scopeLabel],
    ["Period from", input.scope.from ?? ""],
    ["Period to", input.scope.to ?? ""],
    ["Timezone", factTimezone(input.facts) || input.meta?.timezone || ""],
    ["Currency", currency || input.meta?.currency || ""],
    ["Facts generated at", factGeneratedAt(input.facts) ?? ""],
    ["Last reconciliation", input.meta?.last_reconciled_at ?? ""],
    ["Last posting", input.meta?.last_posted_at ?? ""],
    ["Receipts posted", input.meta?.receipts_posted ?? ""],
    ["Receipts skipped", input.meta?.receipts_skipped ?? ""],
    ["Receipts failed", input.meta?.receipts_failed ?? ""],
    ["Sources", (input.meta?.sources ?? ["neo_facts", "neo_fact_reconciliation"]).join(" | ")],
  ];
  for (const [k, v] of provenance) rows.push(["Provenance", k, v as string, "", ""]);

  for (const path of input.paths) {
    const def = FACTS[path];
    if (!def) continue;
    if (def.kind === "money" && !moneyAllowed) continue;
    const value = factValue(input.facts, path);
    rows.push([
      "Canonical fact",
      def.label,
      value === null ? "" : value,
      def.kind === "money" ? currency : def.kind,
      def.eligibility,
    ]);
  }

  for (const r of input.reconciliation) {
    for (const [label, value] of [
      ["Operational eligible", r.operational_eligible],
      ["Posted", r.posted],
      ["Reversals", r.reversals],
      ["Net recognised", r.net_recognised],
      ["Collected", r.collected],
      ["Outstanding receivable", r.outstanding_receivable],
      ["Unmatched records", r.unmatched_records],
    ] as [string, number][]) {
      rows.push([
        "Reconciliation",
        `${r.stream} — ${label}`,
        value === null || value === undefined ? "" : value,
        label === "Unmatched records" ? "count" : currency,
        "",
      ]);
    }
  }

  return [FACT_EXPORT_COLUMNS.join(","), ...rows.map((r) => r.map(cell).join(","))].join("\n");
}

export const factExportFilename = (scope: FactScope) =>
  `neo-facts-${scope.from ?? "start"}-to-${scope.to ?? "today"}.csv`;

/** Browser download of a generated text file. */
export function downloadTextFile(filename: string, content: string, mime = "text/csv") {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
