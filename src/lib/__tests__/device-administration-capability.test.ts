import { describe, expect, it } from "vitest";
import { capabilityForPath, moduleFeatures } from "@/lib/capabilities";
import { ROLE_FEATURE_TEMPLATES, compileRoleTemplate } from "@/lib/role-templates";

describe("approved device administration capability", () => {
  it("uses the dedicated device capability, leaving user management separate", () => {
    expect(capabilityForPath("/device-authorisation")).toEqual({
      module: "administration",
      feature: "devices",
      action: "manage",
    });
  });
  it("opens device and PIN administration only for the two approved role templates", () => {
    const permitted = Object.keys(ROLE_FEATURE_TEMPLATES)
      .filter((role) =>
        compileRoleTemplate(role, moduleFeatures()).some(
          (grant) =>
            grant.module === "administration" &&
            grant.feature === "devices" &&
            grant.action === "manage",
        ),
      )
      .sort();
    expect(permitted).toEqual(["it-system-administrator", "owner"]);
  });
  it.each(["owner", "it-system-administrator"])(
    "does not add broader user-management authority to %s",
    (role) => {
      expect(
        compileRoleTemplate(role, moduleFeatures()).some(
          (grant) =>
            grant.module === "administration" &&
            grant.feature === "users" &&
            grant.action === "manage",
        ),
      ).toBe(false);
    },
  );
});
