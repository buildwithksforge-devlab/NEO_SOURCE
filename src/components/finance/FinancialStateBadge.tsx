import { Link } from "@tanstack/react-router";
import { StatusPill } from "@/components/common/DataDisplay";
import {
  financialModuleLabel,
  financialResolutionAction,
  financialStatusLabel,
  financialStatusMeaning,
  financialStatusTone,
  type FinancialStateRow,
} from "@/lib/financial-state";

/**
 * The financial half of a transaction, always shown beside — never instead of —
 * its operational status. The words differ on purpose: "Received" is a stores
 * fact, "GL posted" is an accounting fact, and NEØ never lets one stand in for
 * the other.
 */
export function FinancialStateBadge({ status }: { status: string | null | undefined }) {
  return (
    <StatusPill tone={financialStatusTone(status ?? "")}>{financialStatusLabel(status)}</StatusPill>
  );
}

export function OperationalStateBadge({ status }: { status: string | null | undefined }) {
  const value = (status ?? "unknown").replace(/[-_]/g, " ");
  return <StatusPill tone="default">{value.charAt(0).toUpperCase() + value.slice(1)}</StatusPill>;
}

/** Full financial-state panel for a source record's detail view. */
export function FinancialStatePanel({
  state,
  operationalStatus,
  formatAmount,
}: {
  state: FinancialStateRow | null;
  operationalStatus?: string | null;
  formatAmount?: (value: number) => string;
}) {
  if (!state) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        No financial state recorded for this transaction yet.
      </div>
    );
  }
  const action = financialResolutionAction(state.financial_status);
  const amount = formatAmount ? formatAmount(Number(state.amount) || 0) : String(state.amount);

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <OperationalStateBadge status={operationalStatus ?? state.operational_status} />
        <span className="text-xs text-muted-foreground">operational</span>
        <span className="text-muted-foreground">·</span>
        <FinancialStateBadge status={state.financial_status} />
        <span className="text-xs text-muted-foreground">financial</span>
      </div>

      <p className="text-sm text-muted-foreground">{financialStatusMeaning(state.financial_status)}</p>
      {state.reason ? <p className="text-sm">{state.reason}</p> : null}

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Field label="Source" value={`${financialModuleLabel(state.source_module)} · ${state.source_reference ?? "—"}`} />
        <Field label="Amount" value={`${amount} ${state.currency}`} />
        <Field label="Accounting date" value={state.accounting_date ?? "—"} />
        <Field label="Attempts" value={String(state.attempts)} />
        <Field label="Last attempt" value={state.last_attempt_at?.slice(0, 16).replace("T", " ") ?? "—"} />
        <Field
          label="Journal"
          value={
            state.journal_id ? (
              <Link to="/finance/journals" className="underline underline-offset-4">
                {state.journal_number ?? "View journal"}
              </Link>
            ) : (
              "No journal yet"
            )
          }
        />
      </dl>

      {state.last_error ? (
        <p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">{state.last_error}</p>
      ) : null}
      {action ? <p className="text-sm font-medium">Next step: {action}</p> : null}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}
