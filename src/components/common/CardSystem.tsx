/**
 * The shared card and board system.
 *
 * One standard for every dashboard card, workflow card, module summary and
 * status board in NEØ. The rules it enforces are structural, not decorative:
 *
 *  - a board lays its cards out in equal-width columns with one gap scale and
 *    stacks responsively; no card is wider than its neighbour;
 *  - every card in a row is the same height, because the card is a full-height
 *    flex column and the grid stretches its items;
 *  - titles start at the same vertical position, the status badge always sits
 *    in the same corner, the main value occupies flexible central space and
 *    the footer is pushed to the bottom, so actions stay aligned across
 *    neighbours whatever the description length;
 *  - empty, loading, zero, error and populated states keep the same footprint;
 *  - long references truncate visually but remain readable through their
 *    title attribute and the record behind them;
 *  - tables inside a card scroll inside the card rather than growing the page;
 *  - no card carries a fixed height, so legitimate content is never clipped.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { StatusPill } from "@/components/common/DataDisplay";

type Tone = "default" | "success" | "warning" | "destructive" | "info";

/** Column counts a board may use. Anything else would break the equal-width rule. */
export type BoardColumns = 2 | 3 | 4;

const COLUMNS: Record<BoardColumns, string> = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3",
  4: "sm:grid-cols-2 xl:grid-cols-4",
};

/**
 * Equal-width, equal-height card board.
 *
 * `auto-rows-fr` plus `items-stretch` is what makes neighbouring cards share a
 * height; the children must be `NeoCard` (or anything `h-full`) for the
 * internal areas to align as well.
 */
export function CardBoard({
  columns = 3,
  children,
  className,
}: {
  columns?: BoardColumns;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-card-board=""
      data-columns={columns}
      className={cn(
        "grid auto-rows-fr items-stretch gap-4 grid-cols-1",
        COLUMNS[columns],
        className,
      )}
    >
      {children}
    </div>
  );
}

/** The card shell: a full-height flex column so the footer can be pinned. */
export function NeoCard({
  tone = "default",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card
      data-card=""
      data-tone={tone}
      className={cn(
        "surface-raised flex h-full min-w-0 flex-col gap-0 overflow-hidden p-4",
        tone === "destructive" && "border-destructive/40",
        tone === "warning" && "border-warning/40",
        tone === "success" && "border-success/40",
        className,
      )}
    >
      {children}
    </Card>
  );
}

/** Header area: title on the left, status in a fixed top-right slot. */
export function NeoCardHeader({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-card-header=""
      className={cn("flex min-w-0 items-start justify-between gap-3", className)}
    >
      {children}
    </div>
  );
}

export function NeoCardTitle({ children, hint }: { children: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <p
        className="neo-line-1 text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
        title={children}
      >
        {children}
      </p>
      {hint ? (
        <p className="neo-line-1 text-xs text-muted-foreground/80" title={hint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function NeoCardStatus({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: Tone;
}) {
  return (
    <div data-card-status="" className="shrink-0">
      <StatusPill tone={tone}>{children}</StatusPill>
    </div>
  );
}

/**
 * Central content. `flex-1` gives it the spare vertical space, so the main
 * value stays visually balanced whether the card is short or tall.
 */
export function NeoCardBody({
  children,
  className,
  center = true,
}: {
  children: ReactNode;
  className?: string;
  center?: boolean;
}) {
  return (
    <div
      data-card-body=""
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col gap-1 py-3",
        center && "justify-center",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** The one loud line in a card. Long values truncate rather than reflow. */
export function NeoCardMetric({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <p
      data-card-metric=""
      className="neo-line-1 text-2xl font-semibold tabular-nums tracking-tight"
      title={title}
    >
      {children}
    </p>
  );
}

/** Supporting copy. Wraps, clamped, and can never push actions out of the card. */
export function NeoCardDescription({ children }: { children: ReactNode }) {
  return (
    <p data-card-description="" className="neo-line-2 text-xs text-muted-foreground">
      {children}
    </p>
  );
}

/** Footer sits at the bottom of every card in the row, whatever precedes it. */
export function NeoCardFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-card-footer=""
      className={cn("mt-auto flex min-w-0 items-center justify-between gap-2 pt-1", className)}
    >
      {children}
    </div>
  );
}

export function NeoCardActions({ children }: { children: ReactNode }) {
  return (
    <div data-card-actions="" className="flex shrink-0 items-center gap-2">
      {children}
    </div>
  );
}

/**
 * A table living inside a card scrolls inside the card. The page never grows
 * and the board keeps its row heights.
 */
export function NeoCardTableRegion({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-card-table=""
      className={cn("min-h-0 flex-1 overflow-auto neo-table-scroll", className)}
    >
      {children}
    </div>
  );
}
