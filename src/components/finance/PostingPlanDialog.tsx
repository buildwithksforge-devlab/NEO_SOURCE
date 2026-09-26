/**
 * Posting drilldown.
 *
 * Answers one question for a single operational record: which accounting
 * entries should exist for it, and which of them actually do. The plan is
 * computed by the database from the same rules the posting engine uses, so it
 * never guesses — an account that is missing from the chart of accounts is
 * reported as missing rather than substituted.
 */
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { Link } from "@tanstack/react-router";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/common/DataDisplay";
import { usePostingPlan, type PostingPlan } from "@/lib/finance-posting";

const fmt = (v: number | null | undefined, currency: string) =>
  v === null || v === undefined || Number(v) === 0
    ? "—"
    : `${currency} ${new Intl.NumberFormat("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v))}`;

export type PostingPlanTarget = { module: string; sourceId: string; reference?: string | null };

export function PostingPlanDialog({
  target,
  onClose,
}: {
  target: PostingPlanTarget | null;
  onClose: () => void;
}) {
  const plan = usePostingPlan(target?.module ?? null, target?.sourceId ?? null);

  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Posting drilldown</DialogTitle>
          <DialogDescription>
            {target?.reference ? `Record ${target.reference}. ` : ""}
            The entries this record should create, and the entries recorded so far.
          </DialogDescription>
        </DialogHeader>

        {plan.isLoading ? (
          <Skeleton className="h-56 w-full rounded-xl" />
        ) : plan.error ? (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="size-4" /> The drilldown could not be read: {plan.error.message}
          </p>
        ) : plan.data && plan.data.ok ? (
          <PlanBody plan={plan.data} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {plan.data?.reason === "not_found"
              ? "This record is not visible in your scope."
              : plan.data?.reason === "no_organisation"
                ? "No property context is active, so the drilldown cannot be read."
                : plan.data?.reason === "unknown_source_type"
                  ? "No posting rule covers this record type."
                  : `The drilldown returned nothing to show${plan.data?.reason ? ` (${plan.data.reason})` : ""}.`}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PlanBody({ plan }: { plan: PostingPlan }) {
  const currency = plan.currency ?? "";
  const lines = plan.lines ?? [];
  const balanced = Math.abs((plan.total_debit ?? 0) - (plan.total_credit ?? 0)) < 0.01;

  return (
    <div className="space-y-5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={plan.eligible ? "success" : "warning"}>
          {plan.eligible ? "Eligible to post" : "Blocked by a rule"}
        </StatusPill>
        <StatusPill tone="info">{plan.posting_type}</StatusPill>
        <span className="text-muted-foreground">
          {plan.module} · {plan.occurred_on ?? "no date"} · {fmt(plan.amount, currency)}
        </span>
      </div>

      {plan.blocked_reason ? (
        <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
          {plan.blocked_reason}
        </p>
      ) : null}

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Entries that should be created
        </p>
        <table className="w-full text-left text-xs">
          <thead className="text-[0.68rem] uppercase text-muted-foreground">
            <tr>
              <th className="py-1 pr-3">Account</th>
              <th className="py-1 pr-3">Purpose</th>
              <th className="py-1 pr-3 text-right">Debit</th>
              <th className="py-1 pr-3 text-right">Credit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {lines.map((l, i) => (
              <tr key={`${l.code}-${i}`}>
                <td className="py-1.5 pr-3">
                  <span className="font-mono">{l.code}</span>{" "}
                  <span className={l.configured ? "" : "text-destructive"}>{l.account}</span>
                </td>
                <td className="py-1.5 pr-3 text-muted-foreground">{l.description}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(l.debit, currency)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(l.credit, currency)}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className="py-1.5 pr-3" colSpan={2}>
                Total
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(plan.total_debit, currency)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{fmt(plan.total_credit, currency)}</td>
            </tr>
          </tbody>
        </table>
        {!balanced ? (
          <p className="mt-2 text-xs text-destructive">
            These entries do not balance, which means an account code is missing from the chart of
            accounts. Finance will refuse the posting until it is added.
          </p>
        ) : null}
      </div>

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          What exists today
        </p>
        {plan.receipt ? (
          <p className="text-xs">
            Receipt <StatusPill tone={plan.receipt.status === "posted" ? "success" : "warning"}>{plan.receipt.status}</StatusPill>{" "}
            · {plan.receipt.attempts} attempt(s)
            {plan.receipt.last_error ? ` · last error: ${plan.receipt.last_error}` : ""}
            {plan.receipt.detail ? ` · ${plan.receipt.detail}` : ""}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">No posting has been attempted for this record.</p>
        )}

        {plan.journal ? (
          <div className="mt-3 rounded-lg border border-border p-3">
            <p className="text-xs font-medium">
              Journal {plan.journal.number ?? plan.journal.id.slice(0, 8)} · {plan.journal.status} ·{" "}
              {plan.journal.accounting_date ?? "no date"}
            </p>
            <table className="mt-2 w-full text-left text-xs">
              <tbody className="divide-y divide-border">
                {plan.journal.lines.map((l, i) => (
                  <tr key={`${l.code}-${i}`}>
                    <td className="py-1 pr-3 font-mono">{l.code}</td>
                    <td className="py-1 pr-3">{l.account}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{fmt(l.debit, currency)}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{fmt(l.credit, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Link
              to="/finance/journals"
              className="mt-2 inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
            >
              Open in journals <ArrowUpRight className="size-3" />
            </Link>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">No journal entry exists for this record yet.</p>
        )}

        {plan.reversal ? (
          <p className="mt-3 text-xs">
            Reversed by journal {plan.reversal.number ?? plan.reversal.id.slice(0, 8)} on{" "}
            {plan.reversal.accounting_date ?? "an unrecorded date"}.
          </p>
        ) : null}
      </div>
    </div>
  );
}
