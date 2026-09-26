import { describe, expect, it } from "vitest";
import { CATALOGUE_ROLES, resolveCatalogueRoleKey } from "@/lib/role-aliases";
import { ROLE_ACCESS_SCOPES, ROLE_FEATURE_TEMPLATES } from "@/lib/role-templates";
import { dashboardKeyForRole } from "@/lib/workspace-preview";

/**
 * Final NEØ department/role structure (departments 1–17). System Administration
 * is deliberately excluded from the restructuring and keeps its existing setup.
 */
const STRUCTURE: Record<string, string[]> = {
  "Executive Management": ["owner", "operations-manager"],
  Finance: ["finance-manager", "accountant", "cashier"],
  "Food & Beverage": [
    "food-and-beverage-manager",
    "restaurant-manager",
    "coffee-station-supervisor",
    "waiter",
    "barista",
  ],
  Bar: ["bar-manager", "bar-attendant"],
  Delivery: ["delivery-manager", "rider"],
  "Front Office": ["front-office-manager", "front-office-supervisor", "reservations-agent", "front-office-cashier", "driver", "receptionist"],
  Housekeeping: ["housekeeping-manager", "housekeeper"],
  "Inventory & Stores": ["storekeeper", "receiving-clerk"],
  Laundry: ["laundry-manager", "laundry-supervisor", "laundry-attendant"],
  "Human Resources": ["human-resources-manager", "hr-officer"],
  Procurement: ["procurement-manager", "procurement-officer"],
  Marketing: ["marketing-manager", "social-media-manager"],
  "Sales, Events & Banqueting": ["sales-and-events-manager", "events-coordinator", "banqueting-staff"],
  "Maintenance & Landscaping": ["maintenance-manager", "maintenance-officer", "maintenance-technician", "grounds-worker"],
  "Main Kitchen": ["head-chef", "hot-kitchen-supervisor", "hot-kitchen-chef", "chief-steward", "kitchen-steward"],
  "Pastry & Bakery": ["head-pastry-chef", "pastry-chef"],
  Security: ["security-supervisor", "security-guard"],
};

const allKeys = Object.values(STRUCTURE).flat();

describe("final NEØ role structure", () => {
  it("every approved role is in the catalogue, templated and scoped", () => {
    for (const key of allKeys) {
      expect(CATALOGUE_ROLES[key], `missing catalogue entry: ${key}`).toBeTruthy();
      expect(ROLE_FEATURE_TEMPLATES[key]?.length, `missing template: ${key}`).toBeGreaterThan(0);
      expect(ROLE_ACCESS_SCOPES[key], `missing access scope: ${key}`).toBeTruthy();
    }
  });

  it("keeps System Administration exactly as implemented", () => {
    expect(CATALOGUE_ROLES["it-system-administrator"]).toBe("IT/System Administrator");
    expect(ROLE_ACCESS_SCOPES["it-system-administrator"]).toBe("technical");
    expect(dashboardKeyForRole("IT/System Administrator")).toBe("administration");
  });

  it("retires the removed roles from the active model", () => {
    for (const retired of ["General Manager", "Night Auditor", "Porter", "Bell Attendant"]) {
      expect(resolveCatalogueRoleKey(retired), `${retired} must not resolve`).toBeNull();
    }
    expect(CATALOGUE_ROLES["general-manager"]).toBeUndefined();
    expect(CATALOGUE_ROLES["night-auditor"]).toBeUndefined();
  });

  it("resolves every approved role to a dashboard", () => {
    for (const key of allKeys) {
      expect(dashboardKeyForRole(CATALOGUE_ROLES[key]!), `no dashboard: ${key}`).toBeTruthy();
    }
  });
});
