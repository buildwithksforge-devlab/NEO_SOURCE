/**
 * Acceptance contract for the adaptive density system.
 *
 * Density is a display preference: it must persist per user, adapt to the
 * viewport, accept role-derived recommendations, and never take priority over
 * the accessible touch-target floor on small touch screens. It must never be
 * able to influence permissions or which records are shown — that is asserted
 * structurally by keeping the resolver free of any access input.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DENSITIES,
  DENSITY_LABELS,
  recommendDensityForRoles,
  resolveDensity,
  viewportDensity,
  type DensityViewport,
} from "@/lib/density";

const desktop: DensityViewport = { coarsePointer: false, width: 1440 };
const tablet: DensityViewport = { coarsePointer: true, width: 834 };
const phone: DensityViewport = { coarsePointer: true, width: 390 };

describe("official density modes", () => {
  it("exposes exactly the three user-facing modes", () => {
    expect([...DENSITIES]).toEqual(["comfortable", "compact", "touch"]);
    expect(DENSITY_LABELS.touch).toBe("Touch optimized");
  });
});

describe("resolver precedence", () => {
  it("honours an explicit choice on desktop", () => {
    expect(resolveDensity("compact", desktop)).toBe("compact");
    expect(resolveDensity("comfortable", desktop)).toBe("comfortable");
    expect(resolveDensity("touch", desktop)).toBe("touch");
  });

  it("falls back to a recommendation before the viewport default", () => {
    expect(resolveDensity("auto", desktop, "compact")).toBe("compact");
    expect(resolveDensity("auto", desktop, null)).toBe("comfortable");
  });

  it("protects touch targets even when the user picked compact", () => {
    expect(resolveDensity("compact", phone)).toBe("touch");
    expect(resolveDensity("compact", tablet)).toBe("touch");
  });

  it("still respects comfortable on a touch screen", () => {
    expect(resolveDensity("comfortable", tablet)).toBe("comfortable");
  });

  it("defaults touch surfaces to touch mode", () => {
    expect(viewportDensity(phone)).toBe("touch");
    expect(viewportDensity(desktop)).toBe("comfortable");
  });
});

describe("role recommendations", () => {
  it("recommends compact for finance-heavy desk roles", () => {
    expect(recommendDensityForRoles(["Finance Manager"], desktop)).toBe("compact");
    expect(recommendDensityForRoles(["Accounts Receivable Officer"], desktop)).toBe("compact");
  });

  it("recommends comfortable for executive analytical roles", () => {
    expect(recommendDensityForRoles(["Owner / Director"], desktop)).toBe("comfortable");
    expect(recommendDensityForRoles(["General Manager"], desktop)).toBe("comfortable");
  });

  it("recommends touch for operational roles on a tablet", () => {
    expect(recommendDensityForRoles(["Waiter"], tablet)).toBe("touch");
    expect(recommendDensityForRoles(["Barista"], tablet)).toBe("touch");
  });

  it("makes no recommendation when nothing matches", () => {
    expect(recommendDensityForRoles(["Something Bespoke"], desktop)).toBeNull();
    expect(recommendDensityForRoles([], desktop)).toBeNull();
    expect(recommendDensityForRoles(null, desktop)).toBeNull();
  });

  it("derives from role metadata only — no named people or tenants", () => {
    const source = readFileSync("src/lib/density.ts", "utf8");
    expect(source).not.toMatch(/savannah|zawadi/i);
  });
});

describe("density stays a display preference", () => {
  const source = readFileSync("src/lib/density.ts", "utf8");

  it("never imports permissions, access or data scope", () => {
    expect(source).not.toContain("nav-permissions");
    expect(source).not.toContain("data-scope");
    expect(source).not.toContain("branch-filter");
    expect(source).not.toContain("supabase");
  });

  it("keeps one canonical preference store", () => {
    expect(source).toContain("neo.dashboard.density");
    // Legacy two-mode values migrate instead of creating a second store.
    expect(source).toContain("spacious");
  });
});

describe("shared density tokens", () => {
  const css = readFileSync("src/styles.css", "utf8");

  it("drives rhythm from variables rather than per-route values", () => {
    for (const token of ["--neo-row-y", "--neo-row-min", "--neo-field-gap", "--neo-control-min"]) {
      expect(css).toContain(token);
    }
    expect(css).toContain(".neo-density-row");
    expect(css).toContain(".neo-density-table");
  });

  it("enforces an accessible minimum in touch mode", () => {
    const start = css.indexOf('[data-density="touch"] :is(button');
    expect(start).toBeGreaterThan(-1);
    expect(css.slice(start, start + 200)).toContain("min-height: 2.75rem");
  });
});
