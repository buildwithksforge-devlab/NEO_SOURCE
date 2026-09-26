import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Signing in must READ authorisation and never write it: no adoption, no
 * recovery, no permission backfill and no role grants may run on login or
 * refresh. This test reads the auth provider source directly, so the rule
 * cannot silently regress in a later change.
 */
const authSource = readFileSync("src/lib/auth.tsx", "utf8");

const FORBIDDEN_ON_SIGN_IN = [
  "neo_adopt_modern_model",
  "neo_provision_workspace_for",
  "neo_provision_worker",
  "neo_reconcile_workspace",
  "neo_classify_roles",
  "neo_align_departments",
  "neo_consolidate_duplicate_roles",
  "provision_catalogue_roles",
  "apply_recommended_permissions",
  "neo_autoseed_role_aliases",
];

describe("sign-in never provisions", () => {
  it.each(FORBIDDEN_ON_SIGN_IN)("does not call %s during sign-in", (fn) => {
    expect(authSource.includes(fn)).toBe(false);
  });

  it("does not write to role or permission tables from the auth provider", () => {
    const writes = [
      'from("user_roles")',
      'from("role_permissions")',
      'from("roles")',
      'from("permissions")',
    ];
    for (const w of writes) {
      const idx = authSource.indexOf(w);
      if (idx === -1) continue;
      const following = authSource.slice(idx, idx + 200);
      expect(/\.(insert|update|upsert|delete)\(/.test(following), `${w} is written on sign-in`).toBe(
        false,
      );
    }
  });

  it("resolves access through the read-only effective-access resolver", () => {
    expect(authSource.includes('guardedRpc(supabase, "my_effective_access")')).toBe(true);
  });
});
