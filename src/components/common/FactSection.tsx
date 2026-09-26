/**
 * The shared canonical-fact section rendered identically on the dashboard's
 * companion pages (/analytics, /finance). Every consumer passes the same
 * scope, so the figures match by construction.
 */
import { AlertTriangle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { ErrorState, LoadingState } from "@/components/common/StateSystem";
import { Skeleton } from "@/components/ui/skeleton";
import { FactCard, FactProvenance } from "@/components/common/FactCard";
import { DataSourceStatus } from "@/components/common/DataSourceStatus";
import { FactExportButton } from "@/components/common/FactExportButton";
import {
  FACTS,
  factCurrency,
  factGeneratedAt,
  factPeriodLabel,
  factTimezone,
  factValue,
  factsAuthorised,
  factsMonetaryAuthorised,
  useFactReconciliation,
  useFacts,
  useUnmatchedFacts,
  type FactScope,
} from "@/lib/facts";

export function FactSection({
  title,
  description,
  paths,
  scope,
  scopeLabel,
  enabled = true,
}: {
  title: string;
  description: string;
  paths: string[];
  scope: FactScope;
  scopeLabel: string;
  enabled?: boolean;
}) {
  const facts = useFacts(scope, enabled);
  const reconciliation = useFactReconciliation(scope, enabled);
  const currency = factCurrency(facts.data);
  // Authorisation is a period-domain answer; a broken Front Office or
  // operational read must not be mistaken for an authorisation refusal.
  const authorised = !facts.domains.period.isSuccess || factsAuthorised(facts.data);
  const moneyAllowed = factsMonetaryAuthorised(facts.data);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
          <FactProvenance
            scopeLabel={scopeLabel}
            period={factPeriodLabel(facts.data)}
            timezone={factTimezone(facts.data)}
            currency={currency}
            generatedAt={factGeneratedAt(facts.data)}
          />
        </div>
        <FactExportButton scope={scope} scopeLabel={scopeLabel} paths={paths} enabled={enabled} title={title} />
      </div>


      <DataSourceStatus
        scope={scope}
        query={facts}
        facts={facts}
        reconciliation={reconciliation}
        enabled={enabled}
      />

      {!facts.domains.period.isLoading && !authorised ? (
        <Card className="surface-panel">
          <CardContent className="py-6 text-sm text-muted-foreground">
            Your account is not authorised to see these figures. Ask an administrator for the
            relevant finance, analytics or reporting permission.
          </CardContent>
        </Card>
      ) : (
        <div className="neo-kpi-grid">
          {paths.map((p, i) => {
            const def = FACTS[p];
            if (!def) return null;
            // Read the state of the one domain that produces this fact.
            const domain = facts.forPath(p);
            return (
              <div key={p} className="min-w-0" data-kpi-span={i === 0 ? "lead" : undefined}>
              <FactCard
                fact={def}
                value={factValue(facts.data, p)}
                currency={currency}
                isLoading={domain.isLoading}
                error={domain.error}
                permitted={
                  def.kind !== "money" || !facts.domains.period.isSuccess || moneyAllowed
                }
                path={p}
                scope={scope}
              />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}


const amount = (v: unknown, currency: string) =>
  v === null || v === undefined
    ? "—"
    : `${currency} ${new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 }).format(Number(v))}`;

/** operational eligible → posted → reversals → net → collected → outstanding */
export function FactReconciliation({
  scope,
  enabled = true,
}: {
  scope: FactScope;
  enabled?: boolean;
}) {
  const facts = useFacts(scope, enabled);
  const rows = useFactReconciliation(scope, enabled);
  const unmatched = useUnmatchedFacts(scope, enabled);
  const currency = factCurrency(facts.data);

  if (rows.isLoading) return <LoadingState variant="table" rows={4} />;
  if (rows.error)
    return (
      <ErrorState
        inline
        title="Reconciliation could not be calculated"
        error={rows.error}
        onRetry={() => void rows.refetch()}
      />
    );

  return (
    <div className="space-y-6">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-muted-foreground">
            <tr>
              <th className="py-2 pr-4">Stream</th>
              <th className="py-2 pr-4">Operational eligible</th>
              <th className="py-2 pr-4">Posted</th>
              <th className="py-2 pr-4">Reversals / refunds</th>
              <th className="py-2 pr-4">Net recognised</th>
              <th className="py-2 pr-4">Collected</th>
              <th className="py-2 pr-4">Outstanding receivable</th>
              <th className="py-2 pr-4">Unmatched</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {(rows.data ?? []).map((r) => (
              <tr key={r.stream}>
                <td className="py-2 pr-4 font-medium">{r.stream}</td>
                <td className="py-2 pr-4">{amount(r.operational_eligible, currency)}</td>
                <td className="py-2 pr-4">{amount(r.posted, currency)}</td>
                <td className="py-2 pr-4">{amount(r.reversals, currency)}</td>
                <td className="py-2 pr-4 font-semibold">{amount(r.net_recognised, currency)}</td>
                <td className="py-2 pr-4">{amount(r.collected, currency)}</td>
                <td className="py-2 pr-4">{amount(r.outstanding_receivable, currency)}</td>
                <td className="py-2 pr-4">{r.unmatched_records ?? 0}</td>
              </tr>
            ))}
            {(rows.data ?? []).length === 0 ? (
              <tr>
                <td colSpan={8} className="py-6 text-sm text-muted-foreground">
                  No eligible records in this period, so there is nothing to reconcile.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-foreground">
          Eligible records that did not post
        </h3>
        {(unmatched.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Every eligible operational record in this period has a matching finance posting.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4">Module</th>
                  <th className="py-2 pr-4">Reference</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Amount</th>
                  <th className="py-2 pr-4">Date</th>
                  <th className="py-2 pr-4">Reason excluded</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(unmatched.data ?? []).map((u) => (
                  <tr key={`${u.source_module}:${u.source_id}`}>
                    <td className="py-2 pr-4">{u.source_module}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{u.reference || u.source_id}</td>
                    <td className="py-2 pr-4">{u.status}</td>
                    <td className="py-2 pr-4">{amount(u.amount, currency)}</td>
                    <td className="py-2 pr-4">{u.occurred_on}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{u.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export { SHARED_FACT_PATHS } from "@/components/common/fact-paths";


