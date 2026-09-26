import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETTINGS_CATEGORIES } from "@/lib/settings-catalogue";
import {
  centreReadiness,
  domainReadiness,
  entryStatus,
  entryStatusKey,
  readinessLabel,
  readinessTone,
} from "@/lib/settings-readiness";
import type { SettingsStatusMap } from "@/lib/settings-status";

const read = (p: string) => readFileSync(p, "utf8");
const org = SETTINGS_CATEGORIES.find((c) => c.key === "organisation")!;

describe("configuration readiness roll-up", () => {
  it("counts a surface only when its status was actually observed", () => {
    const r = domainReadiness(org, {});
    expect(r.total).toBe(org.entries.length);
    expect(r.measured).toBe(0);
    expect(readinessLabel(r)).toBe("Readiness not measured");
    expect(readinessTone(r)).toBe("neutral");
  });

  it("derives configured, awaiting-setup and attention counts from real statuses", () => {
    const statuses: SettingsStatusMap = {
      "/admin/hotel-information": "configured",
      "/admin/regional": "needs-setup",
      "/departments": "attention",
    };
    const r = domainReadiness(org, statuses);
    expect(r.measured).toBe(3);
    expect(r.configured).toBe(1);
    expect(r.needsSetup).toBe(1);
    expect(r.attention).toBe(1);
    expect(readinessTone(r)).toBe("attention");
    expect(readinessLabel(r)).toBe("1 need attention");
  });

  it("reports a fully configured domain without inventing unmeasured surfaces", () => {
    const statuses = Object.fromEntries(
      org.entries.map((e) => [entryStatusKey(e)!, "configured" as const]),
    );
    const r = domainReadiness(org, statuses);
    expect(r.configured).toBe(r.measured);
    expect(readinessTone(r)).toBe("ready");
    expect(readinessLabel(r)).toBe("All measured surfaces configured");
  });

  it("keys inline panels separately from routed pages", () => {
    const panel = SETTINGS_CATEGORIES.flatMap((c) => c.entries).find((e) => e.panel)!;
    expect(entryStatusKey(panel)).toBe(`panel:${panel.panel}`);
    expect(entryStatus(panel, { [`panel:${panel.panel}`]: "attention" })).toBe("attention");
  });

  it("rolls every visible domain into one centre total", () => {
    const total = centreReadiness(SETTINGS_CATEGORIES, {});
    expect(total.total).toBe(SETTINGS_CATEGORIES.flatMap((c) => c.entries).length);
    expect(total.measured).toBe(0);
  });

  it("stays honest when only some domains are visible to the viewer", () => {
    const total = centreReadiness([org], { "/admin/regional": "configured" });
    expect(total.total).toBe(org.entries.length);
    expect(total.configured).toBe(1);
  });
});

describe("Configuration Centre landing workspace", () => {
  const page = read("src/routes/_shell.settings.tsx");
  const overview = read("src/components/settings/ConfigurationOverview.tsx");

  it("lands on the all-domains overview rather than a single category", () => {
    expect(page).toContain('const OVERVIEW_KEY = "__overview"');
    expect(page).toContain("useState(OVERVIEW_KEY)");
    expect(page).toContain("<ConfigurationOverview");
    expect(page).toContain("<ConfigurationSummaryStrip");
  });

  it("offers a way back to the overview from a drilled-in domain", () => {
    expect(page).toContain('label: "All domains"');
    expect(page).toContain("All configuration domains");
  });

  it("keeps search across the whole catalogue and the capability filter", () => {
    expect(page).toContain("matchesQuery");
    expect(page).toContain("visibleCategories");
    expect(page).toContain("entryCapability");
  });

  it("renders domain tiles as accessible, responsive, touch-sized targets", () => {
    expect(overview).toContain("data-touch-target");
    expect(overview).toContain("sm:grid-cols-2 xl:grid-cols-3");
    expect(overview).toContain("min-w-0");
  });

  it("never paints a readiness bar for an unmeasured domain", () => {
    expect(overview).toContain("if (readiness.measured === 0) return null");
  });
});
