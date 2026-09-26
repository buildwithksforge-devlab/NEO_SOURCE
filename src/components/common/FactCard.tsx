/**
 * Shared presentation for a canonical fact.
 *
 * Loading never prints a zero, a failed query never prints a zero, and a
 * genuine zero explains the eligibility rule and links to the source records.
 *
 * Hierarchy: compact label → prominent figure → one short line of context.
 * The whole card is the link to its source records — there is no separate
 * "Open records" button repeated on every tile.
 */
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ChevronRight, Info, Lock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatFact, type FactDefinition, type FactScope } from "@/lib/facts";
import { FactDrilldown } from "@/components/common/FactDrilldown";

export function FactCard({
  fact,
  value,
  currency,
  isLoading,
  error,
  permitted = true,
  hint,
  path,
  scope,
}: {
  fact: FactDefinition;
  value: number | null;
  currency: string;
  isLoading: boolean;
  error?: unknown;
  permitted?: boolean;
  hint?: string;
  path?: string;
  scope?: FactScope;
}) {
  const body = () => {
    if (isLoading) return <Skeleton className="h-8 w-28" />;
    if (!permitted)
      return (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Lock className="size-4" /> Not authorised
        </p>
      );
    if (error)
      return (
        <p className="flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="size-4" /> Could not be calculated
        </p>
      );
    return (
      <p className="neo-metric-value neo-atomic text-foreground">
        {formatFact(value, fact.kind, currency)}
      </p>
    );
  };

  const zero = !isLoading && !error && permitted && (value === null || value === 0);
  const interactive = permitted && !error;

  const inner = (
    <Card
      data-card-interactive={interactive ? "true" : undefined}
      className="surface-panel neo-card-interactive neo-metric-card h-full gap-0 py-0 group-hover:border-primary/50"
    >
      <CardContent className="neo-card-pad flex h-full flex-col">
        <div className="flex items-start justify-between gap-2">
          <p
            className="neo-line-1 text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
            title={fact.label}
          >
            {fact.label}
          </p>
          <span className="flex shrink-0 items-center gap-0.5">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  asChild={false}
                  aria-label={`How ${fact.label} is calculated`}
                  onClick={(e) => e.preventDefault()}
                  className="rounded-full p-1 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Info className="size-4" />
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-xs">{fact.eligibility}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {interactive ? (
              <ChevronRight
                aria-hidden
                className="size-4 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
              />
            ) : null}
          </span>
        </div>

        <div className="mt-2">{body()}</div>

        {zero ? (
          <p className="mt-1.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
            No eligible records. {fact.eligibility}
          </p>
        ) : hint ? (
          <p className="mt-1.5 line-clamp-2 text-xs leading-snug text-muted-foreground">{hint}</p>
        ) : null}

        {zero && path && scope ? (
          /* The card itself is a link; the "Why?" dialog must open in place
             instead of letting the click bubble up and navigate away. */
          <div
            data-action-cluster
            className="mt-auto pt-3"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <FactDrilldown
              metric={path}
              label={fact.label}
              eligibility={fact.eligibility}
              scope={scope}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );

  if (!interactive) return inner;

  return (
    <Link
      data-touch-target
      to={fact.drillTo}
      aria-label={`${fact.label} — open source records`}
      className="group block h-full min-w-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      {inner}
    </Link>
  );
}

/** Period, scope and last-calculated stamp shown once per fact section. */
export function FactProvenance({
  period,
  timezone,
  currency,
  generatedAt,
  scopeLabel,
}: {
  period: string;
  timezone: string;
  currency: string;
  generatedAt: string | null;
  scopeLabel: string;
}) {
  return (
    <p className="text-xs text-muted-foreground">
      {scopeLabel} · {period} · {timezone || "property timezone"} · {currency} ·{" "}
      {generatedAt ? `calculated ${new Date(generatedAt).toLocaleString()}` : "calculating…"}
    </p>
  );
}
