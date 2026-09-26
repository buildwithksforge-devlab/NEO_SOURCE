import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

describe("module subnavigation stays on the shared quiet pattern", () => {
  const tabs = read("src/components/common/SectionTabs.tsx");

  it("underline tabs never fill the active label with a solid slab", () => {
    expect(tabs).toContain("after:bg-primary");
    expect(tabs).not.toMatch(/bg-primary\s+text-primary-foreground/);
    expect(tabs).not.toMatch(/bg-white|text-black/);
  });

  it("marks the current view for assistive technology", () => {
    expect(tabs).toContain('aria-current={active ? "page" : undefined}');
    expect(tabs).toContain("focus-visible:ring-ring");
  });

  it("groups long tab sets into an overflow menu instead of tiny pills", () => {
    expect(tabs).toContain("maxVisible");
    expect(tabs).toContain("DropdownMenu");
  });

  it("keeps the segmented selected-state work from the previous pass", () => {
    expect(tabs).toContain("bg-chip-selected");
  });

  it("every module layout uses the shared SectionTabs component", () => {
    const layouts = [
      "finance",
      "events",
      "housekeeping",
      "hr",
      "inventory",
      "kitchen",
      "laundry",
      "marketing",
      "pos",
      "procurement",
      "security",
      "automation",
      "pastry",
      "maintenance",
    ];
    for (const m of layouts) {
      const src = read(`src/routes/_shell.${m}.tsx`);
      expect(src, m).toContain("<SectionTabs");
    }
  });
});

describe("section headers read as hierarchy, not buttons", () => {
  const display = read("src/components/common/DataDisplay.tsx");

  it("exposes typographic section and subsection headings", () => {
    expect(display).toContain("export function SectionHeading");
    expect(display).toContain("export function SubsectionHeading");
  });

  it("uses a hairline divider rather than a filled capsule", () => {
    expect(display).toContain("border-b border-outline-subtle");
    expect(display).not.toMatch(/h2[^>]*rounded-full/);
  });

  it("reports quick links are text navigation, not outlined buttons", () => {
    const reports = read("src/routes/_shell.reports.tsx");
    expect(reports).toContain("QuietLinkRow");
    expect(reports).not.toContain('variant="outline"');
  });
});
