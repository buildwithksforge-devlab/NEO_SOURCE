/**
 * Reconciliation scoreboard.
 *
 * One shared panel used by the Dashboard, Analytics and Finance so the three
 * screens can never disagree. Lifecycle counts come from
 * `neo_reconciliation_status`; the blocked and failed counts come from the
 * single authoritative exception register (`neo_finance_exception_register`),
 * the same dataset the Posting & Reconciliation screen drills into. A tile
 * reading "16 blocked" therefore always opens exactly those sixteen records.
 */
import { AlertTriangle } from "lucide-react";
import { SectionCard } from "@/components/common/DataDisplay";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useFinanceExceptions,
  useReconciliationStatus,
  type ReconciliationStatusRow,
} from "@/lib/finance-posting";
import type { FactScope } from "@/lib/facts";
import { PermittedLink } from "@/components/common/PermittedLink";

const LABELS: Record<string, string> = {
  pos: "POS",
  folio: "Folios",
  events: "Events",
  laundry: "Laundry",
  delivery: "Delivery",
  procurement: "Procurement",
  "inventory-receipt": "Inventory receipts",
  "supplier-invoice": "Supplier invoices",
  "supplier-payment": "Supplier payments",
  other: "Other",
};

/** Columns whose counts come from the lifecycle status view. */
const COLUMNS: { key: keyof ReconciliationStatusRow; label: string; hint: string }[] = [
  { key: "eligible", label: "Eligible", hint: "Finalised records that should reach Finance" },
  { key: "blocked", label: "Blocked", hint: "Held back by an eligibility rule" },
  { key: "posted", label: "Posted", hint: "Receipts that produced a journal" },
  { key: "skipped", label: "Skipped", hint: "Refused because the record was not eligible" },
  { key: "failed", label: "Failed", hint: "Attempts that errored and can be retried" },
  { key: "duplicate_prevented", label: "Duplicates prevented", hint: "Replays refused a second journal" },
  { key: "reversed", label: "Reversed", hint: "Postings undone by a linked reversal" },
];

/** These two never come from the lifecycle view — the exception register owns them. */
const EXCEPTION_COLUMNS = new Set<string>(["blocked", "failed"]);

export function ReconciliationStatusPanel({
  scope,
  title = "Reconciliation status",
  description = "Operational records against their Finance postings, by module, for the selected property and period.",
  compact = false,
}: {
  scope: FactScope;
  title?: string;
  description?: string;
  compact?: boolean;
}) {
  const status = useReconciliationStatus(scope);
  const exceptions = useFinanceExceptions(scope);
  const statusRows = status.data ?? [];
  const exceptionRows = exceptions.data ?? [];

  // Exception counts per module, from the one authoritative dataset.
  const exceptionCounts = exceptionRows.reduce<Record<string, { blocked: number; failed: number }>>(
    (acc, r) => {
      const bucket = (acc[r.module] ??= { blocked: 0, failed: 0 });
      if (r.kind === "failed") bucket.failed += 1;
      else bucket.blocked += 1;
      return acc;
    },
    {},
  );

  // A module carrying exceptions must appear even when the lifecycle view has
  // no row for it — otherwise the totals would silently drop records.
  const modules = [
    ...statusRows.map((r) => r.module),
    ...Object.keys(exceptionCounts).filter((m) => !statusRows.some((r) => r.module === m)),
  ];

  const cellValue = (module: string, key: string): number => {
    if (key === "blocked") return exceptionCounts[module]?.blocked ?? 0;
    if (key === "failed") return exceptionCounts[module]?.failed ?? 0;
    const row = statusRows.find((r) => r.module === module);
    return Number((row?.[key as keyof ReconciliationStatusRow] as number) ?? 0);
  };

  const totals = Object.fromEntries(
    COLUMNS.map((c) => [c.key, modules.reduce((sum, m) => sum + cellValue(m, String(c.key)), 0)]),
  ) as Record<string, number>;

  const rows = modules;


  return (
    <SectionCard
      title={title}
      description={description}
      actions={
        compact ? (
          <PermittedLink
            to="/finance/posting"
            hideWhenDenied
            className="text-xs text-primary underline-offset-4 hover:underline"
          >
            Open posting queue
          </PermittedLink>
        ) : undefined
      }
    >
      {status.isLoading || exceptions.isLoading ? (
        <Skeleton className="h-32 w-full rounded-xl" aria-label="Loading reconciliation status" />
      ) : status.error || exceptions.error ? (
        <p className="flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="size-4" /> Reconciliation status could not be read, so no counts are
          shown.
        </p>

      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No operational record in this period and property is subject to a Finance posting rule.
        </p>
      ) : (
        <>
          {(totals["failed"] ?? 0) + (totals["skipped"] ?? 0) + (totals["blocked"] ?? 0) > 0 ? (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="size-4" />
              <span>
                {totals["failed"] ?? 0} failed, {totals["skipped"] ?? 0} skipped and{" "}
                {totals["blocked"] ?? 0} blocked

                postings for this property and period. These are raised in your notifications inbox
                as reconciliation commitments until they clear.
              </span>
              <PermittedLink
                to="/finance/posting"
                hideWhenDenied
                className="underline underline-offset-4"
              >
                Resolve in the posting queue
              </PermittedLink>
            </div>
          ) : null}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-[0.68rem] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-2 pr-3">Module</th>
                {COLUMNS.map((c) => (
                  <th key={c.key} className="py-2 pr-3 text-right" title={c.hint}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((m) => (
                <tr key={m}>
                  <td className="py-2 pr-3 font-medium">{LABELS[m] ?? m}</td>
                  {COLUMNS.map((c) => {
                    const key = String(c.key);
                    const value = cellValue(m, key);
                    return (
                      <td key={key} className="py-2 pr-3 text-right tabular-nums">
                        {EXCEPTION_COLUMNS.has(key) && value > 0 ? (
                          <PermittedLink
                            to="/finance/posting"
                            search={{ kind: key, module: m }}
                            className="text-primary underline-offset-4 hover:underline"
                          >
                            {value}
                          </PermittedLink>
                        ) : (
                          value
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}

              <tr className="font-semibold">
                <td className="py-2 pr-3">All modules</td>
                {COLUMNS.map((c) => (
                  <td key={c.key} className="py-2 pr-3 text-right tabular-nums">
                    {totals[c.key]}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        </>
      )}

    </SectionCard>
  );
}
