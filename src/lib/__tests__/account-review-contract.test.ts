/**
 * Review-before-change contract.
 *
 * Covers the four review surfaces: the permission before/after diff, the guided
 * two-factor workflow, the audit history panel and the impact previews. These
 * tests exist so a later UI simplification cannot quietly remove the review
 * step or start surfacing credential material.
 */

import { describe, expect, it } from "vitest";
import {
  describePermissionDiff,
  diffPermissionSets,
  groupPermissionsByModule,
  isEmptyDiff,
  permissionKey,
  permissionLabel,
  type PermissionRef,
} from "@/lib/permission-diff";
import {
  accountActionImpact,
  mfaStateFromFactors,
  mfaWorkflow,
  passwordWorkflow,
} from "@/lib/account-impact";
import {
  auditActionLabel,
  auditFieldDiff,
  classifyAuditAction,
  filterAuditRows,
  isSecretKey,
  redactAuditValue,
  type AuditRow,
} from "@/lib/audit-history";
import { USER_ACTIONS } from "@/lib/user-actions";

const refs: PermissionRef[] = [
  { id: "p1", module: "restaurant", feature: "floor", action: "view" },
  { id: "p2", module: "restaurant", feature: "floor", action: "edit" },
  { id: "p3", module: "finance", feature: "journals", action: "approve" },
  { id: "p4", module: "finance", feature: null, action: "view" },
];
const index = new Map(refs.map((r) => [r.id, r]));

describe("permission before/after diff", () => {
  it("reports exactly what is granted and removed", () => {
    const diff = diffPermissionSets(["p1", "p3"], ["p1", "p2", "p4"], index);
    expect(diff.added.map((r) => r.id)).toEqual(["p4", "p2"].sort((a, b) =>
      permissionKey(index.get(a)!).localeCompare(permissionKey(index.get(b)!)),
    ));
    expect(diff.removed.map((r) => r.id)).toEqual(["p3"]);
    expect(diff.unchanged).toBe(1);
    expect(diff.total).toBe(3);
    expect(isEmptyDiff(diff)).toBe(false);
    expect(describePermissionDiff(diff)).toBe("2 added · 1 removed");
  });

  it("treats an unchanged selection as nothing to save", () => {
    const diff = diffPermissionSets(["p1", "p2"], ["p2", "p1"], index);
    expect(isEmptyDiff(diff)).toBe(true);
    expect(describePermissionDiff(diff)).toBe("No pending changes");
  });

  it("still reports a permission missing from the catalogue", () => {
    const diff = diffPermissionSets(["ghost"], [], index);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]!.id).toBe("ghost");
  });

  it("groups by module and labels whole-module grants", () => {
    const groups = groupPermissionsByModule(refs);
    expect(groups.map((g) => g.module)).toEqual(["finance", "restaurant"]);
    expect(permissionLabel(refs[3]!)).toContain("Whole module");
  });
});

describe("guided two-factor workflow", () => {
  it("offers a reset only where there is an enrolment to clear", () => {
    expect(mfaWorkflow(mfaStateFromFactors(2), 2).canReset).toBe(true);
    const none = mfaWorkflow(mfaStateFromFactors(0), 0);
    expect(none.canReset).toBe(false);
    expect(none.blockedReason).toBeTruthy();
    expect(mfaWorkflow(mfaStateFromFactors(null), null).canReset).toBe(false);
  });

  it("never describes a secret, code or device identifier", () => {
    for (const state of ["enrolled", "not_enrolled", "unknown"] as const) {
      const flow = mfaWorkflow(state, 1);
      const text = `${flow.label} ${flow.detail} ${flow.guidance}`;
      expect(/secret value|recovery code:|factor id|token/i.test(text)).toBe(false);
    }
  });

  it("matches the password step to the outstanding requirement", () => {
    expect(passwordWorkflow({ must_change_password: true }).requirementOutstanding).toBe(true);
    expect(passwordWorkflow({ must_change_password: null }).requirementOutstanding).toBe(false);
  });
});

describe("impact previews", () => {
  const target = {
    account_status: "active",
    must_change_password: false,
    email: "person@example.com",
    isOwner: false,
  };

  it("covers every confirmable account action with changes and a reversibility verdict", () => {
    for (const action of USER_ACTIONS.filter((a) => a.confirm)) {
      const impact = accountActionImpact(action.id, { target });
      expect(impact.headline.length).toBeGreaterThan(0);
      expect(impact.changes.length).toBeGreaterThan(0);
      expect(typeof impact.reversible).toBe("boolean");
    }
  });

  it("marks lock/suspend reversible and offboarding irreversible", () => {
    expect(accountActionImpact("suspend", { target }).reversible).toBe(true);
    expect(accountActionImpact("offboard", { target }).reversible).toBe(false);
    expect(accountActionImpact("reset_password", { target }).reversible).toBe(false);
  });

  it("states that suspension does not change employment status", () => {
    const impact = accountActionImpact("suspend", { target });
    expect(impact.unchanged.join(" ")).toMatch(/employment/i);
  });

  it("blocks a two-factor reset when nothing is enrolled", () => {
    expect(accountActionImpact("reset_mfa", { target, mfaState: "not_enrolled" }).blocked).toBeTruthy();
    expect(accountActionImpact("reset_mfa", { target, mfaState: "enrolled" }).blocked).toBeUndefined();
  });

  it("reflects the offboarding access choice", () => {
    const kept = accountActionImpact("offboard", { target, revokeAccess: false });
    expect(kept.changes.join(" ")).toMatch(/left in place/i);
    const closed = accountActionImpact("offboard", { target, revokeAccess: true });
    expect(closed.changes.join(" ")).toMatch(/revoked/i);
  });

  it("promises the existing password is never shown", () => {
    const impact = accountActionImpact("reset_password", { target });
    expect(impact.unchanged.join(" ")).toMatch(/never shown/i);
  });
});

describe("audit history panel", () => {
  const rows: AuditRow[] = [
    {
      id: "a",
      created_at: "2026-01-10T08:00:00.000Z",
      action: "user.mfa_reset",
      module: "administration",
      user_name: "Amina Owner",
      reason: "Lost phone",
      previous_value: { factors: 1 },
      new_value: { factors: 0 },
    },
    {
      id: "b",
      created_at: "2026-02-01T08:00:00.000Z",
      action: "user.account_status_changed",
      module: "administration",
      user_name: "Sys Admin",
      reason: null,
      previous_value: { account_status: "active" },
      new_value: { account_status: "suspended" },
    },
    {
      id: "c",
      created_at: "2026-02-02T08:00:00.000Z",
      action: "user.role_assigned",
      module: "administration",
      user_name: null,
      previous_value: null,
      new_value: { role: "Front Office Manager" },
    },
  ];

  it("classifies entries into review categories", () => {
    expect(classifyAuditAction("user.mfa_reset")).toBe("security");
    expect(classifyAuditAction("user.account_status_changed")).toBe("status");
    expect(classifyAuditAction("user.role_assigned")).toBe("assignment");
    expect(classifyAuditAction("user.photo_updated")).toBe("profile");
    expect(classifyAuditAction("something.else")).toBe("other");
  });

  it("filters by category, text and date range", () => {
    expect(filterAuditRows(rows, { category: "security" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterAuditRows(rows, { search: "sys admin" }).map((r) => r.id)).toEqual(["b"]);
    expect(filterAuditRows(rows, { search: "lost phone" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterAuditRows(rows, { from: "2026-02-01", to: "2026-02-01" }).map((r) => r.id)).toEqual([
      "b",
    ]);
  });

  it("shows field-level before and after state", () => {
    const diff = auditFieldDiff(rows[1]!.previous_value, rows[1]!.new_value);
    expect(diff).toEqual([{ field: "account_status", before: "active", after: "suspended" }]);
  });

  it("redacts any credential-bearing key from an audit payload", () => {
    const redacted = redactAuditValue({
      password: "hunter2",
      password_hash: "$2a$x",
      access_token: "t",
      recovery_codes: ["a"],
      nested: { api_key: "k", account_status: "active" },
      must_change_password: true,
    });
    expect(redacted).toEqual({
      nested: { account_status: "active" },
      must_change_password: true,
    });
    expect(isSecretKey("must_change_password")).toBe(false);
    expect(isSecretKey("mfa_secret")).toBe(true);
    const diff = auditFieldDiff({ password: "a" }, { password: "b" });
    expect(diff).toEqual([]);
  });

  it("labels actions readably", () => {
    expect(auditActionLabel("user.mfa_reset")).toBe("Mfa reset");
  });
});
