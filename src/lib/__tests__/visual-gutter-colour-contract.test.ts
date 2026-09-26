import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const styles = read("src/styles.css");
const shell = read("src/components/layout/AppShell.tsx");
const topbar = read("src/components/layout/Topbar.tsx");
const chartKit = read("src/components/charts/ChartKit.tsx");
const stateCard = read("src/components/dashboard/DashboardStateCard.tsx");

describe("page gutter", () => {
  it("defines one shared gutter utility with safe-area awareness", () => {
    expect(styles).toContain("@utility neo-page-gutter");
    expect(styles).toContain("@utility neo-content-shell");
    expect(styles).toMatch(/env\(safe-area-inset-left/);
  });

  it("keeps a small phone inset that grows on tablet and desktop", () => {
    const block = styles.slice(styles.indexOf("@utility neo-content-shell"));
    expect(block).toContain("0.875rem");
    expect(block).toContain("1.25rem");
    expect(block).toContain("1.5rem");
  });

  it("applies the gutter through the staff shell, not per route", () => {
    expect(shell).toContain("neo-content-shell");
    expect(shell).toContain("neo-page-gutter");
    expect(topbar).toContain("neo-page-gutter");
    // No route-level main content is allowed to sit flush against the edge.
    expect(shell).not.toMatch(/<main[^>]*className="[^"]*px-0/);
  });

  it("paints the page canvas instead of flat white", () => {
    expect(styles).toContain("@utility neo-page-canvas");
    expect(shell).toContain("neo-page-canvas");
  });
});

describe("tinted surfaces", () => {
  it("derives every tint from theme tokens via color-mix", () => {
    for (const utility of [
      "neo-tint-primary",
      "neo-tint-accent",
      "neo-tint-success",
      "neo-tint-warning",
      "neo-tint-info",
      "neo-tint-destructive",
      "neo-tint-quiet",
      "neo-card-lead",
    ]) {
      expect(styles).toContain(`@utility ${utility}`);
    }
    const tintStart = styles.indexOf("@utility neo-tint-primary");
    const tintBlock = styles.slice(tintStart, styles.indexOf("/* ── Chart module", tintStart));
    expect(tintBlock).toContain("color-mix(in oklab, var(--color-primary)");
    // No hardcoded tenant colours in the generic product.
    expect(tintBlock).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it("gives KPI cards a tone-driven surface and icon disc", () => {
    expect(stateCard).toContain("TONE_SURFACE");
    expect(stateCard).toContain("neo-card-lead");
    expect(stateCard).toContain("neo-card-press");
    expect(stateCard).toContain("TONE_RING[tone]");
  });
});

describe("chart presentation", () => {
  it("ships shared gradient, line and bar defaults", () => {
    expect(chartKit).toContain("export function ChartGradients");
    expect(chartKit).toContain("export const chartFill");
    expect(chartKit).toMatch(/strokeWidth: 2\.5/);
    expect(chartKit).toContain("radius: [7, 7, 2, 2]");
  });

  it("treats the chart card as a designed module", () => {
    expect(styles).toContain("@utility neo-chart-card");
    expect(styles).toContain("@utility neo-chart-plot");
    expect(chartKit).toContain("neo-chart-card");
    expect(chartKit).toContain("neo-chart-plot");
  });

  it("keeps charts tall enough on a phone", () => {
    expect(styles).toMatch(/@utility neo-chart-h\s*\{[^}]*clamp\(13rem/);
  });

  it("routes recharts consumers through the shared kit", () => {
    for (const file of [
      "src/components/dashboard/panels.tsx",
      "src/routes/_shell.ai-insights.tsx",
    ]) {
      const src = read(file);
      expect(src).toContain("@/components/charts/ChartKit");
      // No bespoke gradient defs left behind.
      expect(src).not.toContain("<linearGradient");
    }
  });
});
