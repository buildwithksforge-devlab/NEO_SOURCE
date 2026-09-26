import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

describe("NEØ chart kit", () => {
  const kit = read("src/components/charts/ChartKit.tsx");

  it("exports the canonical chart primitives", () => {
    for (const symbol of ["AXIS_PROPS", "GRID_PROPS", "TOOLTIP_PROPS", "ChartCard", "chartSeriesColor"]) {
      expect(kit).toContain(symbol);
    }
  });

  it("uses theme chart tokens rather than hardcoded hex colours", () => {
    expect(kit).toContain("var(--color-chart-1)");
    expect(kit).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it("renders charts at a fluid responsive height", () => {
    expect(kit).toContain("neo-chart-h");
  });
});

describe("dashboard chart consumers", () => {
  const panels = read("src/components/dashboard/panels.tsx");
  const intelligence = read("src/routes/_shell.ai-insights.tsx");
  const analytics = read("src/components/analytics/AnalyticsShared.tsx");

  it("routes dashboard panels through the shared chart frame", () => {
    expect(panels).toContain('from "@/components/charts/ChartKit"');
    expect(panels).toContain("<ChartCard");
    // No local tooltip styling left behind.
    expect(panels).not.toContain("const chartTooltip");
  });

  it("routes the analytics chart frame through the shared chart card", () => {
    expect(analytics).toContain("ChartCard");
  });

  it("charts the Intelligence demand trend with shared axes and tooltip", () => {
    expect(intelligence).toContain("GRID_PROPS");
    expect(intelligence).toContain("TOOLTIP_PROPS");
    expect(intelligence).toContain("Demand & occupancy");
  });
});

describe("KPI card composition", () => {
  const factCard = read("src/components/common/FactCard.tsx");
  const stateCard = read("src/components/dashboard/DashboardStateCard.tsx");
  const frame = read("src/components/dashboard/DashboardFrame.tsx");

  it("does not repeat a clunky Open records button on every KPI card", () => {
    expect(factCard).not.toMatch(/>\s*Open records/);
    expect(stateCard).not.toMatch(/>\s*Open records/);
  });

  it("keeps scope and period metadata on a single dashboard context line", () => {
    expect(frame).toContain("neo-kpi-grid");
  });

  it("uses fluid metric typography so values never overflow", () => {
    expect(`${factCard}${stateCard}`).toContain("neo-metric-value");
  });
});
