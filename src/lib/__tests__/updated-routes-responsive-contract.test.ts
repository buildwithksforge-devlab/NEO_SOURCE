/**
 * Responsive containment contract for the routes changed in this pass.
 *
 * jsdom has no layout engine, so a real desktop/tablet/phone screenshot sweep
 * cannot be performed here. What is enforced instead is the geometry contract
 * that produces correct behaviour at every breakpoint: wide content is scrolled
 * inside its own container rather than pushing the shell, tables never set a
 * fixed pixel width, no route re-introduces a shell-crossing negative gutter,
 * and dialogs stay within the viewport on phones.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROUTES = {
  Departments: "src/routes/_shell.departments.tsx",
  Stations: "src/routes/_shell.stations.tsx",
  "POS Approvals": "src/routes/_shell.pos.approvals.tsx",
  "Housekeeping history": "src/routes/_shell.housekeeping.history.tsx",
} as const;

const entries = Object.entries(ROUTES) as [keyof typeof ROUTES, string][];

describe.each(entries)("%s", (_name, path) => {
  const src = readFileSync(path, "utf8");

  it("keeps wide tables inside a scroll container instead of widening the shell", () => {
    if (!src.includes("<Table")) return;
    expect(src).toMatch(/TableScroll|overflow-x-auto|DataTable/);
  });

  it("never crosses the shell gutter with a negative horizontal margin", () => {
    // -mx-1 / -ml-2 style optical nudges are allowed; anything larger escapes
    // the page gutter and looks uneven at narrow widths.
    const offenders = src.match(/-m[xlr]-(?:[3-9]|1[0-9]|\[[^\]]+\])/g) ?? [];
    expect(offenders).toEqual([]);
  });

  it("never pins layout to the viewport width", () => {
    expect(src).not.toMatch(/\bw-screen\b/);
    expect(src).not.toMatch(/\bmin-w-\[\d{3,}px\]/);
  });

  it("lets text columns shrink rather than overflow", () => {
    if (!src.includes("flex")) return;
    expect(src).toMatch(/truncate|min-w-0|break-words|whitespace-normal|TableScroll|DataTable/);
  });

  it("keeps dialogs usable on a phone", () => {
    if (!src.includes("<DialogContent")) return;
    // Either the route constrains the dialog itself, or it relies on the shared
    // primitive — which must keep its own phone-safe width defaults.
    const own = /DialogContent[^>]*className="[^"]*(max-w|w-full|sm:max-w)/.test(src);
    if (!own) {
      const primitive = readFileSync("src/components/ui/dialog.tsx", "utf8");
      expect(primitive).toMatch(/w-full|w-\[calc\(100vw/);
      expect(primitive).toMatch(/max-w/);
    }
  });
});

describe("shell geometry is not overridden by these routes", () => {
  it("no route re-declares the sidebar or shell width", () => {
    for (const [, path] of entries) {
      const src = readFileSync(path, "utf8");
      expect(src).not.toContain("--neo-sidebar");
      expect(src).not.toContain("position: fixed");
    }
  });
});
