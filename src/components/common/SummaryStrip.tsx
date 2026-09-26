/**
 * Smart Summary Strip.
 *
 * Replaces rows of KPI boxes on list pages. A strip carries ONE lead figure
 * and a small number of supporting figures, and every figure is an entry point
 * into the work it describes — selecting "14 missing routing" filters the list
 * below rather than merely reporting the number.
 *
 * Deliberately one surface, not N cards: this is the "contain everything,
 * don't card everything" rule made concrete.
 */
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { TONE_TINT, type Tone } from "@/lib/tone";

export type SummaryFigure = {
  /** Stable key used by the caller to track which figure is active. */
  id: string;
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: Tone;
  icon?: LucideIcon;
  /** Makes the figure a filter toggle. Omit for read-only context. */
  onSelect?: () => void;
  active?: boolean;
};

function Figure({ figure, lead }: { figure: SummaryFigure; lead?: boolean }) {
  const { label, value, hint, tone = "default", icon: Icon, onSelect, active } = figure;

  const body = (
    <>
      <div className="flex min-w-0 items-center gap-2">
        {Icon ? (
          <span className={cn("shrink-0 rounded-lg p-1", TONE_TINT[tone])}>
            <Icon className="size-3.5" />
          </span>
        ) : null}
        <p
          className="neo-line-1 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
          title={label}
        >
          {label}
        </p>
      </div>
      <p
        className={cn(
          "neo-atomic mt-1 font-semibold text-foreground",
          lead ? "neo-metric-value neo-metric-value-lead" : "text-lg sm:text-xl",
        )}
      >
        {value}
      </p>
      {hint ? <p className="neo-line-1 mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </>
  );

  const shell = cn(
    "min-w-[9.5rem] flex-1 rounded-xl px-3 py-2.5 text-left transition-colors",
    lead ? "min-w-[12rem]" : "",
    onSelect
      ? "cursor-pointer hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      : "",
    active ? "bg-chip-selected ring-1 ring-ring/40" : "",
  );

  if (!onSelect) {
    return <div className={shell}>{body}</div>;
  }
  return (
    <button
      type="button"
      data-touch-target
      aria-pressed={active ?? false}
      onClick={onSelect}
      className={shell}
    >
      {body}
    </button>
  );
}

export function SummaryStrip({
  lead,
  figures,
  actions,
  className,
}: {
  /** The single headline figure of the screen. */
  lead: SummaryFigure;
  /** 2–5 supporting figures. More than that is a dashboard, not a strip. */
  figures?: SummaryFigure[] | undefined;
  actions?: ReactNode | undefined;
  className?: string | undefined;
}) {
  return (
    <section
      aria-label="Summary"
      className={cn(
        "surface-quiet mb-4 flex min-w-0 flex-col gap-2 rounded-2xl p-1.5 sm:mb-5",
        className,
      )}
    >
      <div className="neo-scroll-x flex min-w-0 items-stretch gap-1 divide-x divide-outline-subtle">
        <Figure figure={lead} lead />
        {(figures ?? []).map((f) => (
          <Figure key={f.id} figure={f} />
        ))}
      </div>
      {actions ? (
        <div data-action-cluster className="flex flex-wrap items-center gap-2 px-2 pb-1">
          {actions}
        </div>
      ) : null}
    </section>
  );
}
