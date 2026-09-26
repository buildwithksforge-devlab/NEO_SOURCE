import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { interpretApplyResult, parseTemplateStatus } from "@/lib/role-template-apply";

/**
 * The defect was generic: "Apply missing (N)" reported success while N
 * permissions remained missing. These tests hold the two halves of the fix —
 * the client can never call an unverified result a success, and the database
 * resolves the template through one shared routine for both the diff and the
 * apply.
 */

const roles = [
  { role: "Finance Manager", expected: 22, added: 6 },
  { role: "Accountant", expected: 112, added: 56 },
  { role: "Barista", expected: 36, added: 29 },
  { role: "Kitchen Manager", expected: 15, added: 1 },
  { role: "Storekeeper", expected: 46, added: 0 },
];

describe("apply result interpretation", () => {
  it("reports success only when the database verified zero remaining gaps", () => {
    for (const r of roles) {
      const outcome = interpretApplyResult({ ok: true, verified: true, ...r, removed: 0, missing_after: 0, unavailable: [] });
      expect(outcome.kind, r.role).toBe("reconciled");
    }
  });

  it("treats a duplicate click (nothing added, nothing missing) as reconciled", () => {
    const outcome = interpretApplyResult({ ok: true, verified: true, role: "Barista", added: 0, missing_after: 0, expected: 36 });
    expect(outcome.kind).toBe("reconciled");
    expect(outcome.message).toContain("Already aligned");
  });

  it("never reports success when permissions remain missing", () => {
    for (const missing of [1, 6, 56]) {
      const outcome = interpretApplyResult({ ok: true, verified: true, added: 3, missing_after: missing });
      expect(outcome.kind).toBe("incomplete");
      expect(outcome.message).toContain(String(missing));
    }
  });

  it("rejects a partial or unreadable result rather than assuming success", () => {
    expect(interpretApplyResult({ ok: false, missing_after: 0 }).kind).toBe("incomplete");
    expect(interpretApplyResult(null).kind).toBe("failed");
    expect(interpretApplyResult("done").kind).toBe("failed");
  });

  it("surfaces template lines that map to no live permission", () => {
    const outcome = interpretApplyResult({
      ok: true,
      verified: true,
      added: 4,
      missing_after: 0,
      unavailable: [
        { module: "finance", action: "gl.post" },
        { module: "finance", action: "period.close" },
      ],
    });
    expect(outcome).toMatchObject({ kind: "reconciled", unavailable: 2 });
  });

  it("mentions removals only for a reset", () => {
    expect(interpretApplyResult({ ok: true, verified: true, added: 1, removed: 3, missing_after: 0 }, false).message).not.toContain("removed");
    expect(interpretApplyResult({ ok: true, verified: true, added: 1, removed: 3, missing_after: 0 }, true).message).toContain("3 removed");
  });

  it("requires explicit persisted-row verification", () => {
    expect(interpretApplyResult({ ok: true, missing_after: 0 }).kind).toBe("incomplete");
  });

  it("distinguishes approved, historical and custom role identities", () => {
    expect(parseTemplateStatus({ status: "approved", role_key: "cashier", template_rows: 22 })).toMatchObject({ status: "approved", role_key: "cashier" });
    expect(parseTemplateStatus({ status: "retired", role_key: null, template_rows: 0 }).status).toBe("retired");
    expect(parseTemplateStatus({ status: "custom", role_key: null, template_rows: 0 }).status).toBe("custom");
    expect(() => parseTemplateStatus({ status: "unknown" })).toThrow();
  });
});

describe("database reconciliation contract", () => {
  const dir = join(process.cwd(), "supabase/migrations");
  const migration = readdirSync(dir)
    .sort()
    .reverse()
    .find((f: string) => readFileSync(join(dir, f), "utf8").includes("-- Canonical, catalogue-backed role template reconciliation."));
  if (!migration) throw new Error("Canonical role-template reconciliation migration is missing");
  const latest = readFileSync(join(dir, migration), "utf8");

  it("resolves the template in one shared routine used by diff and apply", () => {
    expect(latest).toContain("FUNCTION public.canonical_role_template_key");
    expect(latest).toContain("r.normalized_role_key");
    expect(latest).toContain("role_catalogue_aliases");
    expect(latest).toContain("role_feature_templates");
    expect(latest).not.toContain("role_permission_templates");
    expect(latest).toContain("FUNCTION public.recommended_template_grants");
    expect(latest).toContain("public.recommended_template_grants(_role_id)");
    // both consumers
    expect(latest.match(/recommended_template_grants\(_role_id\)/g)!.length).toBeGreaterThan(2);
  });

  it("applies grants idempotently", () => {
    expect(latest.toLowerCase()).toContain("on conflict (role_id,permission_id) do nothing");
  });

  it("serialises concurrent reconciliation of the same role", () => {
    expect(latest).toContain("pg_advisory_xact_lock");
  });

  it("verifies persisted rows and refuses to return success while any remain missing", () => {
    expect(latest.toLowerCase()).toContain("select count(*) into _missing_after");
    expect(latest.toLowerCase()).toContain("if _missing_after > 0 then");
    expect(latest.toLowerCase()).toContain("raise exception 'reconciliation incomplete");
  });

  it("reports unavailable template lines instead of counting them as missing", () => {
    expect(latest).toContain("'unavailable'");
    expect(latest.toLowerCase()).toContain("where permission_id is null");
  });

  it("keeps the action audited and tenant-checked", () => {
    expect(latest).toContain("neo_can_manage_roles()");
    expect(latest.toLowerCase()).toContain("insert into public.audit_logs");
  });

  it("preserves intentional custom grants during reset", () => {
    expect(latest).toContain("rp.source='template'");
  });

  it("uses the same role lock for manual saves and template reconciliation", () => {
    expect(latest.match(/pg_advisory_xact_lock/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps Cashier bounded to collection, till and session operations", () => {
    expect(latest).toContain("('cashier','finance','collections','collect_payment')");
    expect(latest).toContain("('cashier','finance','till','declare_cash')");
    for (const forbidden of ["refund_payment", "reverse_payment", "reopen_period", "override", "void"]) {
      expect(latest).not.toContain(`('cashier','finance','collections','${forbidden}')`);
    }
  });
});
