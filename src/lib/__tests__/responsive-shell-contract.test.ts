import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), "src", p), "utf8");

const shell = read("components/layout/AppShell.tsx");
const topbar = read("components/layout/Topbar.tsx");
const density = read("components/common/DensityToggle.tsx");
const css = read("styles.css");

describe("Phase 2 · shell geometry", () => {
  it("drives the desktop rail from shared width tokens, not literals", () => {
    expect(css).toContain("--neo-sidebar-w:");
    expect(css).toContain("--neo-sidebar-w-collapsed:");
    expect(shell).toContain("neo-sidebar-rail");
    expect(shell).toContain("neo-sidebar-rail-collapsed");
    // No magic pixel widths left in the shell.
    expect(shell).not.toContain("w-[72px]");
    expect(shell).not.toMatch(/\bw-64\b/);
    expect(shell).not.toMatch(/\bw-72\b/);
  });

  it("reserves rail width on desktop only, so tablet and phone use the drawer", () => {
    expect(shell).toContain("lg:block");
    expect(shell).toContain("MobileSidebar");
  });

  it("lets the content column shrink instead of pushing the page wider", () => {
    expect(shell).toContain("neo-shell-main");
    expect(css).toMatch(/@utility neo-shell-main \{[^}]*min-width: 0;/);
  });

  it("clips horizontal overflow at the shell, never at the page", () => {
    expect(shell).toContain("neo-shell-frame");
    expect(css).toMatch(/@utility neo-shell-frame \{[^}]*overflow-x: clip;/);
    expect(css).toMatch(/html,\s*body \{\s*overflow-x: clip;/);
  });
});

describe("Phase 2 · density control placement", () => {
  it("lives in the dashboard toolbar's stable slot, never in the shell header", () => {
    const frame = read("components/dashboard/DashboardFrame.tsx");
    expect(topbar).not.toContain("DensityToggle");
    expect(frame).toContain("data-density-slot");
    expect(frame).toContain("<DensityToggle className=\"hidden md:inline-flex\" />");
    expect(frame).toContain("<DensityToggle variant=\"menu\" className=\"md:hidden\" />");
    // The filter column is fluid and min-w-0, so a sidebar collapse resizes the
    // filters and never shifts the control slot.
    expect(frame).toContain("data-dashboard-toolbar");
    expect(frame).toContain("neo-filter-bar min-w-0 flex-1");
  });

  it("offers all three modes in both shapes", () => {
    for (const mode of ["comfortable", "compact", "touch"]) {
      expect(density).toContain(`"${mode}"`);
    }
    expect(density).toContain('variant === "menu"');
    expect(density).toContain("DropdownMenuRadioGroup");
  });
});

describe("Phase 2 · shared card spacing", () => {
  it("publishes one spacing rhythm per density instead of per-card values", () => {
    for (const token of [
      "--neo-card-gap-header",
      "--neo-card-gap-content",
      "--neo-card-gap-footer",
      "--neo-card-safe-edge",
    ]) {
      expect(css).toContain(token);
      // every density mode restates the rhythm
      expect(css.split(token).length - 1).toBeGreaterThanOrEqual(3);
    }
    expect(css).toContain("@utility neo-card-stack");
    expect(css).toContain("@utility neo-card-header-gap");
    expect(css).toContain("@utility neo-card-footer-gap");
  });

  it("keeps controls inside their card", () => {
    expect(css).toMatch(/\.neo-card-pad > \* \{[^}]*min-width: 0;/);
    expect(css).toContain('.neo-card-pad :is(select, [data-slot="select-trigger"], [role="combobox"])');
  });
});
