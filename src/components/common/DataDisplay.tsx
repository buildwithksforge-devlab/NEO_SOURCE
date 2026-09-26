import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";

import { ChevronRight, MoreHorizontal } from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TONE_BORDER, TONE_RING, TONE_TINT, TONE_TINT_SURFACE, type Tone } from "@/lib/tone";

/**
 * The header every staff page uses.
 *
 * It is a designed band rather than a bare heading: the tenant's brand wash
 * and rail come from theme tokens (never a hardcoded tenant colour), the icon
 * sits in a brand well, the title sizes fluidly instead of wrapping into three
 * lines on a phone, and the action cluster scrolls inside the band instead of
 * spilling past it.
 */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  icon: Icon,
  meta,
  plain = false,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  eyebrow?: string;
  /** Module glyph shown in a brand-tinted well. */
  icon?: LucideIcon;
  /** Small contextual chips (scope, period, counts) under the description. */
  meta?: ReactNode;
  /** Opt out of the hero band for embedded/print contexts. */
  plain?: boolean;
}) {
  return (
    <div
      className={cn(
        "mb-5 grid min-w-0 grid-cols-[minmax(0,1fr)] items-start gap-3 overflow-hidden sm:mb-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:gap-4",
        plain ? "" : "neo-page-hero",
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        {Icon && !plain ? (
          <span className="neo-icon-well size-10 sm:size-11">
            <Icon className="size-5" />
          </span>
        ) : null}
        <div className="min-w-0">
          {eyebrow ? (
            <p className="neo-line-1 mb-1 text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="neo-title-fluid font-semibold text-foreground">{title}</h1>
          {description ? (
            <p className="neo-contain mt-1.5 max-w-2xl text-sm text-muted-foreground">
              {description}
            </p>
          ) : null}
          {meta ? (
            <div className="neo-scroll-x mt-2.5 flex items-center gap-2 pb-0.5">{meta}</div>
          ) : null}
        </div>
      </div>
      {actions ? (
        /* Toolbar actions wrap on tablet and scroll on a phone rather than
           compressing into unreadable, mis-tappable buttons. */
        <div
          data-action-cluster
          className="neo-scroll-x -mx-1 flex min-w-0 max-w-full shrink-0 items-center gap-2 px-1 pb-0.5 sm:mx-0 sm:flex-wrap sm:px-0"
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}


/**
 * A section title inside a page: typography and a hairline rule, never a
 * filled capsule. Real actions sit to the right so headings stay information.
 */
export function SectionHeading({
  title,
  description,
  actions,
  divider = true,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  divider?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-4 flex flex-wrap items-end justify-between gap-3 pb-2",
        divider ? "border-b border-outline-subtle" : "",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div data-action-cluster className="flex flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/** Lighter hierarchy beneath a SectionHeading. */
export function SubsectionHeading({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-2 flex flex-wrap items-baseline justify-between gap-2", className)}>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {actions}
    </div>
  );
}


/**
 * A fluid metric grid: columns are derived from the width available rather
 * than fixed breakpoint counts, so phone, iPad portrait, iPad landscape and
 * desktop each get a deliberate number of columns.
 */
export function MetricGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("neo-metric-grid", className)}>{children}</div>;
}

/**
 * The smallest unit of the card system: label → figure → supporting context.
 * The figure scales with the viewport (clamp) instead of overflowing, and the
 * whole tile is tappable when navigation is its only action.
 */
export function MetricTile({
  label,
  value,
  hint,
  tone = "default",
  icon: Icon,
  to,
  onClick,
  className,
  dense,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  icon?: LucideIcon;
  to?: string;
  onClick?: () => void;
  className?: string;
  dense?: boolean;
}) {
  const body = (
    <>
      <div className="flex min-w-0 items-start justify-between gap-2">
        <p
          className="neo-line-1 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
          title={label}
        >
          {label}
        </p>
        {Icon ? (
          <span className={cn("shrink-0 rounded-lg p-1.5", TONE_RING[tone])}>
            <Icon className="size-4" />
          </span>
        ) : null}
      </div>
      <p
        className={cn(
          "mt-2 text-foreground",
          dense ? "neo-metric-value-sm" : "neo-metric-value",
        )}
      >
        {value}
      </p>
      {hint ? (
        <p className="mt-1.5 text-xs leading-snug text-muted-foreground">{hint}</p>
      ) : null}
    </>
  );

  const shell = cn(
    "surface-quiet neo-card-pad neo-metric-card flex min-w-0 flex-col",
    to || onClick
      ? "neo-card-interactive cursor-pointer text-left active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      : "",
    className,
  );

  if (to) {
    return (
      <Link data-touch-target to={to} className={shell}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={shell}>
        {body}
      </button>
    );
  }
  return <div className={shell}>{body}</div>;
}

/**
 * Wrapper for wide tables and charts: the region scrolls itself so the page
 * never gains a horizontal scrollbar on a phone.
 */
export function TableScroll({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("neo-table-scroll -mx-1 px-1", className)}>{children}</div>;
}

/**
 * The KPI card every module landing page uses.
 *
 * It is deliberately not a white rectangle: the icon sits in a toned well, a
 * lead card carries the tenant's brand wash, and a toned card carries a
 * restrained tint of its own semantic colour. Label and figure stay on one
 * line — a short KPI title never wraps word by word.
 */
export function StatCard({
  label,
  value,
  hint,
  delta,
  icon: Icon,
  tone = "default",
  lead = false,
  className,
  to,
  params,
  search,
  onClick,
  actionLabel,
}: {
  label: string;
  value: string;
  hint?: string;
  delta?: string;
  icon?: LucideIcon;
  tone?: Tone;
  /** Marks the headline metric of a group: brand wash and a firmer edge. */
  lead?: boolean;
  className?: string;
  /** Where the figure leads. A metric that has a record behind it is a door. */
  to?: string;
  params?: Record<string, string>;
  search?: Record<string, unknown>;
  /** In-page action (filter, sort, lens) when the figure does not navigate. */
  onClick?: () => void;
  /** Overrides the affordance caption ("View", "Filter"). */
  actionLabel?: string;
}) {
  const toneRing = TONE_RING[tone];
  const interactive = Boolean(to || onClick);

  const card = (
    <Card
      /* neo-metric-card makes this an inline-size container, so the figure is
         sized by the card it lives in rather than by the viewport: a laptop
         gets more cards, not billboard numbers. */
      className={cn(
        "neo-card-interactive neo-metric-card h-full gap-0 overflow-hidden py-3.5 sm:py-4",
        lead
          ? "neo-card-lead border"
          : tone === "default"
            ? "surface-raised"
            : cn("surface-raised border", TONE_BORDER[tone], TONE_TINT_SURFACE[tone]),
        interactive &&
          "cursor-pointer transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md",
        className,
      )}
    >
      <CardContent className="neo-card-pad !pt-0">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
          {/* Label is the quietest line, the figure is the loudest, context recedes. */}
          <p
            className="neo-line-1 text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
            title={label}
          >
            {label}
          </p>
          {Icon ? (
            <span className={cn("shrink-0 rounded-xl p-2", lead ? TONE_RING["default"] : toneRing)}>
              <Icon className="size-4" />
            </span>
          ) : null}
        </div>
        <p
          className={cn(
            "neo-metric-value neo-line-1 mt-2 text-foreground",
            lead && "neo-metric-value-lead",
          )}
          title={value}
        >
          {value}
        </p>

        {delta || hint ? (
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
            {delta ? <Badge variant="success">{delta}</Badge> : null}
            {hint ? (
              <span className="min-w-0 text-xs leading-snug text-muted-foreground/90">{hint}</span>
            ) : null}
          </div>
        ) : null}

        {interactive ? (
          <span className="mt-2.5 inline-flex items-center gap-1 text-xs font-medium text-primary">
            {actionLabel ?? (to ? "Open" : "Filter")}
            <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        ) : null}
      </CardContent>
    </Card>
  );

  if (to) {
    return (
      <Link
        to={to}
        {...(params ? { params } : {})}
        {...(search ? { search } : {})}
        aria-label={`${label}: ${value}`}
        className="group block min-w-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {card}
      </Link>
    );
  }

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={`${label}: ${value}`}
        className="group block min-w-0 rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {card}
      </button>
    );
  }

  return card;
}




/**
 * `primary` — the main panel of a section (raised surface, clear border).
 * `quiet`   — supporting content that must not compete (tinted, no shadow).
 */
export type SectionCardTone = "primary" | "quiet";

export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
  tone = "primary",
  icon: Icon,
  accent = false,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  tone?: SectionCardTone;
  /** Optional glyph in a brand well, so a panel is not just a titled box. */
  icon?: LucideIcon;
  /** Marks the primary panel of a page with a brand-tinted header wash. */
  accent?: boolean;
}) {
  return (
    <Card
      className={cn(
        tone === "quiet" ? "surface-quiet shadow-none" : "surface-panel",
        "gap-0 overflow-hidden",
        accent && "neo-chart-card border",
        className,
      )}
    >
      <CardHeader className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 pb-3 sm:pb-4">
        <div className="flex min-w-0 items-start gap-2.5">
          {Icon ? (
            <span className="neo-icon-well size-8">
              <Icon className="size-4" />
            </span>
          ) : null}
          <div className="min-w-0">
            <CardTitle
              title={title}
              className={cn(
                "neo-line-1 font-semibold tracking-tight",
                tone === "quiet" ? "text-sm text-muted-foreground" : "text-base",
              )}
            >
              {title}
            </CardTitle>
            {description ? (
              <p className="neo-contain mt-1 text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
        </div>
        {actions ? (
          <div
            data-action-cluster
            className="neo-row-actions flex-wrap justify-end sm:flex-nowrap"
          >
            {actions}
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="min-w-0">{children}</CardContent>
    </Card>
  );
}


/**
 * A recessed region inside a card — use instead of nesting another Card so a
 * section never reads as card-inside-card.
 */
export function InsetPanel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("surface-inset p-4", className)}>{children}</div>;
}


export function StatusPill({ children, tone = "default" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium",
        TONE_TINT[tone],
      )}
    >
      {children}
    </span>
  );
}

/**
 * A record or card title that keeps to one line. The full text stays
 * available to a pointer and to assistive technology, so an ellipsis never
 * hides information — the alternative (word-by-word wrapping) is worse.
 */
export function RecordTitle({
  children,
  className,
  as: Tag = "span",
  title,
}: {
  children: string;
  className?: string;
  as?: "span" | "p" | "h3" | "h4";
  title?: string;
}) {
  return (
    <Tag className={cn("neo-line-1", className)} title={title ?? children} aria-label={title ?? children}>
      {children}
    </Tag>
  );
}

/**
 * Money, IDs, room numbers, dates and counts: never broken across lines and
 * always aligned on the decimal.
 */
export function Atomic({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("neo-atomic", className)}>{children}</span>;
}

/** Row actions stay inside their row and scroll instead of stacking. */
export function RowActions({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-action-cluster className={cn("neo-row-actions neo-scroll-x", className)}>
      {children}
    </div>
  );
}


export type SecondaryAction = {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
};

/**
 * Row actions that stay usable on a phone.
 *
 * The primary action is always visible. Secondary actions render inline on
 * wide screens and collapse into a compact overflow menu on narrow ones, so a
 * row never grows a horizontal scrollbar or pushes buttons outside its card.
 */
export function ResponsiveRowActions({
  primary,
  secondary = [],
  className,
}: {
  primary?: ReactNode;
  secondary?: SecondaryAction[];
  className?: string;
}) {
  return (
    <div data-action-cluster className={cn("neo-row-actions", className)}>
      {primary}
      {secondary.length > 0 ? (
        <>
          <span className="hidden items-center gap-1 md:inline-flex">
            {secondary.map((a) => (
              <Button
                key={a.label}
                size="sm"
                variant="ghost"
                disabled={a.disabled ?? false}
                className={cn(a.destructive && "text-destructive")}
                onClick={a.onSelect}
              >
                {a.label}
              </Button>
            ))}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild className="md:hidden">
              <Button
                size="icon"
                variant="ghost"
                className="size-11"
                aria-label="More actions"
                data-overflow-actions
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {secondary.map((a) => (
                <DropdownMenuItem
                  key={a.label}
                  disabled={a.disabled ?? false}
                  onSelect={a.onSelect}
                  className={cn(a.destructive && "text-destructive")}
                >
                  {a.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : null}
    </div>
  );
}
