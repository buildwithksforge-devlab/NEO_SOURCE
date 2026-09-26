/**
 * Data-source status line for every shared fact surface.
 *
 * Says which service produced the figures, whether that service is currently
 * loading, live, unreadable or unauthorised, and when reconciliation last ran.
 * A surface is never silently empty: loading, error and empty are distinct and
 * labelled, and none of them is a zero.
 */
import { AlertTriangle, CheckCircle2, Clock, Loader2, Lock } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useReconciliationMeta } from "@/lib/fact-export";
import {
  FACT_DOMAIN_LABEL,
  factsAuthorised,
  type FactPayload,
  type FactScope,
  type FactsResult,
  type ReconciliationRow,
} from "@/lib/facts";

type QueryLike<T> = {
  data: T | undefined;
  isLoading: boolean;
  isSuccess: boolean;
  error: unknown;
};

const stamp = (value: string | null | undefined): string => {
  if (!value) return "never";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "never"
    : d.toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" });
};

export function DataSourceStatus({
  scope,
  query,
  facts,
  reconciliation,
  enabled = true,
}: {
  scope: FactScope;
  query: QueryLike<FactPayload>;
  /**
   * The full multi-domain fact reader. When present, each domain reports its
   * own state, so one unreadable domain is named instead of the whole surface
   * being declared broken.
   */
  facts?: FactsResult;
  reconciliation?: QueryLike<ReconciliationRow[]>;
  enabled?: boolean;
}) {
  const meta = useReconciliationMeta(scope, enabled);

  const loading = query.isLoading || Boolean(reconciliation?.isLoading);
  const failed = Boolean(query.error) || Boolean(reconciliation?.error);
  const unauthorised = query.isSuccess && !factsAuthorised(query.data);
  const empty =
    !loading &&
    !failed &&
    !unauthorised &&
    query.isSuccess &&
    (reconciliation ? (reconciliation.data ?? []).length === 0 : false);

  const domainStates = facts ? Object.values(facts.domains) : [];
  const brokenDomains = domainStates.filter((d) => d.failure);
  const partial = brokenDomains.length > 0 && brokenDomains.length < domainStates.length;

  const sources = (meta.data?.sources ?? ["neo_facts", "neo_fact_reconciliation"]).join(", ");

  const state = partial
    ? {
        icon: <AlertTriangle className="size-4" />,
        tone: "text-on-tint-warning",
        text: `${brokenDomains.length} of ${domainStates.length} fact services could not be read. The remaining figures below are live and unaffected.`,
      }
    : loading
    ? {
        icon: <Loader2 className="size-4 animate-spin" />,
        tone: "text-muted-foreground",
        text: "Reading the canonical fact service — figures appear once it responds. No value is assumed in the meantime.",
      }
    : failed
      ? {
          icon: <AlertTriangle className="size-4" />,
          tone: "text-destructive",
          text: "The fact service could not be read, so nothing is displayed. Retry or check your connection — this is not a zero.",
        }
      : unauthorised
        ? {
            icon: <Lock className="size-4" />,
            tone: "text-muted-foreground",
            text: "You are not authorised to read these figures for this property.",
          }
        : empty
          ? {
              icon: <Clock className="size-4" />,
              tone: "text-muted-foreground",
              text: "The service responded, and no operational record in this property and period is subject to a Finance posting rule.",
            }
          : {
              icon: <CheckCircle2 className="size-4 text-primary" />,
              tone: "text-muted-foreground",
              text: "Live from the canonical fact service.",
            };

  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
      <p className={`flex items-center gap-2 ${state.tone}`}>
        {state.icon}
        <span>{state.text}</span>
      </p>
      {domainStates.length ? (
        <ul className="mt-2 space-y-1 text-[0.68rem]">
          {domainStates.map((d) => (
            <li key={d.domain} className="flex flex-wrap items-center gap-x-2">
              <span className="font-medium text-foreground">{FACT_DOMAIN_LABEL[d.domain]}</span>
              <span className="text-muted-foreground">({d.service})</span>
              {d.isLoading ? (
                <span className="text-muted-foreground">reading…</span>
              ) : d.failure ? (
                <span className="text-destructive">
                  {d.failure.message} [{d.failure.kind}: {d.failure.detail}]
                </span>
              ) : d.isSuccess ? (
                <span className="text-primary">live</span>
              ) : (
                <span className="text-muted-foreground">idle</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[0.68rem] text-muted-foreground">
        <span>Source: {sources}</span>
        {meta.isLoading ? (
          <Skeleton className="h-3 w-40" aria-label="Reading reconciliation status" />
        ) : meta.error ? (
          <span>Last reconciliation: unavailable</span>
        ) : (
          <>
            <span>Last reconciliation: {stamp(meta.data?.last_reconciled_at)}</span>
            <span>Last posting: {stamp(meta.data?.last_posted_at)}</span>
            <span>
              Receipts — posted {meta.data?.receipts_posted ?? 0} · skipped{" "}
              {meta.data?.receipts_skipped ?? 0} · failed {meta.data?.receipts_failed ?? 0}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
