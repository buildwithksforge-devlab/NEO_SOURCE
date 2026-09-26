import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

describe("Platform & Readiness module navigation", () => {
  const platform = read("src/routes/_shell.platform.tsx");

  it("uses the shared section navigation instead of a hand-rolled row", () => {
    expect(platform).toContain('from "@/components/common/SectionTabs"');
    expect(platform).toContain("<SectionTabs");
    expect(platform).not.toMatch(/flex flex-wrap gap-1 border-b border-border pb-2/);
  });

  it("never paints tabs as filled pills", () => {
    expect(platform).not.toContain("bg-primary-soft font-medium text-primary");
    expect(platform).not.toMatch(/rounded-lg px-3 py-1\.5 text-sm transition-colors/);
  });

  it("keeps every readiness destination and its permission gate", () => {
    for (const to of [
      "/platform",
      "/platform/integrations",
      "/platform/environments",
      "/platform/subscription",
      "/platform/migration",
      "/platform/quality",
      "/platform/operations",
      "/platform/support",
    ]) {
      expect(platform, to).toContain(`"${to}"`);
    }
    expect(platform).toContain("canAccessPath(can, t.to)");
  });

  it("pairs icons with labels through the shared tab type", () => {
    const tabs = read("src/components/common/SectionTabs.tsx");
    expect(tabs).toContain("icon?: LucideIcon");
    expect(platform).toMatch(/icon: ShieldCheck/);
  });
});

describe("shared section navigation behaviour", () => {
  const tabs = read("src/components/common/SectionTabs.tsx");

  it("scrolls horizontally rather than wrapping or clipping", () => {
    expect(tabs).toContain("neo-scroll-x");
  });

  it("keeps a restrained underline active state, not a slab", () => {
    expect(tabs).toContain("after:bg-primary");
    expect(tabs).toContain('aria-current={active ? "page" : undefined}');
  });

  it("keeps touch targets generous", () => {
    expect(tabs).toContain("data-touch-target");
    expect(tabs).toContain("py-2.5");
  });

  it("exports a calm vertical rail for two-pane modules", () => {
    expect(tabs).toContain("export function NavRail");
    expect(tabs).toContain("bg-chip-selected");
  });
});

describe("Configuration Centre polish", () => {
  const settings = read("src/routes/_shell.settings.tsx");

  it("uses the shared navigation rail for categories", () => {
    expect(settings).toContain("<NavRail");
    expect(settings).not.toMatch(/border-primary\/40 bg-primary-soft\/50/);
  });

  it("keeps configuration cards clickable links to their routes", () => {
    expect(settings).toContain("to={entry.to!}");
    expect(settings).toContain("data-touch-target");
  });

  it("renders status and scope as metadata, not CTA chips", () => {
    expect(settings).toContain("function ScopeMeta");
    expect(settings).not.toMatch(/<Badge[^>]*>\s*\{entry\.scope\}/);
    expect(settings).not.toMatch(/variant=\{\s*status === "attention"/);
    expect(settings).toContain("rounded-full");
  });

  it("drops redundant chrome from cards that are entirely clickable", () => {
    expect(settings).not.toContain("ArrowUpRight");
  });

  it("keeps the scope block as a contextual strip rather than a button cluster", () => {
    expect(settings).toContain("uppercase tracking-[0.12em] text-muted-foreground");
    expect(settings).not.toContain('<Badge variant="secondary">Scope</Badge>');
  });

  it("presents setup progress in an executive readiness form", () => {
    const setup = read("src/components/common/SetupProgressCard.tsx");
    expect(setup).toContain("of {total} complete");
    expect(setup).toContain("<Progress");
    expect(setup).toContain("outstanding");
  });
});
