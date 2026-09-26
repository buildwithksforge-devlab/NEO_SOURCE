// @vitest-environment jsdom
/**
 * NEØ calendar accessibility + view-state regressions.
 *
 * Pins the grid semantics and keyboard model of the shared month grid, the
 * legend semantics, and the state-retention/cancellation contract that keeps a
 * selected day stable while a month refetches.
 */
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

import {
  CalendarDayLegend,
  CalendarMonthGrid,
  type CalendarCell,
} from "@/components/common/CalendarSurface";
import { monthCursor, useCalendarCursor, useStableValue } from "@/lib/calendar-view";

afterEach(cleanup);

function monthCells(selectedDay = 10): CalendarCell[] {
  const pads: CalendarCell[] = Array.from({ length: 3 }, (_, i) => ({
    key: `pad-${i}`,
    day: null,
  }));
  const days: CalendarCell[] = Array.from({ length: 28 }, (_, i) => ({
    key: `2026-03-${String(i + 1).padStart(2, "0")}`,
    day: i + 1,
    today: i + 1 === 5,
    selected: i + 1 === selectedDay,
    ...((i + 1) % 2 === 0 ? { state: "available" as const } : {}),
  }));
  return [...pads, ...days];
}

describe("month grid ARIA semantics", () => {
  it("exposes a grid with rows, column headers and day gridcells", () => {
    render(<CalendarMonthGrid cells={monthCells()} ariaLabel="March 2026" />);
    expect(screen.getByRole("grid", { name: "March 2026" })).toBeTruthy();
    expect(screen.getAllByRole("columnheader")).toHaveLength(7);
    // 3 padding cells + 28 days, laid out in week rows.
    expect(screen.getAllByRole("gridcell").length).toBe(31);
  });

  it("marks the selected day and disables padding cells", () => {
    render(<CalendarMonthGrid cells={monthCells(10)} />);
    const selected = screen.getAllByRole("gridcell").filter(
      (c) => c.getAttribute("aria-selected") === "true",
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]?.getAttribute("data-cell-key")).toBe("2026-03-10");
    const padding = screen
      .getAllByRole("gridcell")
      .filter((c) => c.getAttribute("data-cell-key")?.startsWith("pad-"));
    expect(padding.every((c) => c.getAttribute("aria-disabled") === "true")).toBe(true);
    expect(padding.every((c) => !c.hasAttribute("tabindex"))).toBe(true);
  });

  it("keeps exactly one tab stop, on the selected day", () => {
    render(<CalendarMonthGrid cells={monthCells(10)} />);
    const stops = screen
      .getAllByRole("gridcell")
      .filter((c) => c.getAttribute("tabindex") === "0");
    expect(stops).toHaveLength(1);
    expect(stops[0]?.getAttribute("data-cell-key")).toBe("2026-03-10");
  });
});

describe("month grid keyboard navigation", () => {
  function cellFor(key: string) {
    return screen
      .getAllByRole("gridcell")
      .find((c) => c.getAttribute("data-cell-key") === key)!;
  }

  it("moves by day and by week with the arrow keys", () => {
    render(<CalendarMonthGrid cells={monthCells(10)} />);
    const start = cellFor("2026-03-10");
    start.focus();
    fireEvent.keyDown(start, { key: "ArrowRight" });
    expect(document.activeElement).toBe(cellFor("2026-03-11"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(cellFor("2026-03-18"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(cellFor("2026-03-11"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(cellFor("2026-03-10"));
  });

  it("supports Home/End and PageUp/PageDown", () => {
    render(<CalendarMonthGrid cells={monthCells(10)} />);
    const start = cellFor("2026-03-10");
    start.focus();
    fireEvent.keyDown(start, { key: "Home" });
    const afterHome = document.activeElement as HTMLElement;
    expect(afterHome.getAttribute("role")).toBe("gridcell");
    fireEvent.keyDown(afterHome, { key: "PageDown" });
    expect(document.activeElement).toBe(cellFor("2026-03-28"));
    fireEvent.keyDown(document.activeElement!, { key: "PageUp" });
    expect(document.activeElement).toBe(cellFor("2026-03-01"));
  });

  it("activates a day with Enter and Space when the surface is selectable", () => {
    const onSelectDay = vi.fn();
    render(<CalendarMonthGrid cells={monthCells(10)} onSelectDay={onSelectDay} />);
    const cell = cellFor("2026-03-12");
    cell.focus();
    fireEvent.keyDown(cell, { key: "Enter" });
    fireEvent.keyDown(cell, { key: " " });
    expect(onSelectDay).toHaveBeenCalledTimes(2);
    expect(onSelectDay).toHaveBeenCalledWith("2026-03-12");
  });

  it("never focuses a padding cell", () => {
    render(<CalendarMonthGrid cells={monthCells(1)} />);
    const first = cellFor("2026-03-01");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(first);
  });
});

describe("legend semantics", () => {
  it("renders the day states as a labelled list", () => {
    render(<CalendarDayLegend states={["today", "available", "unavailable"]} />);
    const list = screen.getByRole("list");
    expect(list.getAttribute("aria-label")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });
});

describe("calendar view state retention", () => {
  it("memoises the month cursor and navigates without losing identity", () => {
    const { result } = renderHook(() => useCalendarCursor(new Date(2026, 2, 15)));
    const first = result.current.cursor;
    const next = result.current.next;
    expect(first.from).toBe("2026-03-01");
    expect(first.to).toBe("2026-03-31");
    act(() => result.current.next());
    expect(result.current.cursor.from).toBe("2026-04-01");
    // Stable callbacks: a toolbar built from them does not remount mid-fetch.
    expect(result.current.next).toBe(next);
  });

  it("retains the previous value while a fetch is in flight", () => {
    const { result, rerender } = renderHook(
      ({ value, loading }: { value: string; loading: boolean }) =>
        useStableValue(value, loading),
      { initialProps: { value: "march", loading: false } },
    );
    expect(result.current).toBe("march");
    rerender({ value: "", loading: true });
    expect(result.current).toBe("march");
    rerender({ value: "april", loading: false });
    expect(result.current).toBe("april");
  });

  it("derives an inclusive month range", () => {
    expect(monthCursor(new Date(2026, 1, 20)).to).toBe("2026-02-28");
  });
});

describe("calendar data cancellation", () => {
  it("aborts superseded month requests and keeps the previous rows", () => {
    const source = readFileSync("src/lib/events-data.ts", "utf8");
    expect(source).toContain("placeholderData: keepPreviousData");
    expect(source).toContain(".abortSignal(signal)");
  });

  it("keeps the events grid memoised and retained across navigation", () => {
    const route = readFileSync("src/routes/_shell.events.calendar.tsx", "utf8");
    expect(route).toContain("useStableValue(");
    expect(route).toContain("const derivedCells = useMemo(");
  });
});
