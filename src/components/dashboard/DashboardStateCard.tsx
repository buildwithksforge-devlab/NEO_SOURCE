import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Building2,
  ArrowUpRight,
  ChevronRight,

  CircleDashed,
  Loader2,
  Lock,
  Settings2,
  TriangleAlert,
  Activity,
  CheckCircle2,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  CARD_STATE_COPY,
  resolveCardState,
  type CardState,
  type CardStateInput,
} from "@/lib/card-state";

const STATE_ICON: Partial<Record<CardState, LucideIcon>> = {
  loading: Loader2,
  "no-records": CircleDashed,
  "not-configured": Settings2,
  "access-denied": Lock,
  "select-property": Building2,
  "query-failed": TriangleAlert,
  "not-implemented": AlertTriangle,
};

import { TONE_RING } from "@/lib/tone";

/**
 * Colour hierarchy for a live figure. A dashboard should read as a designed
 * set — a brand-washed lead card, quiet tinted supporting cards and semantic
 * tints where the figure carries a status — rather than a wall of white
 * rectangles. All values come from theme/tenant tokens, so a rebrand or dark
 * mode carries through without touching this file.
 */
const TONE_SURFACE: Record<NonNullable<DashboardStateCardProps["tone"]>, string> = {
  default: "neo-tint-quiet",
  accent: "neo-tint-accent",
  success: "neo-tint-success",
  warning: "neo-tint-warning",
};

/** The glyph shown on a healthy card, so no card is left iconless. */
const TONE_ICON: Record<NonNullable<DashboardStateCardProps["tone"]>, LucideIcon> = {
  default: Activity,
  accent: Sparkles,
  success: CheckCircle2,
  warning: TriangleAlert,
};

export type DashboardStateCardProps = CardStateInput & {
  label: string;
  /** Scope / period hint shown under the figure when a real value renders. */
  hint?: string;
  suffix?: string;
  /** Formats a real value; defaults to locale integer formatting. */
  format?: (value: number) => string;
  tone?: "default" | "accent" | "success" | "warning";
  /** Lead KPI of a dashboard: larger figure and an accent edge. */
  featured?: boolean;
  /** Operational page that owns the records behind this figure. */
  drillTo?: string;
  drillLabel?: string;
  /** Explains what is missing when the state is `not-configured`. */
  configureNote?: string;
  configureTo?: string;
  onRetry?: () => void;
  className?: string;
};


/**
 * The one card used by every dashboard KPI.
 *
 * It resolves its own state through `resolveCardState`, so a card can never
 * print `0` while a fetch is in flight, and never claims "awaiting data" when
 * the real answer is a refusal, a failure or an unbuilt module.
 */
export function DashboardStateCard({
  label,
  hint,
  suffix = "",
  format,
  tone = "default",
  featured = false,

  drillTo,
  drillLabel = "Open",
  configureNote,
  configureTo,
  onRetry,
  className,
  ...stateInput
}: DashboardStateCardProps) {
  const state = resolveCardState(stateInput);
  const copy = CARD_STATE_COPY[state];
  const Icon = STATE_ICON[state] ?? (state === "ready" ? TONE_ICON[tone] : undefined);
  const muted = state !== "ready";

  const rendered =
    state === "ready"
      ? `${(format ?? ((v: number) => v.toLocaleString()))(stateInput.value as number)}${suffix}`
      : copy.label;

  const note =
    state === "not-configured"
      ? (configureNote ?? copy.note)
      : state === "ready"
        ? hint
        : copy.note;

  const interactive = Boolean(drillTo) && (state === "ready" || state === "no-records");

  const body = (
    <Card
      data-card-state={state}
      data-card-interactive={interactive ? "true" : undefined}
      data-card-tone={state === "ready" ? tone : undefined}
      className={cn(
        "surface-panel neo-metric-card h-full min-w-0 gap-0 overflow-hidden py-4",
        // A live figure is never plain white: the lead KPI carries a brand
        // wash, supporting figures a quiet or semantic tint.
        state === "ready" && (featured ? "neo-card-lead" : TONE_SURFACE[tone]),
        state === "ready" && "neo-card-interactive neo-card-press",
        featured && state === "ready" && "neo-accent-edge",
        interactive &&
          "transition-shadow duration-200 group-hover:border-primary/50 group-hover:shadow-elegant group-focus-visible:border-primary",
        muted && "border-dashed bg-muted/30 shadow-none",
        state === "query-failed" && "border-destructive/40 bg-destructive/5",
        className,
      )}
    >
      <CardContent className="min-w-0 px-5">
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 line-clamp-2 text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {label}
          </p>

          {Icon ? (
            <span
              className={cn(
                "grid size-9 shrink-0 place-items-center rounded-xl",
                state === "query-failed"
                  ? "bg-destructive/10 text-destructive"
                  : state === "ready"
                    ? TONE_RING[tone]
                    : "bg-muted text-muted-foreground",
              )}
            >
              <Icon className={cn("size-4", state === "loading" && "animate-spin")} />
            </span>
          ) : (
            <span
              className={cn("grid size-9 shrink-0 place-items-center rounded-xl", TONE_RING[tone])}
              aria-hidden
            />
          )}
        </div>

        <p
          className={cn(
            "mt-2 min-w-0 tracking-tight",
            state === "ready"
              ? cn("text-foreground", featured ? "neo-metric-value-lead" : "neo-metric-value")
              : "text-lg font-semibold text-muted-foreground",
            state === "query-failed" && "text-destructive",
          )}
          title={rendered}
        >
          {rendered}
        </p>


        {note ? (
          <p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">{note}</p>
        ) : null}

        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
          {interactive ? (
            /* The card itself is the action; this is only a quiet affordance. */
            <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground/80 transition-colors group-hover:text-primary">
              <span className="sr-only">{drillLabel}</span>
              <ChevronRight
                aria-hidden
                className="size-4 transition-transform group-hover:translate-x-0.5"
              />
            </span>
          ) : null}

          {state === "not-configured" && configureTo ? (
            <Link
              to={configureTo}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
            >
              Complete setup
              <ArrowUpRight className="size-3" />
            </Link>
          ) : null}
          {state === "query-failed" && onRetry ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={(event) => {
                event.stopPropagation();
                onRetry();
              }}
            >
              Retry
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );

  // The whole card is the action when it has a records destination: one target,
  // keyboard reachable through the link itself, no redundant inline drill link.
  if (interactive && drillTo) {
    return (
      <Link
        to={drillTo}
        aria-label={`${label} — ${drillLabel}`}
        className="group block h-full min-w-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {body}
      </Link>
    );
  }

  return body;
}
