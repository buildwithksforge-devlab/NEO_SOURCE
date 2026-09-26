/**
 * Revenue variance panel.
 *
 * Operational revenue, posted Finance revenue and the difference — per module,
 * from the canonical `neo_revenue_reconciliation` service. Screens never sum
 * their own revenue here, so a gap between POS and Finance is always named and
 * explained rather than shown as two disagreeing numbers.
 */
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { SectionCard } from "@/components/common/DataDisplay";
import { Skeleton } from "@/components/ui/skeleton";
import { useTenant } from "@/lib/tenant";
import { formatMoney } from "@/lib/inventory";
import { useRevenueReconciliation } from "@/lib/finance-posting";
import type { FactScope } from "@/lib/facts";

const LABELS: Record<string, string> = {
  pos: "POS",
  folio: "Folios",
  events: "Events",
  laundry: "Laundry",
  delivery: "Delivery",
  procurement: "Procurement",
  other: "Other",
};

export function RevenueVariancePanel({
  scope,
  title = "Revenue reconciliation",
  description = "Operational revenue against revenue posted to Finance, by module, for the selected property and period. Any difference is explained.",
}: {
  scope: FactScope;
  title?: string;
  description?: string;
}) {
  const { tenant } = useTenant();
  const symbol = `${tenant.regional.currencySymbol} `;
  const q = useRevenueReconciliation(scope);
  const rows = q.data ?? [];

  const totals = rows.reduce(
    (acc, r) => ({
      operational: acc.operational + r.operational_amount,
      posted: acc.posted + r.posted_amount,
      variance: acc.variance + r.variance,
    }),
    { operational: 0, posted: 0, variance: 0 },
  );

  return (
    <SectionCard title={title} description={description}>
      {q.isLoading ? (
        <Skeleton className="h-32 w-full rounded-xl" aria-label="Loading revenue reconciliation" />
      ) : q.error ? (
        <p className="flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="size-4" /> Revenue reconciliation could not be read, so no figures
          are shown.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No revenue was recorded or posted for this property and period.
        </p>
      ) : (
        <>
          <div
            className={`mb-3 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
              Math.abs(totals.variance) < 0.01
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
                : "border-destructive/40 bg-destructive/10 text-destructive"
            }`}
          >
            {Math.abs(totals.variance) < 0.01 ? (
              <>
                <CheckCircle2 className="size-4" /> Operations and Finance agree at{" "}
                {formatMoney(totals.posted, symbol)} for this property and period.
              </>
            ) : (
              <>
                <AlertTriangle className="size-4" /> Operations show{" "}
                {formatMoney(totals.operational, symbol)} and Finance shows{" "}
                {formatMoney(totals.posted, symbol)} — a difference of{" "}
                {formatMoney(totals.variance, symbol)}, itemised by module below.
              </>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-[0.68rem] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3">Module</th>
                  <th className="py-2 pr-3 text-right">Operations</th>
                  <th className="py-2 pr-3 text-right">Posted to Finance</th>
                  <th className="py-2 pr-3 text-right">Difference</th>
                  <th className="py-2 pr-3">Why</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.module}>
                    <td className="py-2 pr-3 font-medium">{LABELS[r.module] ?? r.module}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatMoney(r.operational_amount, symbol)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatMoney(r.posted_amount, symbol)}
                    </td>
                    <td
                      className={`py-2 pr-3 text-right tabular-nums ${
                        Math.abs(r.variance) < 0.01 ? "" : "font-semibold text-destructive"
                      }`}
                    >
                      {formatMoney(r.variance, symbol)}
                    </td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">{r.explanation}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="py-2 pr-3">All modules</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatMoney(totals.operational, symbol)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatMoney(totals.posted, symbol)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatMoney(totals.variance, symbol)}
                  </td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </SectionCard>
  );
}
