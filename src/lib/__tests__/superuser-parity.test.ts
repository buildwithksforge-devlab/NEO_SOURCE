import { describe, expect, it } from "vitest";
import { ROLE_ACCESS_SCOPES, ROLE_FEATURE_TEMPLATES } from "@/lib/role-templates";
import { scopeLevelFor } from "@/lib/visibility-contract";

/**
 * NEØ governance contract: Owner/Director and IT/System Administrator are both
 * superusers of the product — equal inspection, configuration and control of
 * every module and every property. What differs is *business approval
 * authority*, which the organisation's configured approval matrix decides.
 */
const facts = (accessScope: string) => ({
  userId: "u",
  accountType: "staff" as const,
  accountStatus: "active",
  organizationId: "o",
  accessScope,
  branchIds: ["b1"],
  departmentIds: [] as string[],
  stationIds: [] as string[],
  grants: new Set<string>(),
  entitlements: {},
  setupComplete: true,
});

describe("Owner and System Administrator have equal platform reach", () => {
  it("gives the technical scope the same organisation-wide level as Owner", () => {
    expect(scopeLevelFor(facts("technical"))).toBe("organization");
    expect(scopeLevelFor(facts("organisation"))).toBe("organization");
  });

  it("lets a System Administrator select All Properties with no property assigned", () => {
    expect(scopeLevelFor({ ...facts("technical"), branchIds: [] })).toBe("organization");
  });

  it("keeps every other scope below organisation-wide", () => {
    expect(scopeLevelFor(facts("branch"))).toBe("property");
    expect(scopeLevelFor(facts("department"))).toBe("personal");
    expect(scopeLevelFor(facts("self"))).toBe("personal");
  });

  it("grants the System Administrator every module the Owner template covers", () => {
    const owner = ROLE_FEATURE_TEMPLATES["owner"] ?? [];
    const admin = new Set(ROLE_FEATURE_TEMPLATES["it-system-administrator"] ?? []);
    expect(owner.length).toBeGreaterThan(0);
    for (const entry of owner) expect(admin.has(entry)).toBe(true);
  });

  it("keeps the System Administrator's declared scope distinct from a line role", () => {
    expect(ROLE_ACCESS_SCOPES["it-system-administrator"]).toBe("technical");
    expect(ROLE_ACCESS_SCOPES["owner"]).toBe("organisation");
  });

  it("never encodes a commercial approval capability in the template itself", () => {
    const admin = ROLE_FEATURE_TEMPLATES["it-system-administrator"] ?? [];
    // Authority over discounts, voids, refunds and reversals comes from the
    // configured approval matrix, never from holding the superuser role.
    for (const entry of admin) {
      expect(entry).not.toMatch(/\b(voids|discounts|complimentary|refunds)\b/);
    }
  });
});
