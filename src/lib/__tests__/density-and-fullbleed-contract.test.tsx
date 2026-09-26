// @vitest-environment jsdom
/**
 * Acceptance contract: operational density + full-bleed shell chrome.
 *
 * Two regressions are pinned here.
 *
 * 1. TYPOGRAPHY. Dashboard figures must be sized by the CARD they live in,
 *    not by the viewport, so a wider laptop shows more information rather
 *    than larger numbers. Every metric utility therefore has a hard upper
 *    cap and scales in container units (cqi), and money/counts stay atomic —
 *    they shrink and ellipsis instead of breaking across lines.
 *
 * 2. SHELL. Header and footer are chrome for the whole staff frame: they span
 *    the full width beside the sidebar, with only their contents inset by the
 *    shared gutter. No max-width column stops them early.
 */
import { describe, expect, it, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { StatCard, MetricTile, PageHeader } from "@/components/common/DataDisplay";

afterEach(cleanup);

const styles = readFileSync("src/styles.css", "utf8");
const topbar = readFileSync("src/components/layout/Topbar.tsx", "utf8");
const shell = readFileSync("src/components/layout/AppShell.tsx", "utf8");

const utility = (name: string) => {
  const start = styles.indexOf(`@utility ${name} {`);
  expect(start, `@utility ${name} must exist`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = styles.indexOf("{", start); i < styles.length; i += 1) {
    if (styles[i] === "{") depth += 1;
    if (styles[i] === "}") {
      depth -= 1;
      if (depth === 0) return styles.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
};

const clampMax = (block: string) => {
  const match = block.match(/font-size:\s*clamp\(([^)]+)\)/);
  expect(match, "utility must size fluidly").not.toBeNull();
  const parts = (match![1] ?? "").split(",").map((p) => p.trim());
  return { min: parseFloat(parts[0]!), max: parseFloat(parts[2]!), grow: parts[1]! };
};

describe("metric typography stays operational, never billboard", () => {
  const CAPS: Record<string, { min: number; max: number }> = {
    // Ordinary KPI figure.
    "neo-metric-value": { min: 1.0, max: 1.5 },
    // Lead figure — one per dashboard.
    "neo-metric-value-lead": { min: 1.25, max: 1.9 },
    // Dense secondary figure.
    "neo-metric-value-sm": { min: 0.9, max: 1.2 },
  };

  for (const [name, cap] of Object.entries(CAPS)) {
    it(`${name} is capped at ${cap.max}rem on the largest display`, () => {
      const { min, max } = clampMax(utility(name));
      expect(max).toBeLessThanOrEqual(cap.max);
      expect(min).toBeGreaterThanOrEqual(cap.min);
      expect(min).toBeLessThan(max);
    });

    it(`${name} grows with its card, not with the viewport`, () => {
      const { grow } = clampMax(utility(name));
      expect(grow).toContain("cqi");
      expect(grow).not.toContain("vw");
    });

    it(`${name} keeps a figure atomic — no mid-number breaking`, () => {
      const block = utility(name);
      expect(block).toContain("white-space: nowrap");
      expect(block).toContain("text-overflow: ellipsis");
      // overflow-wrap:anywhere would split KES 1,234,567.00 across lines.
      expect(block).not.toContain("overflow-wrap: anywhere");
      expect(block).toContain("tabular-nums");
    });
  }

  it("the page title is an operational heading, not a slide headline", () => {
    const { max } = clampMax(utility("neo-title-fluid"));
    expect(max).toBeLessThanOrEqual(1.6);
  });

  it("metric cards declare themselves as size containers", () => {
    expect(utility("neo-metric-card")).toContain("container-type: inline-size");
    for (const file of [
      "src/components/common/DataDisplay.tsx",
      "src/components/common/FactCard.tsx",
      "src/components/dashboard/DashboardStateCard.tsx",
      "src/components/analytics/AnalyticsShared.tsx",
    ]) {
      expect(readFileSync(file, "utf8"), `${file} must size its figure by the card`).toContain(
        "neo-metric-card",
      );
    }
  });

  it("rendered KPI surfaces carry the container and the capped utility", () => {
    const { container } = render(
      <>
        <StatCard label="Outstanding balance" value="KES 1,284,995.75" />
        <StatCard lead label="Revenue today" value="KES 942,300.00" />
        <MetricTile label="Rooms sold" value="128" />
      </>,
    );
    expect(container.querySelectorAll(".neo-metric-card").length).toBe(3);
    expect(container.querySelector(".neo-metric-value-lead")).not.toBeNull();
    // The figure is clamped to one line and keeps its full text for a11y.
    const figure = container.querySelector("p.neo-metric-value") as HTMLElement;
    expect(figure.className).toContain("neo-line-1");
    expect(figure.getAttribute("title")).toBe("KES 1,284,995.75");
  });

  it("a laptop dashboard gets more columns rather than bigger cards", () => {
    const grid = utility("neo-kpi-grid");
    expect(grid).toMatch(/@media \(width >= 1024px\)[\s\S]*?repeat\(4/);
    expect(grid).toMatch(/@media \(width >= 1280px\)[\s\S]*?repeat\(6/);
    // The lead card no longer swallows half of a laptop dashboard.
    const lead = grid.slice(grid.indexOf('[data-kpi-span="lead"]'));
    expect(lead).toMatch(/@media \(width >= 1280px\)\s*\{\s*grid-column: span 2;/);
  });

  it("density preference changes rhythm, not type scale", () => {
    const start = styles.indexOf('[data-density="compact"]');
    expect(start).toBeGreaterThan(-1);
    const density = styles.slice(start, styles.indexOf("}", styles.indexOf("{", start)));
    expect(density).not.toContain("neo-metric-value");
    expect(density).not.toContain("neo-title-fluid");
  });

  it("a hero heading still uses the shared fluid title primitive", () => {
    const { container } = render(<PageHeader title="Front Office" description="Today" />);
    expect(container.querySelector("h1")?.className).toContain("neo-title-fluid");
  });
});

describe("header and footer are full-bleed shell chrome", () => {
  it("neo-shell-bleed spans the frame without a max-width column", () => {
    const block = utility("neo-shell-bleed");
    expect(block).toContain("width: 100%");
    expect(block).toContain("max-width: 100%");
    expect(block).toContain("min-width: 0");
  });

  it("the header row spans the whole staff frame", () => {
    expect(topbar).toContain('className="sticky top-0 z-30 w-full');
    expect(topbar).toContain("neo-page-gutter neo-shell-bleed");
    // Nothing narrows the chrome before the right edge of the frame.
    expect(topbar).not.toContain("max-w-7xl");
    expect(topbar).not.toContain("mx-auto");
  });

  it("the footer and the main content share that full width", () => {
    expect(shell).not.toContain("max-w-7xl");
    expect(shell).not.toContain("mx-auto");
    expect(shell).toContain("neo-shell-bleed");
    expect(shell).toContain("neo-page-gutter");
    // Footer keeps its own gutter and safe-area inset.
    expect(shell).toMatch(/<footer className="neo-safe-b neo-page-gutter/);
  });

  it("content is inset by the gutter, so nothing touches the screen edge", () => {
    for (const name of ["neo-page-gutter", "neo-content-shell"]) {
      expect(utility(name)).toContain("env(safe-area-inset-left");
    }
  });
});

describe("permanent NEØ identity at every device width", () => {
  it("the wordmark is always rendered, never hidden by a breakpoint", () => {
    expect(topbar).toContain("<NeoGlyph");
    expect(topbar).not.toMatch(/NeoGlyph[^/]*hidden/);
    // Product identity, never the tenant/property logo.
    expect(topbar).not.toContain("branding.logo");
  });

  it("the module label is visible from 360px and never wraps", () => {
    expect(topbar).toContain("data-module-label");
    expect(topbar).toContain("neo-module-label");
    // The old phone-hiding behaviour must not come back.
    expect(topbar).not.toContain('className="hidden min-w-0 truncate text-sm font-semibold tracking-tight text-foreground sm:inline"');
    const label = utility("neo-module-label");
    expect(label).toContain("white-space: nowrap");
    expect(label).toContain("text-overflow: ellipsis");
    const { min, max } = clampMax(label);
    expect(min).toBeGreaterThanOrEqual(0.72);
    expect(max).toBeLessThanOrEqual(0.9);
  });

  it("identity keeps its width priority over collapsible utilities", () => {
    // The action cluster is fixed-size and pinned right; identity shrinks last.
    expect(topbar).toMatch(/data-action-cluster[\s\S]*?ml-auto flex min-w-0 shrink-0/);
    // Property context remains visible at every width; secondary utilities
    // collapse into More before identity gives up any space.
    expect(topbar).toContain(
      '<PropertySelector className="flex w-auto max-w-[8.5rem] sm:max-w-[15rem]" />',
    );
    for (const collapsed of [
      '<IconAction label="Tasks" className="hidden lg:inline-flex">',
      '<IconAction label="Approvals" className="hidden md:inline-flex">',
      '<IconAction label="NEØ Intelligence" className="hidden text-primary sm:inline-flex">',
    ]) {
      expect(topbar).toContain(collapsed);
    }
    // …and each one is still reachable from the overflow menu.
    for (const inMore of ["/tasks", "/approvals", "/ai-insights", "Toggle theme"]) {
      expect(topbar.slice(topbar.indexOf("data-header-overflow"))).toContain(inMore);
    }
  });
});
