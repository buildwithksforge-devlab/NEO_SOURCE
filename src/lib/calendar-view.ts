/**
 * Shared calendar view state.
 *
 * Every NEØ calendar surface (Availability, Room Rack, Events, Marketing, Desk
 * Tasks, Rates) navigates by month or week and refetches while it does. Two
 * defects come from doing that naively:
 *
 *  1. the grid is rebuilt on every render, so a rapid Next/Prev sequence
 *     re-derives cells repeatedly and the selected day-state flickers;
 *  2. the surface renders an empty month between the navigation and the new
 *     rows arriving, so the layout shakes and the selection appears lost.
 *
 * `useCalendarCursor` memoises the cursor and its derived label/bounds, and
 * `useStableCells` retains the last resolved grid while a fetch is in flight,
 * so the day-state a user selected stays visible until real data replaces it.
 *
 * Data cancellation itself belongs to the query layer (`signal` +
 * `keepPreviousData`); this module only keeps the view honest.
 */
import { useCallback, useMemo, useRef, useState } from "react";

export type CalendarCursor = {
  /** First day of the visible month, normalised to midnight local time. */
  monthStart: Date;
  /** Inclusive first date of the visible range, `YYYY-MM-DD`. */
  from: string;
  /** Inclusive last date of the visible range, `YYYY-MM-DD`. */
  to: string;
  /** Human label, e.g. "March 2026". */
  label: string;
};

function iso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function monthCursor(anchor: Date): CalendarCursor {
  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const monthEnd = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  return {
    monthStart,
    from: iso(monthStart),
    to: iso(monthEnd),
    label: monthStart.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
  };
}

/**
 * Memoised month cursor with stable navigation callbacks.
 *
 * The callbacks keep their identity across renders, so a toolbar built from
 * them does not remount while data loads.
 */
export function useCalendarCursor(initial?: Date) {
  const [anchor, setAnchor] = useState<Date>(() => initial ?? new Date());

  const cursor = useMemo(() => monthCursor(anchor), [anchor]);

  const next = useCallback(
    () => setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + 1, 1)),
    [],
  );
  const previous = useCallback(
    () => setAnchor((a) => new Date(a.getFullYear(), a.getMonth() - 1, 1)),
    [],
  );
  const today = useCallback(() => setAnchor(new Date()), []);

  return { cursor, anchor, setAnchor, next, previous, today } as const;
}

/**
 * Retain the last resolved value while a fetch is in flight.
 *
 * Used for calendar cells and row collections: during a month or toolbar
 * change the previous grid remains on screen (paired with a subtle skeleton by
 * the caller) instead of collapsing to an empty month.
 */
export function useStableValue<T>(value: T, isLoading: boolean): T {
  const retained = useRef<T>(value);
  if (!isLoading) retained.current = value;
  return isLoading ? retained.current : value;
}
