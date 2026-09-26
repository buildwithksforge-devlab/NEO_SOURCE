import { describe, expect, it } from "vitest";
import { SETTINGS_CATEGORIES } from "@/lib/settings-catalogue";
import { capabilityForPath } from "@/lib/capabilities";

/**
 * Configuration Centre consolidation contract.
 *
 * A configuration concept has exactly one canonical surface, every surface
 * carries its own capability, and the canonical domains a new hotel must
 * configure before it can operate are all reachable from the centre.
 */

const entries = SETTINGS_CATEGORIES.flatMap((category) => category.entries);

describe("Configuration Centre", () => {
  it("registers the canonical surfaces a new hotel needs before go-live", () => {
    const routes = new Set(entries.map((entry) => entry.to).filter(Boolean));
    for (const route of [
      "/admin/meal-plans",
      "/admin/suppliers",
      "/admin/delivery-zones",
      "/admin/finance-periods",
    ]) {
      expect(routes.has(route)).toBe(true);
    }
  });

  it("keeps one canonical entry per configuration route", () => {
    const seen = new Map<string, number>();
    for (const entry of entries) {
      if (!entry.to) continue;
      seen.set(entry.to, (seen.get(entry.to) ?? 0) + 1);
    }
    const duplicated = [...seen.entries()].filter(([, count]) => count > 1);
    expect(duplicated).toEqual([]);
  });

  it("resolves a capability for every configuration page, so none is ungated", () => {
    for (const entry of entries) {
      if (!entry.to) continue;
      expect(capabilityForPath(entry.to), `${entry.to} has no capability`).toBeTruthy();
    }
  });

  it("gates the new surfaces on their owning module, not a blanket admin key", () => {
    expect(capabilityForPath("/admin/finance-periods")?.module).toBe("finance");
    expect(capabilityForPath("/admin/suppliers")?.module).toBe("procurement");
    expect(capabilityForPath("/admin/delivery-zones")?.module).toBe("delivery");
    expect(capabilityForPath("/admin/meal-plans")?.module).toBe("front-office");
  });
});
