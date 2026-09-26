import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

describe("touch behaviour on coarse pointers", () => {
  const styles = read("src/styles.css");

  it("keeps a 44px floor for interactive controls only on touch pointers", () => {
    expect(styles).toContain("@media (pointer: coarse)");
    expect(styles).toContain("min-height: 2.75rem");
    expect(styles).toContain("min-width: 2.75rem");
  });

  it("stops iOS from zooming when a field is focused", () => {
    expect(styles).toMatch(/input:not\(\[type="checkbox"\]\)/);
    expect(styles).toContain("font-size: 1rem");
  });

  it("respects safe-area insets in shell chrome", () => {
    expect(styles).toContain("env(safe-area-inset-bottom");
    const shell = read("src/components/layout/AppShell.tsx");
    expect(shell).toContain("neo-safe-b");
  });

  it("shared controls grow on touch without growing on desktop", () => {
    for (const f of [
      "src/components/ui/button.tsx",
      "src/components/ui/input.tsx",
      "src/components/ui/select.tsx",
      "src/components/ui/dropdown-menu.tsx",
    ]) {
      expect(read(f), f).toContain("[@media(pointer:coarse)]");
    }
  });

  it("separates adjacent row actions on touch", () => {
    expect(styles).toContain("[data-action-cluster]");
    expect(read("src/components/common/DataDisplay.tsx")).toContain("data-action-cluster");
  });

  it("tables scroll horizontally instead of overflowing", () => {
    const table = read("src/components/ui/table.tsx");
    expect(table).toContain("overflow-x-auto");
    expect(table).toContain("py-2.5");
  });
});

describe("card hierarchy", () => {
  const display = read("src/components/common/DataDisplay.tsx");
  const styles = read("src/styles.css");

  it("offers primary and quiet section surfaces", () => {
    expect(display).toContain("SectionCardTone");
    expect(display).toContain("surface-quiet");
    expect(display).toContain("surface-panel");
  });

  it("offers an inset region instead of card-inside-card", () => {
    expect(display).toContain("export function InsetPanel");
    expect(styles).toContain("@utility surface-inset");
  });

  it("KPI cards lead with the figure and let context recede", () => {
    expect(display).toContain("uppercase tracking-[0.12em] text-muted-foreground");
    const fact = read("src/components/common/FactCard.tsx");
    expect(fact).toContain("uppercase tracking-[0.12em]");
    expect(fact).toContain("neo-card-interactive");
  });

  it("introduces no light-only hardcoded styling", () => {
    for (const f of [
      "src/components/common/DataDisplay.tsx",
      "src/components/common/FactCard.tsx",
      "src/components/ui/card.tsx",
      "src/components/ui/table.tsx",
    ]) {
      expect(read(f), f).not.toMatch(/bg-white|text-black|bg-\[#/);
    }
  });

  it("uses responsive card padding rather than one desktop density", () => {
    expect(read("src/components/ui/card.tsx")).toContain("p-5 md:p-6");
  });
});
