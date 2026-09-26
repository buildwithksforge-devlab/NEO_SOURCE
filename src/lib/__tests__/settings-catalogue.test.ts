import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SETTINGS_CATEGORIES,
  entryCapability,
  matchesQuery,
  visibleCategories,
} from "@/lib/settings-catalogue";
import { capabilityForPath } from "@/lib/capabilities";

/** Every URL the router can actually serve, derived from the route files. */
const routePaths = new Set(
  readdirSync(resolve(process.cwd(), "src/routes"))
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => f.replace(/\.tsx$/, ""))
    .filter((f) => !f.startsWith("__"))
    .map((f) => f.replace(/^_shell\.?/, "").replace(/\.index$/, ""))
    .map((f) => `/${f.split(".").join("/")}`)
    .map((p) => (p === "/" ? "/" : p.replace(/\/$/, ""))),
);

const allEntries = SETTINGS_CATEGORIES.flatMap((c) => c.entries);

describe("configuration centre catalogue", () => {
  it("covers the sixteen enterprise configuration domains exactly once", () => {
    expect(SETTINGS_CATEGORIES.map((c) => c.title)).toEqual([
      "Organisation",
      "Properties",
      "Front Office",
      "Rates & Taxes",
      "POS & Restaurant",
      "Kitchen & Routing",
      "Inventory & Stores",
      "Procurement",
      "Finance",
      "Approvals",
      "CRM & Communications",
      "Human Resources",
      "Documents",
      "Security",
      "Integrations",
      "Branding",
    ]);
    const keys = SETTINGS_CATEGORIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("registers the canonical stock catalogue and recipe standards in their own domains", () => {
    const inventory = SETTINGS_CATEGORIES.find((c) => c.key === "inventory")!;
    expect(inventory.entries.map((e) => e.to)).toContain("/inventory/items");
    const kitchen = SETTINGS_CATEGORIES.find((c) => c.key === "kitchen")!;
    expect(kitchen.entries.map((e) => e.to)).toContain("/kitchen/recipes");
  });

  it("never repeats a canonical route across domains", () => {
    const routes = allEntries.filter((e) => e.to).map((e) => e.to!);
    expect(new Set(routes).size, "duplicate canonical settings route").toBe(routes.length);
  });

  it("links only to routes the application actually serves", () => {
    for (const entry of allEntries) {
      if (!entry.to) continue;
      expect(routePaths.has(entry.to), `dead settings link: ${entry.to}`).toBe(true);
    }
  });

  it("registers every entry exactly once across the catalogue", () => {
    const targets = allEntries.map((e) => e.to ?? `panel:${e.panel}`);
    expect(new Set(targets).size, "duplicate settings entry").toBe(targets.length);
  });

  it("resolves a capability for every entry, so nothing bypasses the guard", () => {
    for (const entry of allEntries) {
      const cap = entryCapability(entry);
      expect(cap, `settings entry without a capability: ${entry.label}`).not.toBeNull();
      if (entry.to) expect(cap).toEqual(capabilityForPath(entry.to));
    }
  });

  it("hides every entry from a member with no permissions", () => {
    expect(visibleCategories(() => false)).toHaveLength(0);
  });

  it("shows only the entries a filter permits", () => {
    const shown = visibleCategories((e) => e.to === "/users");
    expect(shown).toHaveLength(1);
    expect(shown[0]!.entries.map((e) => e.to)).toEqual(["/users"]);
  });

  it("searches labels, descriptions and keywords", () => {
    const brand = allEntries.find((e) => e.to === "/admin/brand-identity")!;
    expect(matchesQuery(brand, "logo")).toBe(true);
    expect(matchesQuery(brand, "brand identity")).toBe(true);
    expect(matchesQuery(brand, "payroll")).toBe(false);
    expect(matchesQuery(brand, "   ")).toBe(true);
  });
});
