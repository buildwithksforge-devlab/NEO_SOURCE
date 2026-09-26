/**
 * Catalogue Workspace — the composed alternative to "filter bar + wide table"
 * for pages whose subject is a set of real objects (menu items, rooms,
 * recipes, stock items, suppliers, lost property).
 *
 * Structure: a taxonomy rail on the left, one compact query bar, and an
 * image/identity-led list grouped by the object's own structure. Filters
 * collapse behind a single control so work — not chrome — occupies the first
 * screen.
 */
import { useState, type ReactNode } from "react";
import { ChevronRight, Search, SlidersHorizontal, X } from "lucide-react";

import { TONE_BORDER, TONE_TINT, type Tone } from "@/lib/tone";


import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export type RailItem = {
  id: string;
  label: string;
  count?: number;
  hint?: string;
};

/**
 * The object taxonomy. Persistent column on laptop, icon-free scrollable chip
 * row on phone — same data, same selection state.
 */
export function CatalogueRail({
  title,
  items,
  value,
  onChange,
  allLabel = "All",
  allCount,
  footer,
}: {
  title: string;
  items: RailItem[];
  value: string;
  onChange: (id: string) => void;
  allLabel?: string;
  allCount?: number;
  footer?: ReactNode;
}) {
  const [railQuery, setRailQuery] = useState("");
  const q = railQuery.trim().toLowerCase();
  const matching = q ? items.filter((i) => i.label.toLowerCase().includes(q)) : items;

  const entries: RailItem[] = [
    { id: "all", label: allLabel, ...(allCount === undefined ? {} : { count: allCount }) },
    ...matching,
  ];

  /** Long taxonomies need their own finder, or the rail becomes a scroll. */
  const showRailFinder = items.length > 8;

  return (
    <>
      {/* Phone / small tablet: horizontal chip row. */}
      <div className="neo-scroll-x -mx-1 flex gap-1.5 px-1 pb-1 lg:hidden">
        {entries.map((e) => (
          <button
            key={e.id}
            type="button"
            data-touch-target
            onClick={() => onChange(e.id)}
            aria-pressed={value === e.id}
            className={cn(
              "shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-sm transition-colors",
              value === e.id
                ? "bg-chip-selected text-chip-selected-foreground"
                : "text-muted-foreground hover:bg-muted/60",
            )}
          >
            {e.label}
            {typeof e.count === "number" ? (
              <span className="ml-1.5 text-xs tabular-nums opacity-70">{e.count}</span>
            ) : null}
          </button>
        ))}
      </div>

      {/* Laptop: persistent rail. */}
      <nav aria-label={title} className="hidden min-w-0 lg:block">
        <p className="mb-2 px-2 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {title}
        </p>
        {showRailFinder ? (
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={railQuery}
              onChange={(e) => setRailQuery(e.target.value)}
              placeholder={`Find in ${title.toLowerCase()}`}
              aria-label={`Find in ${title.toLowerCase()}`}
              className="h-8 pl-8 text-xs"
            />
          </div>
        ) : null}
        <ul className="space-y-0.5">
          {entries.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => onChange(e.id)}
                aria-current={value === e.id ? "true" : undefined}
                className={cn(
                  "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                  value === e.id
                    ? "bg-chip-selected text-chip-selected-foreground"
                    : "text-foreground hover:bg-muted/60",
                )}
              >
                <span className="min-w-0">
                  <span className="neo-line-1 block">{e.label}</span>
                  {e.hint ? (
                    <span className="neo-line-1 block text-xs text-muted-foreground">{e.hint}</span>
                  ) : null}
                </span>
                {typeof e.count === "number" ? (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {e.count}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
        {showRailFinder && matching.length === 0 ? (
          <p className="px-2.5 py-2 text-xs text-muted-foreground">Nothing matches that.</p>
        ) : null}
        {footer ? <div className="mt-3 px-2">{footer}</div> : null}
      </nav>
    </>
  );
}

export type ActiveFilterChip = { id: string; label: string; onClear: () => void };

/**
 * One search field, one Filters control, and a chip row showing exactly what
 * is currently narrowing the list. Selects live inside the popover.
 */
export function CatalogueQueryBar({
  search,
  onSearch,
  placeholder = "Search",
  filters,
  activeFilters,
  onClearAll,
  actions,
}: {
  search: string;
  onSearch: (value: string) => void;
  placeholder?: string | undefined;
  /** Filter controls, rendered inside the Filters popover. */
  filters?: ReactNode | undefined;
  activeFilters?: ActiveFilterChip[] | undefined;
  onClearAll?: (() => void) | undefined;
  actions?: ReactNode;
}) {
  const active = activeFilters ?? [];

  return (
    <div className="mb-3 min-w-0 space-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            className="pl-9"
          />
        </div>
        {filters ? (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" data-touch-target>
                <SlidersHorizontal className="size-4" />
                Filters
                {active.length ? (
                  <Badge variant="secondary" className="ml-1 tabular-nums">
                    {active.length}
                  </Badge>
                ) : null}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[min(22rem,90vw)] space-y-3">
              {filters}
            </PopoverContent>
          </Popover>
        ) : null}
        {actions ? (
          <div data-action-cluster className="flex flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
      </div>

      {active.length ? (
        <div className="neo-scroll-x flex items-center gap-1.5 pb-0.5">
          {active.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={f.onClear}
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs text-foreground hover:bg-muted/70"
            >
              {f.label}
              <X className="size-3" />
            </button>
          ))}
          {onClearAll ? (
            <Button variant="ghost" size="sm" onClick={onClearAll}>
              Clear all
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Rail + body two-pane frame. Collapses to a single column below `lg`. */
export function CatalogueWorkspace({
  rail,
  children,
  className,
}: {
  rail?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid min-w-0 gap-4",
        rail ? "lg:grid-cols-[minmax(11rem,15rem)_minmax(0,1fr)] lg:gap-6" : "",
        className,
      )}
    >
      {rail ? <div className="min-w-0">{rail}</div> : null}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Sticky group header inside a catalogue list. Typography, not a card. */
export function CatalogueGroup({
  label,
  count,
  children,
}: {
  label: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="mb-5 min-w-0 last:mb-0">
      <div className="sticky top-0 z-10 mb-2 flex items-baseline gap-2 border-b border-outline-subtle bg-background/95 py-1.5 backdrop-blur">
        <h3 className="neo-line-1 text-sm font-semibold text-foreground">{label}</h3>
        {typeof count === "number" ? (
          <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
            {count}
          </span>
        ) : null}
      </div>
      <ul className="space-y-1.5">{children}</ul>
    </section>
  );
}

/**
 * One object in the catalogue: media, identity, state chips, a trailing figure
 * and optional inline controls.
 *
 * The row is a contained tile rather than a bare table line: a tinted accent
 * edge carries the object's state, the identity block sits on a raised
 * surface, and the trailing figure is printed as a figure with its own
 * caption. That is what turns a long, flat list into something scannable.
 */
export function CatalogueRow({
  media,
  monogram,
  title,
  subtitle,
  chips,
  trailing,
  trailingLabel,
  actions,
  onOpen,
  selected,
  accent = "default",
}: {
  media?: ReactNode;
  /** Fallback identity mark when there is no image: initials or a number. */
  monogram?: string;
  title: string;
  subtitle?: ReactNode;
  chips?: ReactNode;
  trailing?: ReactNode;
  /** Quiet caption printed under the trailing figure. */
  trailingLabel?: string;
  actions?: ReactNode;
  onOpen?: () => void;
  selected?: boolean;
  /** State colour for the leading edge — the list's fastest signal. */
  accent?: Tone;
}) {
  const lead = media ?? (monogram ? <RowMonogram text={monogram} accent={accent} /> : null);

  return (
    <li
      className={cn(
        "group relative grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 overflow-hidden rounded-xl border pl-2.5 pr-2.5 transition-all",
        selected
          ? "border-primary/40 bg-chip-selected/40 shadow-sm"
          : cn("bg-card/60 hover:bg-muted/40 hover:shadow-sm", TONE_BORDER[accent]),
      )}
    >
      {/* Accent edge: state read before a single word is. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-1",
          accent === "default" ? (selected ? "bg-primary/60" : "bg-transparent") : ACCENT_BAR[accent],
        )}
      />
      <button
        type="button"
        data-touch-target
        onClick={onOpen}
        disabled={!onOpen}
        className={cn(
          "flex min-w-0 items-center gap-3 rounded-lg py-2.5 pl-1.5 pr-1 text-left",
          onOpen
            ? "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            : "cursor-default",
        )}
      >
        {lead ? <span className="shrink-0">{lead}</span> : null}
        <span className="min-w-0">
          <span className="neo-line-1 block text-sm font-semibold text-foreground">{title}</span>
          {subtitle ? (
            <span className="neo-line-1 mt-0.5 block text-xs text-muted-foreground">{subtitle}</span>
          ) : null}
          {chips ? <span className="mt-1.5 flex flex-wrap items-center gap-1.5">{chips}</span> : null}
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-2 py-2">
        {trailing ? (
          <span className="text-right">
            <span className="neo-atomic block text-sm font-semibold tabular-nums">{trailing}</span>
            {trailingLabel ? (
              <span className="block text-[0.65rem] uppercase tracking-[0.12em] text-muted-foreground">
                {trailingLabel}
              </span>
            ) : null}
          </span>
        ) : null}
        {actions}
        {onOpen && !actions ? (
          <ChevronRight
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5"
          />
        ) : null}
      </div>
    </li>
  );
}

const ACCENT_BAR: Record<Tone, string> = {
  default: "bg-border",
  accent: "bg-accent/70",
  success: "bg-success/70",
  warning: "bg-warning/80",
  info: "bg-info/70",
  destructive: "bg-destructive/70",
};

function RowMonogram({ text, accent }: { text: string; accent: Tone }) {
  return (
    <span
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-xl text-xs font-semibold uppercase tracking-wide",
        TONE_TINT[accent],
      )}
    >
      {text.slice(0, 3)}
    </span>
  );
}

