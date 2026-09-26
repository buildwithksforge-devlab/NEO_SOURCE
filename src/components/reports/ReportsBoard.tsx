/**
 * Presentation pieces for the Operational Reports workspace.
 *
 * The reporting page reads exactly the same canonical fact layer as the
 * dashboards, /analytics and /finance. These components only change how those
 * facts are arranged: one provenance line, one export control, one navigable
 * board — instead of six identical stacked blocks each repeating the same
 * header, source line and export buttons.
 *
 * Nothing here computes a figure. Every value comes from `useFacts`.
 */
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, ChevronRight, Minus } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { FactCard } from "@/components/common/FactCard";
import { cn } from "@/lib/utils";
import { TONE_BORDER, TONE_TINT, type Tone } from "@/lib/tone";
import {
  FACTS,
  factCurrency,
  factValue,
  factsMonetaryAuthorised,
  formatFact,
  type FactScope,
  type FactsResult,
} from "@/lib/facts";

/**
 * Period-over-period movement for one fact.
 *
 * Only stated when both periods actually answered; a missing comparison is
 * left blank rather than implied as "no change".
 */
export function FactDelta({
  current,
  previous,
  kind,
  currency,
}: {
  current: number | null;
  previous: number | null;
  kind: string;
  currency: string;
}) {
  if (current === null || previous === null) return null;
  const difference = current - previous;
  const percent = previous === 0 ? null : (difference / Math.abs(previous)) * 100;
  const direction = difference > 0 ? "up" : difference < 0 ? "down" : "flat";
  const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;
  const tone =
    direction === "flat"
      ? "text-muted-foreground"
      : direction === "up"
        ? "text-success"
        : "text-warning";

  const previousLabel = formatFact(previous, kind as never, currency);

  return (
    <p className={cn("mt-1 flex items-center gap-1 text-xs", tone)}>
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">
        {percent === null
          ? `${formatFact(difference, kind as never, currency)} vs previous period`
          : `${percent > 0 ? "+" : ""}${percent.toFixed(1)}% vs ${previousLabel}`}
      </span>
    </p>
  );
}

/** A grid of canonical fact cards with no repeated section chrome. */
export function FactGrid({
  paths,
  facts,
  previous,
  scope,
  lead = 0,
}: {
  paths: readonly string[];
  facts: FactsResult;
  /** Optional equivalent earlier period used only for movement labels. */
  previous?: FactsResult | undefined;
  scope: FactScope;
  /** How many leading cards are rendered at hero width. */
  lead?: number;
}) {
  const currency = factCurrency(facts.data);
  const moneyAllowed = factsMonetaryAuthorised(facts.data);

  return (
    <div className="neo-kpi-grid">
      {paths.map((path, index) => {
        const def = FACTS[path];
        if (!def) return null;
        const domain = facts.forPath(path);
        const permitted = def.kind !== "money" || !facts.domains.period.isSuccess || moneyAllowed;
        const comparable =
          permitted && previous?.forPath(path).isSuccess && !domain.isLoading && !domain.error;
        return (
          <div
            key={path}
            className="min-w-0"
            data-kpi-span={index < lead ? "lead" : undefined}
          >
            <FactCard
              fact={def}
              value={factValue(facts.data, path)}
              currency={currency}
              isLoading={domain.isLoading}
              error={domain.error}
              permitted={permitted}
              path={path}
              scope={scope}
            />
            {comparable ? (
              <FactDelta
                current={factValue(facts.data, path)}
                previous={factValue(previous?.data, path)}
                kind={def.kind}
                currency={currency}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Section switcher rendered as a scrollable chip row. */
export function BoardNav({
  sections,
  active,
  onSelect,
}: {
  sections: readonly { id: string; label: string }[];
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Report sections"
      className="neo-scroll-x -mx-1 flex items-center gap-1.5 px-1"
    >
      {sections.map((section) => {
        const selected = section.id === active;
        return (
          <button
            key={section.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(section.id)}
            className={cn(
              "shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
              selected
                ? "border-primary bg-primary/10 text-foreground"
                : "border-outline-subtle text-muted-foreground hover:border-primary/40 hover:text-foreground",
            )}
          >
            {section.label}
          </button>
        );
      })}
    </div>
  );
}

export type AttentionRule = {
  path: string;
  /** Raised when the fact value satisfies this test. */
  when: (value: number) => boolean;
  severity: Tone;
  message: (formatted: string) => string;
};

/**
 * Rule-driven exception rail. Each row is a real fact above a threshold and
 * links to the records behind it; nothing is raised when no rule triggers.
 */
export function AttentionRail({
  rules,
  facts,
}: {
  rules: readonly AttentionRule[];
  facts: FactsResult;
}) {
  const currency = factCurrency(facts.data);

  const raised = rules.flatMap((rule) => {
    const def = FACTS[rule.path];
    if (!def) return [];
    const domain = facts.forPath(rule.path);
    if (!domain.isSuccess) return [];
    const value = factValue(facts.data, rule.path);
    if (value === null || !rule.when(value)) return [];
    return [{ rule, def, formatted: formatFact(value, def.kind, currency) }];
  });

  if (raised.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No reporting rule triggered for this scope and period. Nothing is invented to fill this
        panel.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {raised.map(({ rule, def, formatted }) => (
        <li key={rule.path}>
          <Link
            to={def.drillTo}
            className={cn(
              "flex items-start justify-between gap-3 rounded-lg border p-3 transition-colors hover:border-primary/50",
              TONE_TINT[rule.severity],
              TONE_BORDER[rule.severity],
            )}
          >
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{def.label}</span>
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {rule.message(formatted)}
              </span>
            </span>
            <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** A titled panel used for charts and lists on the board. */
export function BoardPanel({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("surface-panel", className)}>
      <CardContent className="neo-card-pad">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            {description ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? <div data-action-cluster>{actions}</div> : null}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}
