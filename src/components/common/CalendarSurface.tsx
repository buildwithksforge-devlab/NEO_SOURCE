/**
 * Shared NEØ date language.
 *
 * Every large calendar in the product — events, marketing, tasks, rates,
 * availability, the room rack — used to size itself against assumptions about
 * the viewport and the sidebar. That is why collapsing the sidebar left dead
 * space on the right, why day cells wrapped, and why toolbars clipped.
 *
 * These primitives size against their CONTAINER (`container-type: inline-size`
 * plus `cqi` units), so a calendar grows the moment the shell gives it room and
 * condenses the moment it does not, with no viewport breakpoints involved and
 * no fixed pixel widths.
 */
import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import {
  Ban,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  MinusCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The shared NEØ day-state language.
 *
 * Availability, the room rack, events, marketing, desk tasks and rates all
 * describe the same four things about a day: it is today, it is the day the
 * operator selected, it can be sold/used, or it cannot. Each state carries an
 * icon AND a label as well as a tint, so the distinction is never made by
 * colour alone, and every surface reads identically.
 */
export type CalendarDayStateKey = "today" | "selected" | "available" | "limited" | "unavailable";

export type CalendarDayStatePresentation = {
  key: CalendarDayStateKey;
  label: string;
  meaning: string;
  icon: ComponentType<{ className?: string }>;
  /** Swatch/foreground classes — semantic tokens only. */
  dot: string;
  text: string;
};

export const CALENDAR_DAY_STATES: Record<CalendarDayStateKey, CalendarDayStatePresentation> = {
  today: {
    key: "today",
    label: "Today",
    meaning: "The property's current business date.",
    icon: CircleDot,
    dot: "bg-primary",
    text: "text-primary",
  },
  selected: {
    key: "selected",
    label: "Selected",
    meaning: "Part of the date range the operator has chosen.",
    icon: CalendarClock,
    dot: "bg-primary/70",
    text: "text-primary",
  },
  available: {
    key: "available",
    label: "Available",
    meaning: "Open for the selected scope — sellable, free or in force.",
    icon: CheckCircle2,
    dot: "bg-success",
    text: "text-success",
  },
  limited: {
    key: "limited",
    label: "Limited",
    meaning: "Partly open — constrained, restricted or nearly full.",
    icon: MinusCircle,
    dot: "bg-warning",
    text: "text-warning",
  },
  unavailable: {
    key: "unavailable",
    label: "Unavailable",
    meaning: "Closed for the selected scope — blocked, occupied or not in force.",
    icon: Ban,
    dot: "bg-destructive",
    text: "text-destructive",
  },
};

/** Icon + label + subtle tint. Never colour alone. */
export function CalendarDayStateBadge({
  state,
  label,
  className,
}: {
  state: CalendarDayStateKey;
  label?: string;
  className?: string;
}) {
  const p = CALENDAR_DAY_STATES[state];
  const Icon = p.icon;
  return (
    <span
      data-day-state={state}
      className={cn(
        "inline-flex min-w-0 items-center gap-1 rounded-full border border-current/25 px-1.5 py-0.5 text-[0.65rem] font-medium",
        p.text,
        className,
      )}
      title={p.meaning}
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{label ?? p.label}</span>
    </span>
  );
}

/** Shared legend so every calendar explains the same states the same way. */
export function CalendarDayLegend({
  states = ["today", "selected", "available", "limited", "unavailable"],
  className,
}: {
  states?: CalendarDayStateKey[];
  className?: string;
}) {
  return (
    <ul
      data-calendar-legend
      aria-label="Day states"
      className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5", className)}
    >
      {states.map((key) => {
        const p = CALENDAR_DAY_STATES[key];
        const Icon = p.icon;
        return (
          <li
            key={key}
            title={p.meaning}
            className="flex min-w-0 items-center gap-1.5 text-[0.7rem] text-muted-foreground"
          >
            <Icon aria-hidden className={cn("size-3.5 shrink-0", p.text)} />
            <span className="truncate">{p.label}</span>
          </li>
        );
      })}
    </ul>
  );
}

export type CalendarCell = {
  /** Stable key; also the ISO date for real days. */
  key: string;
  /** Day number, or null for leading/trailing padding. */
  day: number | null;
  /** Day belongs to a neighbouring month. */
  outside?: boolean;
  today?: boolean;
  selected?: boolean;
  /** Shared availability language for the day. */
  state?: Exclude<CalendarDayStateKey, "today" | "selected">;
  /** Entries for the day. Rendered by the caller, condensed by the grid. */
  content?: ReactNode;
  /** How many entries the day holds — used for the condensed phone view. */
  count?: number;
};


/**
 * Period navigation. A grid rather than a flex row, so the label can shrink
 * and the arrows can never be pushed out of the band; the extra controls
 * (property, date range, view switch) take their own row instead of wrapping
 * on top of the arrows.
 */
export function CalendarToolbar({
  label,
  onPrev,
  onNext,
  onToday,
  prevLabel = "Previous period",
  nextLabel = "Next period",
  children,
  className,
}: {
  label: string;
  onPrev: () => void;
  onNext: () => void;
  onToday?: () => void;
  prevLabel?: string;
  nextLabel?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("neo-cal-toolbar", className)}>
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="outline" size="icon" aria-label={prevLabel} onClick={onPrev}>
          <ChevronLeft className="size-4" />
        </Button>
        <span className="min-w-0 flex-1 truncate text-center text-sm font-medium sm:min-w-36">
          {label}
        </span>
        <Button variant="outline" size="icon" aria-label={nextLabel} onClick={onNext}>
          <ChevronRight className="size-4" />
        </Button>
        {onToday ? (
          <Button variant="ghost" size="sm" onClick={onToday}>
            Today
          </Button>
        ) : null}
      </div>
      {children ? <div className="neo-cal-toolbar-extra">{children}</div> : null}
    </div>
  );
}

/**
 * Month grid.
 *
 * Seven equal `minmax(0, 1fr)` columns so cells share whatever width exists
 * instead of holding a fixed size; row height and gaps scale with container
 * width. Below a narrow container the grid switches to its condensed form:
 * entry detail is replaced by a count, so a phone shows a legible month rather
 * than a squeezed one.
 *
 * Keyboard model — the standard grid pattern, so a month is operable without a
 * pointer:
 *  - one roving tab stop enters the grid (selected day, else today, else the
 *    first real day);
 *  - Arrow keys move by a day or a week, Home/End jump to the start/end of the
 *    week, PageUp/PageDown to the first/last day of the month;
 *  - Enter or Space activates the focused day when the surface accepts a
 *    selection.
 * Padding cells are never focus stops.
 */
export function CalendarMonthGrid({
  cells,
  weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  className,
  ariaLabel = "Month",
  onSelectDay,
}: {
  cells: CalendarCell[];
  weekdays?: string[];
  className?: string;
  ariaLabel?: string;
  /** Called with the cell key when a day is activated by pointer or keyboard. */
  onSelectDay?: (key: string) => void;
}) {
  const focusable = cells.map((c, i) => (c.day === null ? -1 : i)).filter((i) => i >= 0);
  const preferred =
    cells.findIndex((c) => c.selected && c.day !== null) >= 0
      ? cells.findIndex((c) => c.selected && c.day !== null)
      : cells.findIndex((c) => c.today && c.day !== null) >= 0
        ? cells.findIndex((c) => c.today && c.day !== null)
        : (focusable[0] ?? -1);

  const [activeIndex, setActiveIndex] = useState<number>(preferred);
  const gridRef = useRef<HTMLDivElement | null>(null);

  // The roving tab stop follows the selection/today of the CURRENT period; a
  // month change must not strand the tab stop on an index that no longer holds
  // a day.
  useEffect(() => {
    setActiveIndex((current) =>
      current >= 0 && cells[current] && cells[current]?.day !== null ? current : preferred,
    );
  }, [cells, preferred]);

  const moveTo = (index: number) => {
    if (index < 0 || index >= cells.length) return;
    if (cells[index]?.day === null) return;
    setActiveIndex(index);
    const key = cells[index]?.key;
    if (!key) return;
    const node = gridRef.current?.querySelector<HTMLElement>(
      `[data-cell-key="${CSS.escape(key)}"]`,
    );
    node?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, index: number) => {
    const first = focusable[0] ?? 0;
    const last = focusable[focusable.length - 1] ?? 0;
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        moveTo(Math.min(index + 1, last));
        break;
      case "ArrowLeft":
        event.preventDefault();
        moveTo(Math.max(index - 1, first));
        break;
      case "ArrowDown":
        event.preventDefault();
        moveTo(Math.min(index + 7, last));
        break;
      case "ArrowUp":
        event.preventDefault();
        moveTo(Math.max(index - 7, first));
        break;
      case "Home":
        event.preventDefault();
        moveTo(Math.max(index - (index % 7), first));
        break;
      case "End":
        event.preventDefault();
        moveTo(Math.min(index + (6 - (index % 7)), last));
        break;
      case "PageUp":
        event.preventDefault();
        moveTo(first);
        break;
      case "PageDown":
        event.preventDefault();
        moveTo(last);
        break;
      case "Enter":
      case " ":
        if (onSelectDay && cells[index]?.day !== null) {
          event.preventDefault();
          onSelectDay(cells[index]!.key);
        }
        break;
      default:
        break;
    }
  };

  const rows: CalendarCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));

  return (
    <div className={cn("neo-calendar", className)}>
    <div
      ref={gridRef}
      role="grid"
      aria-label={ariaLabel}
      aria-rowcount={rows.length + 1}
      aria-colcount={7}
    >
      <div className="neo-cal-grid neo-cal-weekdays" role="row">
        {weekdays.map((d) => (
          <div key={d} role="columnheader" className="neo-cal-weekday" title={d}>
            <span aria-hidden="true" className="neo-cal-weekday-short">
              {d.slice(0, 1)}
            </span>
            <span className="neo-cal-weekday-long">{d}</span>
          </div>
        ))}
      </div>
      {rows.map((row, rowIndex) => (
        <div key={`row-${rowIndex}`} className="neo-cal-grid" role="row">
          {row.map((cell, columnIndex) => {
            const index = rowIndex * 7 + columnIndex;
            const isDay = cell.day !== null;
            return (
              <div
                key={cell.key}
                role="gridcell"
                data-cell-key={cell.key}
                data-today={cell.today ? "true" : undefined}
                data-selected={cell.selected ? "true" : undefined}
                data-outside={cell.outside ? "true" : undefined}
                data-state={cell.state}
                aria-colindex={columnIndex + 1}
                aria-selected={isDay ? Boolean(cell.selected) : undefined}
                aria-disabled={isDay ? undefined : true}
                tabIndex={isDay ? (index === activeIndex ? 0 : -1) : undefined}
                onKeyDown={isDay ? (event) => onKeyDown(event, index) : undefined}
                onFocus={isDay ? () => setActiveIndex(index) : undefined}
                onClick={
                  isDay && onSelectDay ? () => onSelectDay(cell.key) : undefined
                }
                aria-label={
                  cell.day === null
                    ? undefined
                    : [
                        String(cell.day),
                        cell.today ? CALENDAR_DAY_STATES.today.label : null,
                        cell.selected ? CALENDAR_DAY_STATES.selected.label : null,
                        cell.state ? CALENDAR_DAY_STATES[cell.state].label : null,
                        cell.count ? `${cell.count} entr${cell.count === 1 ? "y" : "ies"}` : null,
                      ]
                        .filter(Boolean)
                        .join(", ")
                }
                className="neo-cal-cell"
              >
                {cell.day === null ? null : (
                  <>
                    <div className="neo-cal-daynum">
                      <span>{cell.day}</span>
                      {cell.count ? (
                        <span className="neo-cal-count" aria-hidden="true">
                          {cell.count}
                        </span>
                      ) : null}
                    </div>
                    <div className="neo-cal-entries">{cell.content}</div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>

      {/*
        Phone fallback. At phone container widths a seven-column grid cannot
        show day entries legibly, so the cells condense to a count — which would
        otherwise put the entry links out of reach. This list carries exactly the
        same entries, one day per row, and is shown only where the grid is
        condensed. Nothing is duplicated visually: only one of the two is ever
        displayed.
      */}
      <ul className="neo-cal-daylist" aria-label={`${ariaLabel} — day entries`}>
        {cells
          .filter((c) => c.day !== null && c.content)
          .map((c) => (
            <li key={`list-${c.key}`} className="neo-cal-daylist-row">
              <p className="neo-cal-daylist-day">
                {c.key}
                {c.today ? " · Today" : ""}
              </p>
              <div className="neo-cal-daylist-entries">{c.content}</div>
            </li>
          ))}
      </ul>
    </div>
  );
}



/**
 * A date matrix (rooms × dates, rate plans × dates).
 *
 * The row label column is sticky and the date columns are `minmax(col-min,
 * 1fr)`, so the matrix fills the container when it can and scrolls
 * horizontally only inside itself when it genuinely cannot fit — the page
 * never gains a horizontal scrollbar because of it.
 */
export function CalendarMatrix({
  columns,
  labelWidth = "9rem",
  columnMin = "4.5rem",
  className,
  children,
  ariaLabel,
}: {
  columns: number;
  labelWidth?: string;
  columnMin?: string;
  className?: string;
  children: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <div className={cn("neo-matrix", className)} aria-label={ariaLabel}>
      <div
        className="neo-matrix-grid"
        style={
          {
            "--neo-matrix-cols": String(columns),
            "--neo-matrix-label": labelWidth,
            "--neo-matrix-col-min": columnMin,
          } as React.CSSProperties
        }
      >
        {children}
      </div>
    </div>
  );
}

/** Builds the padded month cells for a UTC month. */
export function monthCells(
  year: number,
  month: number,
  opts: { weekStartsOn?: 0 | 1; today?: string } = {},
): CalendarCell[] {
  const weekStartsOn = opts.weekStartsOn ?? 0;
  const first = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const lead = (first.getUTCDay() - weekStartsOn + 7) % 7;
  const cells: CalendarCell[] = [];
  for (let i = 0; i < lead; i += 1) cells.push({ key: `pad-${i}`, day: null });
  for (let d = 1; d <= daysInMonth; d += 1) {
    const iso = new Date(Date.UTC(year, month, d)).toISOString().slice(0, 10);
    cells.push({ key: iso, day: d, today: opts.today === iso });
  }
  while (cells.length % 7 !== 0) cells.push({ key: `tail-${cells.length}`, day: null });
  return cells;
}

/**
 * Month-transition placeholder.
 *
 * A month change, a week change or a toolbar/selection change refetches; the
 * skeleton reserves exactly the geometry of the real grid (same container
 * query, same seven columns, same cell height), so the page cannot shake while
 * the new period loads.
 */
export function CalendarMonthSkeleton({
  weeks = 6,
  className,
}: {
  weeks?: number;
  className?: string;
}) {
  return (
    <div
      data-skeleton="calendar-month"
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn("neo-calendar", className)}
    >
      <span className="sr-only">Loading calendar</span>
      <div className="neo-cal-grid neo-cal-weekdays" aria-hidden>
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="mx-auto h-3 w-8 rounded" />
        ))}
      </div>
      <div className="neo-cal-grid" aria-hidden>
        {Array.from({ length: weeks * 7 }).map((_, i) => (
          <div key={i} className="neo-cal-cell">
            <Skeleton className="h-3 w-5 rounded" />
            <div className="neo-cal-entries">
              <Skeleton className="h-4 w-full rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Toolbar placeholder used while a selection or scope change resolves. */
export function CalendarToolbarSkeleton({ className }: { className?: string }) {
  return (
    <div
      data-skeleton="calendar-toolbar"
      aria-hidden
      className={cn("neo-cal-toolbar", className)}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Skeleton className="size-9 shrink-0 rounded-xl" />
        <Skeleton className="h-4 w-36 rounded" />
        <Skeleton className="size-9 shrink-0 rounded-xl" />
      </div>
    </div>
  );
}

/** Matrix placeholder (rooms × dates, rate plans × dates). */
export function CalendarMatrixSkeleton({
  rows = 6,
  columns = 7,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <CalendarMatrix columns={columns} {...(className ? { className } : {})} ariaLabel="Loading matrix">
      {Array.from({ length: (rows + 1) * (columns + 1) }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full rounded" />
      ))}
    </CalendarMatrix>
  );
}
