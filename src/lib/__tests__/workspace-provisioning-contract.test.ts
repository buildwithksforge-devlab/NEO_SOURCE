import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrations = readFileSync(
  "supabase/migrations/20260916051815_941b2bf1-8d96-42df-a55a-6d104ffc0cb1.sql",
  "utf8",
);
const hardening = readFileSync(
  "supabase/migrations/20260916052010_56c0da9d-da54-4f70-ae0d-0bea8f070cc0.sql",
  "utf8",
);
const provisioning = readFileSync("src/lib/workspace-provisioning.ts", "utf8");
const auth = readFileSync("src/lib/auth.tsx", "utf8");

describe("creator-bound workspace provisioning", () => {
  it("requires an attempt bound to the exact authenticated user", () => {
    expect(migrations).toContain("WHERE x.user_id = _uid");
    expect(migrations).not.toContain("lower(x.email) = lower(email_address)");
    expect(migrations).not.toContain("lower(o.name) = lower(workspace_name)");
  });

  it("does not stop repairing merely because one role exists", () => {
    expect(migrations).not.toMatch(/IF EXISTS[\s\S]{0,160}user_roles[\s\S]{0,160}RETURN jsonb_build_object\('status','existing'/);
  });

  it("serialises retries and upserts every access-chain assignment", () => {
    expect(migrations).toContain("pg_advisory_xact_lock");
    expect(migrations).toContain("ON CONFLICT (user_id, role_id) DO UPDATE");
    expect(migrations).toContain("ON CONFLICT (user_id, branch_id) DO UPDATE");
    expect(migrations).toContain("ON CONFLICT (user_id, department_id) DO UPDATE");
  });

  it("requires ready administrative access before reporting success", () => {
    expect(migrations).toContain("Workspace finalisation did not produce ready Owner access");
    expect(provisioning).toContain('result.access?.state !== "ready"');
    expect(provisioning).toContain("result.access?.is_org_admin !== true");
  });

  it("keeps sign-in read-only and recovery explicit", () => {
    expect(auth).not.toContain('guardedRpc(supabase, "neo_reconcile_workspace")');
    expect(auth).toContain("recoverWorkspace: () => Promise<void>");
    expect(auth).toContain("await recoverMyWorkspace()");
  });

  it("keeps the recovery helper private and its wrapper authenticated", () => {
    expect(migrations).toContain(
      "REVOKE ALL ON FUNCTION public.neo_finalize_creator_workspace(uuid) FROM PUBLIC, anon, authenticated",
    );
    expect(migrations).toContain(
      "GRANT EXECUTE ON FUNCTION public.neo_recover_my_workspace() TO authenticated",
    );
  });

  it("refuses ordinary members and conflicting tenant evidence", () => {
    expect(hardening).toContain("An existing workspace member cannot create an Owner workspace");
    expect(hardening).toContain("An existing employee cannot convert their membership into workspace ownership");
    expect(hardening).toContain("Existing role assignments belong to another workspace");
  });
});