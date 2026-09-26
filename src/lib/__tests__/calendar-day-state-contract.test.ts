/**
 * The NEØ day-state language is shared, not per-page.
 *
 * Every date surface — availability, the room rack, events, marketing, desk
 * tasks and rates — describes a day with the SAME icon + label + tint, and
 * never by colour alone. Secondary detail moves into an inspector rather than
 * overflowing a cell, and period changes reserve geometry with a skeleton so
 * the page cannot shake while data loads.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CALENDAR_DAY_STATES, type CalendarDayStateKey } from "@/components/common/CalendarSurface";

const read = (p: string) => readFileSync(p, "utf8");

const DATE_SURFACES = [
  "src/components/pms/AvailabilitySearchPage.tsx",
  "src/routes/_shell.pms.rack.tsx",
  "src/routes/_shell.events.calendar.tsx",
  "src/routes/_shell.marketing.calendar.tsx",
  "src/routes/_shell.tasks.tsx",
  "src/routes/_shell.rates.tsx",
];

describe("shared calendar day states", () => {
  it("defines every state with an icon and a label, never colour alone", () => {
    const keys: CalendarDayStateKey[] = [
      "today",
      "selected",
      "available",
      "limited",
      "unavailable",
    ];
    for (const key of keys) {
      const p = CALENDAR_DAY_STATES[key];
      expect(p.key, key).toBe(key);
      expect(p.label.length, key).toBeGreaterThan(0);
      expect(p.meaning.length, key).toBeGreaterThan(0);
      expect(p.icon, key).toBeTruthy();
      expect(p.text, key).toMatch(/^text-/);
    }
    const labels = new Set(Object.values(CALENDAR_DAY_STATES).map((p) => p.label));
    expect(labels.size).toBe(5);
  });

  it("is used by every date surface", () => {
    for (const file of DATE_SURFACES) {
      expect(read(file), file).toContain("@/components/common/CalendarSurface");
      expect(read(file), file).toContain("CalendarDayLegend");
    }
  });

  it("styles day states with design tokens, not raw or legacy colour syntax", () => {
    const css = read("src/styles.css");
    expect(css).toContain('.neo-cal-cell[data-state="available"]');
    expect(css).toContain('.neo-cal-cell[data-state="limited"]');
    expect(css).toContain('.neo-cal-cell[data-state="unavailable"]');
    // The project is oklch: hsl(var(--token)) never resolves here.
    expect(css).not.toContain("hsl(var(--");
  });
});

describe("inspectors carry secondary detail on small screens", () => {
  for (const file of [
    "src/components/pms/AvailabilitySearchPage.tsx",
    "src/routes/_shell.pms.rack.tsx",
  ]) {
    it(`${file} moves secondary status and actions into an inspector`, () => {
      const src = read(file);
      expect(src).toContain("@/components/common/InspectorSheet");
      expect(src).toContain("<InspectorSheet");
      expect(src).toContain("InspectorField");
    });
  }
});

describe("calendar transitions reserve geometry", () => {
  it("exposes month, toolbar and matrix skeletons", () => {
    const src = read("src/components/common/CalendarSurface.tsx");
    expect(src).toContain("export function CalendarMonthSkeleton");
    expect(src).toContain("export function CalendarToolbarSkeleton");
    expect(src).toContain("export function CalendarMatrixSkeleton");
  });

  it("uses them where a period change refetches", () => {
    for (const file of ["src/routes/_shell.events.calendar.tsx", "src/routes/_shell.tasks.tsx"]) {
      expect(read(file), file).toContain("CalendarMonthSkeleton");
    }
  });
});

describe("register tables page themselves", () => {
  it("gives every shared register table a contained pager", () => {
    const src = read("src/components/events/EventsShared.tsx");
    expect(src).toContain("usePagedRows");
    expect(src).toContain("<TablePager");
    expect(src).toContain("overflow-x-auto");
  });
});

describe("configuration surfaces email readiness honestly", () => {
  it("renders the shared checklist on the Configuration Centre landing", () => {
    expect(read("src/routes/_shell.settings.tsx")).toContain("<EmailReadinessChecklist />");
  });

  it("reuses the single readiness resolver and never claims delivery is live", () => {
    const src = read("src/components/settings/EmailReadinessChecklist.tsx");
    expect(src).toContain("resolveEmailReadiness");
    expect(src).toContain("Remaining external step");
    expect(src).not.toMatch(/delivery is live/i);
  });
});
