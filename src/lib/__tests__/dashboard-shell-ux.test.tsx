import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DASHBOARD_PERIODS,
  DEFAULT_SCOPE,
  resolvePeriod,
  scopePeriod,
  withPeriod,
} from "@/lib/dashboard-data";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("dashboard reporting periods", () => {
  it("exposes explicit calendar and rolling presets", () => {
    const keys = DASHBOARD_PERIODS.map((p) => p.key);
    expect(keys).toEqual(["today", "week", "month", "year", "last7", "last30", "last90"]);
    expect(DASHBOARD_PERIODS.filter((p) => p.kind === "calendar").map((p) => p.key)).toEqual([
      "today",
      "week",
      "month",
      "year",
    ]);
  });

  it("resolves calendar periods against the reference date", () => {
    const now = new Date(2026, 4, 14, 10, 0, 0); // Thursday 14 May 2026
    expect(resolvePeriod("today", now)).toMatchObject({ from: "2026-05-14", to: "2026-05-14", days: 1 });
    expect(resolvePeriod("week", now)).toMatchObject({ from: "2026-05-11", to: "2026-05-14" });
    expect(resolvePeriod("month", now)).toMatchObject({ from: "2026-05-01", to: "2026-05-14" });
    expect(resolvePeriod("year", now)).toMatchObject({ from: "2026-01-01", to: "2026-05-14" });
  });

  it("resolves rolling windows inclusively", () => {
    const now = new Date(2026, 4, 14, 10, 0, 0);
    expect(resolvePeriod("last7", now)).toMatchObject({ from: "2026-05-08", days: 7 });
    expect(resolvePeriod("last30", now)).toMatchObject({ days: 30 });
    expect(resolvePeriod("last90", now)).toMatchObject({ days: 90 });
  });

  it("keeps the legacy days contract in step with the preset", () => {
    const scope = withPeriod(DEFAULT_SCOPE, "last7");
    expect(scope.period).toBe("last7");
    expect(scope.days).toBe(7);
    expect(scopePeriod(scope).label).toBe("Last 7 days");
  });

  it("defaults to an explained period rather than an unlabelled window", () => {
    expect(DEFAULT_SCOPE.period).toBe("last30");
    expect(scopePeriod(DEFAULT_SCOPE).label).toBe("Last 30 days");
  });
});

describe("dashboard card interaction semantics", () => {
  const card = read("src/components/dashboard/DashboardStateCard.tsx");

  it("wraps the whole card in a link when it has a records destination", () => {
    expect(card).toContain("if (interactive && drillTo)");
    expect(card).toContain("focus-visible:ring-2");
    expect(card).toContain('aria-label={`${label} — ${drillLabel}`}');
  });

  it("treats ready and no-records cards as the action target", () => {
    expect(card).toContain(
      'const interactive = Boolean(drillTo) && (state === "ready" || state === "no-records");',
    );
  });

  it("stops nested controls from triggering navigation", () => {
    expect(card).toContain("event.stopPropagation()");
  });

  it("contains its content at every width", () => {
    expect(card).toContain("overflow-hidden");
    expect(card).toContain("line-clamp-2");
    expect(card).toContain("min-w-0");
  });
});

describe("shell chrome", () => {
  it("keeps the full NEØ wordmark permanent in the topbar", () => {
    const topbar = read("src/components/layout/Topbar.tsx");
    expect(topbar).toContain("<NeoGlyph");
    expect(topbar).not.toMatch(/NeoGlyph[^/]*hidden/);
  });

  it("aligns header gutters and width with the main content column", () => {
    const topbar = read("src/components/layout/Topbar.tsx");
    expect(topbar).toContain("neo-shell-bleed flex h-16 items-center");
    // Header and main content share the one shared gutter utility.
    expect(topbar).toContain("neo-page-gutter");
  });

  it("shows the tenant logo in the sidebar, collapsed or not", () => {
    const sidebar = read("src/components/layout/Sidebar.tsx");
    expect(sidebar).toContain("{branding.logo ? (");
    expect(sidebar).not.toContain("branding.logo && !collapsed");
  });
});
