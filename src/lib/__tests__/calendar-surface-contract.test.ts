/**
 * The NEØ date language is a contract, not a per-page style choice.
 *
 * Calendars must size against their CONTAINER, so collapsing the sidebar
 * widens them instead of leaving dead space, and no calendar may reintroduce
 * the fixed widths and fixed cell heights that caused wrapping day cells,
 * clipped toolbars and squeezed phone months.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { monthCells } from "@/components/common/CalendarSurface";
import { readinessPresentation, ROOM_READINESS } from "@/components/common/RoomReadiness";

const read = (p: string) => readFileSync(p, "utf8");

const CALENDAR_SURFACES = [
  "src/routes/_shell.events.calendar.tsx",
  "src/routes/_shell.marketing.calendar.tsx",
  "src/routes/_shell.tasks.tsx",
];

describe("calendar surface contract", () => {
  it("defines container-driven geometry, not viewport assumptions", () => {
    const css = read("src/styles.css");
    expect(css).toContain(".neo-calendar");
    expect(css).toMatch(/\.neo-calendar\s*\{[^}]*container-type:\s*inline-size/);
    expect(css).toMatch(/\.neo-matrix\s*\{[^}]*container-type:\s*inline-size/);
    // Seven equal columns that may shrink to zero rather than a fixed width.
    expect(css).toContain("grid-template-columns: repeat(7, minmax(0, 1fr));");
    // Cell height scales with the container.
    expect(css).toMatch(/min-block-size:\s*clamp\([^)]*cqi/);
    // Condensed month for narrow containers.
    expect(css).toContain("@container (max-width: 30rem)");
  });

  it("routes the large calendars through the shared primitives", () => {
    for (const file of CALENDAR_SURFACES) {
      const src = read(file);
      expect(src, file).toContain("@/components/common/CalendarSurface");
      expect(src, file).toContain("CalendarMonthGrid");
      expect(src, file).toContain("CalendarToolbar");
    }
  });

  it("keeps fixed month-label widths and hand-rolled month grids out of calendars", () => {
    for (const file of CALENDAR_SURFACES) {
      const src = read(file);
      expect(src, file).not.toContain("min-w-40 text-center text-sm font-medium");
      expect(src, file).not.toContain("grid-cols-7");
      expect(src, file).not.toContain("min-h-24");
    }
  });

  it("builds padded month cells on whole weeks", () => {
    const cells = monthCells(2026, 1, { today: "2026-02-10" }); // February 2026
    expect(cells.length % 7).toBe(0);
    expect(cells.filter((c) => c.day !== null)).toHaveLength(28);
    expect(cells.find((c) => c.key === "2026-02-10")?.today).toBe(true);
    expect(cells.find((c) => c.key === "2026-02-11")?.today).toBeFalsy();
  });
});

describe("room readiness contract", () => {
  it("separates clean-awaiting-inspection from ready-to-sell", () => {
    const clean = ROOM_READINESS["awaiting_inspection"]!;
    const ready = ROOM_READINESS["ready"]!;

    expect(clean.label).not.toBe(ready.label);
    expect(clean.icon).not.toBe(ready.icon);
    expect(clean.tone).not.toBe(ready.tone);
    expect(clean.sellable).toBe(false);
    expect(ready.sellable).toBe(true);
    expect(clean.meaning).toMatch(/not yet released/i);
  });

  it("never carries the distinction by colour alone", () => {
    for (const p of Object.values(ROOM_READINESS)) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.short.length).toBeGreaterThan(0);
      expect(p.icon).toBeTruthy();
    }
  });

  it("normalises legacy values and degrades honestly when nothing is recorded", () => {
    // The canonical alias table decides what legacy values mean; the badge just
    // presents the result of that normalisation.
    expect(readinessPresentation("inspected").key).toBe("ready");
    expect(readinessPresentation("awaiting_inspection").sellable).toBe(false);
    expect(readinessPresentation(null).label).toBe("Readiness not recorded");
    expect(readinessPresentation("").sellable).toBe(false);
  });

  it("is what the rack and availability surfaces render", () => {
    for (const file of [
      "src/routes/_shell.pms.rack.tsx",
      "src/components/pms/AvailabilitySearchPage.tsx",
    ]) {
      expect(read(file), file).toContain("RoomReadinessBadge");
    }
  });
});
