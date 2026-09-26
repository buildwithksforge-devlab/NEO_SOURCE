import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  USER_ACTIONS,
  authorisedUserActionIds,
  buildUserActionMenu,
  copyableAccountDetails,
  type CanFn,
  type UserActionTarget,
} from "@/lib/user-actions";

/**
 * The Users page three-dot menu is the account administration surface. These
 * tests pin the catalogue so a future visual simplification cannot silently
 * remove administrative controls, and so the authority boundaries hold:
 * superusers see everything, HR sees staff-record actions only, and ordinary
 * managers see no password/session/MFA/account-admin controls at all.
 */

const target = (over: Partial<UserActionTarget> = {}): UserActionTarget => ({
  id: "u1",
  email: "person@hotel.test",
  account_status: "active",
  employment_status: "full-time",
  must_change_password: false,
  invitation_status: "sent",
  mfa_enrolled: true,
  isSelf: false,
  isOwner: false,
  ...over,
});

const REQUIRED_ACTIONS = [
  "view_profile",
  "copy_details",
  "manage_photo",
  "edit_assignment",
  "manage_roles",
  "individual_permission",
  "assign_owner",
  "reset_password",
  "require_password_change",
  "clear_password_requirement",
  "resend_invitation",
  "revoke_sessions",
  "reset_mfa",
  "view_security",
  "suspend",
  "deactivate",
  "offboard",
  "delete_account",
  "view_audit",
];

const SECURITY_ONLY = [
  "reset_password",
  "require_password_change",
  "clear_password_requirement",
  "resend_invitation",
  "revoke_sessions",
  "reset_mfa",
  "suspend",
  "deactivate",
  "activate",
  "delete_account",
  "individual_permission",
  "assign_owner",
  "remove_owner",
];

const deny: CanFn = () => false;

describe("account administration catalogue", () => {
  it("keeps the full administrative action set available", () => {
    const ids = USER_ACTIONS.map((a) => a.id);
    for (const required of REQUIRED_ACTIONS) expect(ids).toContain(required);
  });

  it("gives superusers the complete catalogue", () => {
    const ids = authorisedUserActionIds(deny, true);
    expect(ids.sort()).toEqual(USER_ACTIONS.map((a) => a.id).sort());
  });

  it("groups every action under a heading the menu renders", () => {
    const groups = buildUserActionMenu(deny, true, target({ must_change_password: true }));
    const rendered = [
      ...groups.flatMap((g) => g.actions.map((a) => a.id)),
      ...buildUserActionMenu(deny, true, target()).flatMap((g) => g.actions.map((a) => a.id)),
    ];
    for (const required of REQUIRED_ACTIONS) expect(rendered).toContain(required);
    expect(groups.every((g) => g.label.length > 0)).toBe(true);
  });


  it("offers HR its staff-record subset without security powers", () => {
    // HR capability template: human-resources.* plus administration.users with
    // lead actions (view/create/edit/approve/export/print).
    const hrCan: CanFn = (module, feature, action) => {
      if (module === "human-resources") return true;
      if (module === "administration" && feature === "users")
        return ["view", "create", "edit", "approve", "export", "print"].includes(action ?? "view");
      return false;
    };
    const ids = authorisedUserActionIds(hrCan, false);
    expect(ids).toContain("edit_assignment");
    expect(ids).toContain("manage_photo");
    expect(ids).toContain("view_profile");
    expect(ids).toContain("offboard");
    for (const restricted of SECURITY_ONLY) expect(ids).not.toContain(restricted);
  });

  it("accepts the existing plural assignment capabilities HR already holds", () => {
    // Savannah's Human Resources Manager holds the plural vocabulary.
    const pluralHr: CanFn = (module, feature, action) =>
      module === "administration" &&
      feature === "users" &&
      ["view", "assign_branches", "assign_departments", "assign_stations"].includes(
        action ?? "view",
      );
    const ids = authorisedUserActionIds(pluralHr, false);
    expect(ids).toContain("edit_assignment");
    expect(ids).toContain("manage_roles");
    for (const restricted of SECURITY_ONLY) expect(ids).not.toContain(restricted);
    expect(ids).not.toContain("reset_password");
  });

  it("labels the password action as a reset, never as a revealed secret", () => {
    const action = USER_ACTIONS.find((a) => a.id === "reset_password");
    expect(action?.label).toBe("Reset password…");
    const superIds = buildUserActionMenu(deny, true, target()).flatMap((g) =>
      g.actions.map((a) => a.label),
    );
    expect(superIds).toContain("Reset password…");
  });

  it("gives ordinary managers and line staff no account administration", () => {
    const managerCan: CanFn = (module) => module !== "administration" && module !== "human-resources";
    const ids = authorisedUserActionIds(managerCan, false);
    for (const restricted of SECURITY_ONLY) expect(ids).not.toContain(restricted);
    expect(buildUserActionMenu(managerCan, false, target())).toHaveLength(0);
  });

  it("hides actions that cannot apply to the record's state", () => {
    const superAll = (t: UserActionTarget) =>
      buildUserActionMenu(deny, true, t).flatMap((g) => g.actions.map((a) => a.id));

    const active = superAll(target({ account_status: "active" }));
    expect(active).toContain("suspend");
    expect(active).not.toContain("activate");

    const suspended = superAll(target({ account_status: "suspended" }));
    expect(suspended).toContain("activate");
    expect(suspended).not.toContain("suspend");

    const mustChange = superAll(target({ must_change_password: true }));
    expect(mustChange).toContain("clear_password_requirement");
    expect(mustChange).not.toContain("require_password_change");

    const noEmail = superAll(target({ email: null }));
    expect(noEmail).not.toContain("resend_invitation");

    const self = superAll(target({ isSelf: true }));
    expect(self).not.toContain("delete_account");
    expect(self).not.toContain("suspend");

    const owner = superAll(target({ isOwner: true }));
    expect(owner).toContain("remove_owner");
    expect(owner).not.toContain("assign_owner");
  });

  it("demands a reason for every consequential action", () => {
    for (const id of ["suspend", "deactivate", "delete_account", "assign_owner", "remove_owner"]) {
      const action = USER_ACTIONS.find((a) => a.id === id);
      expect(action?.requiresReason, `${id} must collect a reason`).toBe(true);
      expect(action?.confirm, `${id} must confirm`).toBe(true);
    }
  });

  it("never offers to reveal a password or any secret", () => {
    for (const action of USER_ACTIONS) {
      expect(action.label.toLowerCase()).not.toMatch(/view password|show password|reveal|token|hash/);
    }
    const copied = copyableAccountDetails({
      full_name: "Ada Wanjiru",
      staff_id: "STF-0001",
      email: "ada@hotel.test",
    });
    expect(copied).toContain("STF-0001");
    expect(copied.toLowerCase()).not.toMatch(/password|token|hash/);
  });
});

describe("server-side authority for the restored actions", () => {
  const source = readFileSync("src/lib/users.functions.ts", "utf8");
  const page = readFileSync("src/routes/_shell.users.tsx", "utf8");

  it("implements each mutating action as a guarded server function", () => {
    for (const fn of [
      "resetStaffPassword",
      "requireStaffPasswordChange",
      "clearStaffPasswordRequirement",
      "revokeStaffSessions",
      "resetStaffMfa",
      "setStaffAccountStatus",
      "offboardStaffAccount",
      "deleteStaffAccount",
      "getStaffSecurityMetadata",
    ]) {
      expect(source, `${fn} must exist`).toContain(`export const ${fn} = createServerFn`);
      const block = source.split(`export const ${fn} = createServerFn`)[1]!.split("export const ")[0] ?? "";
      expect(block.includes("requireSupabaseAuth"), `${fn} needs a session`).toBe(true);
      expect(block.includes("requireCapability("), `${fn} needs a capability check`).toBe(true);
    }
  });

  it("audits every account mutation with actor, target and state", () => {
    for (const action of [
      "user.password_reset",
      "user.password_change_required",
      "user.password_change_requirement_cleared",
      "user.sessions_revoked",
      "user.mfa_reset",
      "user.offboarded",
      "user.account_deleted",
    ]) {
      expect(source).toContain(action);
    }
    expect(source).toContain("audit_logs");
  });

  it("never reads or returns an existing password", () => {
    expect(source).not.toMatch(/encrypted_password|password_hash/);
    const metadata = source.split("export const getStaffSecurityMetadata")[1]!;
    expect(metadata.split("export const ")[0]).not.toMatch(/\bpassword:/);
  });

  it("renders the menu from the shared catalogue rather than ad-hoc markup", () => {
    expect(page).toContain("buildUserActionMenu");
    // A future edit that drops the catalogue import would fail here.
    expect(page).toContain('from "@/lib/user-actions"');
  });

  it("keeps the official photo owned by HR/Owner/System Administration", () => {
    const photo = USER_ACTIONS.find((a) => a.id === "manage_photo");
    expect(photo?.capability).toEqual({
      module: "human-resources",
      feature: "staff-photos",
      action: "manage",
    });
    expect(photo?.alt ?? []).toHaveLength(0);
  });
});
