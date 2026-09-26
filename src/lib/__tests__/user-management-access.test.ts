import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { capabilityForPath } from "@/lib/capabilities";
import { canAccessPath } from "@/lib/nav-permissions";
import { buildUserActionMenu } from "@/lib/user-actions";


/**
 * Direct-URL protection for staff administration.
 *
 * Hiding a menu entry is presentation only. Every administration path must
 * resolve to an explicit `module.feature.action` capability so the route gate
 * refuses it, and every staff-administration server function must re-check the
 * same authority server-side — a typed URL must never reach an action.
 */
const ADMIN_PATHS: Array<[string, string, string, string]> = [
  ["/users", "administration", "users", "view"],
  ["/roles", "administration", "roles", "view"],
  ["/departments", "administration", "departments", "view"],
  ["/stations", "administration", "stations", "view"],
  ["/audit-logs", "administration", "audit-logs", "view"],
  ["/settings", "administration", "settings", "edit"],
  ["/admin", "administration", "workspace", "edit"],
  ["/admin/user-defaults", "administration", "users", "edit"],
  ["/admin/role-testing", "administration", "roles", "edit"],
  ["/admin/access-matrix", "administration", "roles", "edit"],
];

describe("user-management route scope", () => {
  it.each(ADMIN_PATHS)("%s demands %s.%s.%s", (path, module, feature, action) => {
    const cap = capabilityForPath(path);
    expect(cap).not.toBeNull();
    expect(cap).toMatchObject({ module, feature, action });
  });

  it.each(ADMIN_PATHS)("%s is refused without the grant", (path) => {
    expect(canAccessPath(() => false, path)).toBe(false);
  });

  it.each(ADMIN_PATHS)("%s is allowed only for its own capability", (path, module, feature, action) => {
    const can = (m: string, f: string, a?: string) =>
      m === module && f === feature && (a ?? "view") === action;
    expect(canAccessPath(can, path)).toBe(true);
    // A grant on a neighbouring feature must not open this path.
    expect(canAccessPath((m, f, a) => can(m, f, a) && f !== feature, path)).toBe(false);
  });
});

describe("staff administration server functions", () => {
  const source = readFileSync("src/lib/users.functions.ts", "utf8");

  it("guards every exported server function with a capability check", () => {
    const blocks = source.split(/export const /).slice(1);
    const serverFns = blocks.filter((b) => b.includes("createServerFn"));
    expect(serverFns.length).toBeGreaterThan(0);
    for (const block of serverFns) {
      const name = block.slice(0, block.indexOf(" "));
      expect(block.includes("requireSupabaseAuth"), `${name} must require a session`).toBe(true);
      expect(block.includes("requireCapability("), `${name} must check a capability`).toBe(true);
    }
  });
});

describe("owner assignment authority", () => {
  const source = readFileSync("src/lib/users.functions.ts", "utf8");

  it("exposes deliberate assign and remove Owner server functions", () => {
    expect(source).toContain("assignOwnerRole");
    expect(source).toContain("removeOwnerRole");
    expect(source).toContain("neo_assign_owner_role");
    expect(source).toContain("neo_remove_owner_role");
  });

  it("guards both with the single canonical assign_owner capability", () => {
    for (const fn of ["assignOwnerRole", "removeOwnerRole"]) {
      const block = source.slice(source.indexOf(`export const ${fn}`));
      expect(block.slice(0, 1200)).toContain('requireCapability(supabase, "users", "assign_owner")');
    }
  });

  it("requires a reason on every Owner change", () => {
    for (const fn of ["assignOwnerRole", "removeOwnerRole"]) {
      const block = source.slice(source.indexOf(`export const ${fn}`), source.length).slice(0, 1200);
      expect(block).toContain("reason");
    }
  });

  it("never authorises Owner work by role name, job title or email", () => {
    const page = readFileSync("src/routes/_shell.users.tsx", "utf8");
    for (const forbidden of [
      'can("administration", "users", "view") && isAdmin === false',
      "job_title === 'Owner'",
      'role_name === "Owner"',
    ]) {
      expect(page.includes(forbidden)).toBe(false);
    }
    expect(page).toContain('can("administration", "users", "assign_owner")');
  });

  it("offers Activate only to accounts that are not already active", () => {
    const menu = (status: string) =>
      buildUserActionMenu(() => true, true, {
        id: "u1",
        email: "a@b.test",
        account_status: status,
        employment_status: null,
        must_change_password: false,
        invitation_status: null,
        mfa_enrolled: false,
        isSelf: false,
        isOwner: false,
      }).flatMap((g) => g.actions.map((a) => a.id));
    expect(menu("active")).toContain("suspend");
    expect(menu("active")).not.toContain("activate");
    expect(menu("suspended")).toContain("activate");
    expect(menu("suspended")).not.toContain("suspend");
  });
});

