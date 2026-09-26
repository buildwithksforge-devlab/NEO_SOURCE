import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pickThemedLogo, BRAND_IMAGE_MAX_ENCODED_BYTES } from "../brand-image";

const read = (p: string) => readFileSync(p, "utf8");

describe("shared responsive card system", () => {
  it("exposes fluid metric and card utilities", () => {
    const css = read("src/styles.css");
    for (const utility of [
      "@utility neo-metric-value",
      "@utility neo-metric-value-sm",
      "@utility neo-card-pad",
      "@utility neo-table-scroll",
      "@utility neo-metric-grid",
    ]) {
      expect(css).toContain(utility);
    }
    // Values must scale rather than overflow their card.
    expect(css).toMatch(/font-size: clamp\(/);
  });

  it("shared card primitives stay fluid", () => {
    const card = read("src/components/ui/card.tsx");
    expect(card).toContain("min-w-0");
    const display = read("src/components/common/DataDisplay.tsx");
    for (const primitive of ["MetricGrid", "MetricTile", "TableScroll", "InsetPanel"]) {
      expect(display).toContain(`export function ${primitive}`);
    }
    expect(display).toContain("neo-metric-value");
    expect(display).toContain("neo-card-pad");
  });

  it("data-heavy shared cards use the fluid metric type", () => {
    for (const file of [
      "src/components/common/FactCard.tsx",
      "src/components/analytics/AnalyticsShared.tsx",
    ]) {
      expect(read(file)).toContain("neo-metric-value");
    }
  });

  it("Intelligence page composes with the shared responsive primitives", () => {
    const page = read("src/routes/_shell.ai-insights.tsx");
    expect(page).toContain("<MetricGrid>");
    expect(page).toContain("<MetricTile");
    expect(page).toContain("<TableScroll>");
    // No bespoke non-scrolling table wrappers left on this page.
    expect(page).not.toContain('<div className="overflow-x-auto">');
    // Dense tables keep their identifying column pinned while scrolling.
    expect(page).toContain("neo-sticky-col");
    expect(read("src/styles.css")).toContain("@utility neo-sticky-col");
  });
});

describe("brand artwork persistence", () => {
  it("bounds what is written into the branding record", () => {
    expect(BRAND_IMAGE_MAX_ENCODED_BYTES).toBeLessThanOrEqual(500_000);
    const upload = read("src/components/common/FormFields.tsx");
    expect(upload).toContain("normaliseBrandImage");
    // The raw FileReader passthrough was the source of oversized writes.
    expect(upload).not.toContain("reader.readAsDataURL");
  });

  it("surfaces a failed workspace save instead of swallowing it", () => {
    const tenant = read("src/lib/tenant.tsx");
    expect(tenant).toContain("toast.error");
    expect(tenant).toContain("saveTenant");
  });

  it("persists branding to the workspace record, not local storage", () => {
    const store = read("src/lib/tenant-store.ts");
    expect(store).toContain('supabase.from("organization_settings").upsert');
    expect(store).toContain("brand: state.brand");
    expect(store).toContain("if (error) throw error");
  });

  it("chooses the logo that matches the resolved appearance", () => {
    expect(pickThemedLogo("light.png", "dark.png", true)).toBe("dark.png");
    expect(pickThemedLogo("light.png", "dark.png", false)).toBe("light.png");
    // Only one mark uploaded still renders in both appearances.
    expect(pickThemedLogo("light.png", null, true)).toBe("light.png");
    expect(pickThemedLogo(null, "dark.png", false)).toBe("dark.png");
    expect(pickThemedLogo(null, null, false)).toBeNull();
  });
});
