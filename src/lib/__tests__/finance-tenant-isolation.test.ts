/**
 * P0 — Finance multi-tenant isolation contract.
 *
 * Defect: a brand-new workspace saw Finance journals, receivables and money
 * belonging to another workspace. Root cause was the RLS pattern
 *
 *     <scope predicate> OR is_org_admin()
 *
 * `is_org_admin()` describes the CALLER ("am I an admin of my own workspace?"),
 * never the ROW, so the disjunct removed every organisation constraint for
 * owners and system administrators — exactly the roles a fresh workspace
 * signs in as.
 *
 * These tests inspect the live catalogue and assert:
 *   - every Finance-bearing read/write policy is anchored to
 *     `organization_id = current_org_id()`;
 *   - no Finance policy uses the bare `OR is_org_admin()` bypass; the
 *     row-aware `is_org_admin_for(organization_id)` is used instead;
 *   - `is_org_admin_for()` itself compares against `current_org_id()` and is
 *     unreachable for anonymous callers.
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

function policyExpression(table: string, policy: string): string {
  const rows = sql(
    `SELECT replace(
              coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
              coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), chr(10), ' ')
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = '${table}' AND p.polname = '${policy}'`,
  );
  return rows[0]?.[0] ?? "";
}

/** Finance-bearing policies that must never leave the signed-in workspace. */
const FINANCE_POLICIES: Array<[table: string, policy: string]> = [
  ["journal_entries", "finance_read_journal_entries"],
  ["journal_entry_lines", "finance_read_journal_entry_lines"],
  ["invoices", "finance_read_invoices"],
  ["invoices", "finance_update_invoices"],
  ["invoice_lines", "finance_read_invoice_lines"],
  ["payments", "staff_read_payments"],
  ["payments", "staff_update_payments"],
  ["supplier_invoices", "supplier_invoices_select"],
  ["goods_receipts", "goods_receipts_select"],
  ["budgets", "finance_read_budgets"],
  ["budgets", "finance_update_budgets"],
];

describe.skipIf(!HAS_SQL)("finance tenant isolation", () => {
  it.each(FINANCE_POLICIES)("%s.%s is anchored to the signed-in organisation", (table, policy) => {
    const expr = policyExpression(table, policy);
    expect(expr, `${table}.${policy} is missing`).not.toBe("");
    expect(expr).toContain("current_org_id()");
  });

  it.each(FINANCE_POLICIES)("%s.%s has no bare admin bypass", (table, policy) => {
    const expr = policyExpression(table, policy);
    // `is_org_admin()` with no argument evaluates the caller, not the row.
    expect(expr).not.toMatch(/is_org_admin\(\)/);
  });

  it("goods receipt lines inherit the parent receipt's organisation", () => {
    const expr = policyExpression("goods_receipt_lines", "goods_receipt_lines_select");
    expect(expr).toContain("current_org_id()");
    expect(expr).not.toMatch(/is_org_admin\(\)/);
  });

  it("is_org_admin_for compares the row organisation with the caller's", () => {
    const [row] = sql(
      `SELECT replace(pg_get_functiondef(p.oid), chr(10), ' ')
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'is_org_admin_for' LIMIT 1`,
    );
    const def = row?.[0] ?? "";
    expect(def).not.toBe("");
    expect(def).toContain("current_org_id()");
    expect(def).toContain("is_org_admin()");
  });

  it("is_org_admin_for is unreachable for anonymous callers", () => {
    const [row] = sql(
      `SELECT has_function_privilege('anon', 'public.is_org_admin_for(uuid)', 'EXECUTE')::text`,
    );
    expect(row?.[0]).toBe("false");
  });

  it("no finance table keeps an unscoped admin bypass", () => {
    const rows = sql(
      `SELECT c.relname || '.' || p.polname
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN ('journal_entries','journal_entry_lines','invoices','invoice_lines',
                            'payments','supplier_invoices','goods_receipts','goods_receipt_lines','budgets')
          AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
               coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) ~ 'is_org_admin\\(\\)'
          AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
               coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) !~ 'current_org_id\\(\\)'`,
    );
    expect(rows.map((r) => r[0])).toEqual([]);
  });
});
