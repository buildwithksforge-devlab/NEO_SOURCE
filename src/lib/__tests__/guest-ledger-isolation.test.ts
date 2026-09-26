/**
 * Guest-ledger and general-ledger isolation contract.
 *
 * Certification finding: guest folios, folio lines, folio allocations and
 * guest payments were readable by ANY staff member inside the branch scope
 * (kitchen, housekeeping, laundry, maintenance, riders, waiters), and the
 * general ledger was readable by anybody holding a module-wide
 * `finance.*.view` grant (delivery, events, procurement managers).
 *
 * These tests inspect the live catalogue and assert the tightened contract:
 *   - the sensitive read policies delegate to the capability helpers;
 *   - the helpers use the strict (non-wildcard) capability check, so a
 *     module-wide '*' feature grant does not unlock a sensitive feature;
 *   - the helpers stay unreachable for the anonymous role.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const HAS_SQL = Boolean(process.env["PGHOST"]);

function sql(query: string): string[][] {
  const out = execFileSync("psql", ["-At", "-F", "\u0001", "-c", query], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.split("\u0001"));
}

function readPolicy(table: string, policy: string): string {
  const rows = sql(
    `SELECT replace(coalesce(pg_get_expr(p.polqual, p.polrelid), ''), chr(10), ' ')
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = '${table}' AND p.polname = '${policy}'`,
  );
  return rows[0]?.[0] ?? "";
}

function routineDefinition(name: string): string {
  const rows = sql(
    `SELECT replace(pg_get_functiondef(p.oid), chr(10), ' ')
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = '${name}' LIMIT 1`,
  );
  return rows[0]?.[0] ?? "";
}

const GUEST_LEDGER_READS: Array<[table: string, policy: string]> = [
  ["folios", "staff_read_folios"],
  ["folio_lines", "staff_read_folio_lines"],
  ["folio_allocations", "staff_read_folio_allocations"],
  ["payments", "staff_read_payments"],
];

const GENERAL_LEDGER_READS: Array<[table: string, policy: string]> = [
  ["journal_entries", "finance_read_journal_entries"],
  ["journal_entry_lines", "finance_read_journal_entry_lines"],
];

describe.runIf(HAS_SQL)("guest ledger isolation", () => {
  it.each(GUEST_LEDGER_READS)("%s.%s requires the guest-ledger capability", (table, policy) => {
    const expr = readPolicy(table, policy);
    expect(expr, `${table}.${policy} is missing`).not.toBe("");
    expect(expr).toContain("can_read_guest_ledger");
    // Branch/tenant scope must still be part of the same predicate.
    expect(expr).toMatch(/in_my_branch_scope|current_org_id/);
  });

  it.each(GENERAL_LEDGER_READS)("%s.%s requires the books capability", (table, policy) => {
    const expr = readPolicy(table, policy);
    expect(expr, `${table}.${policy} is missing`).not.toBe("");
    // The books need a permission that names journals, ledger or the chart of
    // accounts. Receivables visibility (events, procurement) is not enough.
    expect(expr).toContain("can_read_journals");
    expect(expr).not.toMatch(/has_permission\('finance'::text, 'view'::text\)/);
  });

  it("the books capability ignores a module-wide finance grant", () => {
    const def = routineDefinition("can_read_journals");
    expect(def, "can_read_journals is missing").not.toBe("");
    expect(def).toMatch(/'journals'/);
    expect(def).toMatch(/'ledger'/);
    expect(def).not.toContain("has_exact_permission");
  });

  it("invoices are readable only by ledger readers or their creator", () => {
    const expr = readPolicy("invoices", "finance_read_invoices");
    expect(expr).toContain("can_read_general_ledger");
    expect(expr).not.toMatch(/has_permission\('finance'::text, 'view'::text\)/);
  });

  it("the capability helpers use the strict, non-wildcard permission check", () => {
    for (const helper of ["can_read_guest_ledger", "can_read_general_ledger"]) {
      const def = routineDefinition(helper);
      expect(def, `${helper} is missing`).not.toBe("");
      expect(def).toContain("has_exact_permission");
      expect(def).toContain("is_active_staff");
    }
  });

  it("has_exact_permission does not accept a wildcard feature grant", () => {
    const def = routineDefinition("has_exact_permission");
    expect(def).not.toBe("");
    // The grant branch matches the feature exactly; only denials may widen.
    expect(def).toContain("h.feature = w.feature");
    expect(def).not.toContain("h.feature IN (w.feature, '*')");
  });

  it("keeps the ledger helpers and the folio lookup away from anonymous callers", () => {
    const rows = sql(
      `SELECT p.proname
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('can_read_guest_ledger','can_read_general_ledger','has_exact_permission','pos_open_folio_for_stay')
          AND has_function_privilege('anon', p.oid, 'EXECUTE')`,
    );
    expect(rows.map((r) => r[0])).toEqual([]);
  });

  it("service staff resolve an open room account through the guarded lookup", () => {
    const def = routineDefinition("pos_open_folio_for_stay");
    expect(def).not.toBe("");
    expect(def).toContain("SECURITY DEFINER");
    expect(def).toContain("in_my_branch_scope");
    expect(def).toContain("Not authorized");
  });
});
