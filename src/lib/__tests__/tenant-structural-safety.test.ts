/**
 * Structural tenant safety.
 *
 * Channel: read-only SQL (PG* environment). Two standing guarantees are
 * asserted here rather than described anywhere:
 *
 *  1. Critical relationships (rooms, guests, folios, sales, procurement,
 *     stock, assets) are tenant-safe at database level, so a record can never
 *     point at another workspace's record even if application code slips.
 *  2. Every privileged (SECURITY DEFINER) routine a signed-in session can call
 *     establishes workspace context itself, or is a documented exception.
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

/** Child table -> the composite, workspace-aware constraint it must carry. */
const TENANT_SAFE_FKS: Array<[string, string]> = [
  ["reservations", "reservations_room_tenant_fkey"],
  ["reservations", "reservations_room_type_tenant_fkey"],
  ["reservations", "reservations_rate_plan_tenant_fkey"],
  ["reservations", "reservations_customer_tenant_fkey"],
  ["folio_lines", "folio_lines_folio_tenant_fkey"],
  ["folio_lines", "folio_lines_reservation_tenant_fkey"],
  ["pos_order_items", "pos_order_items_order_tenant_fkey"],
  ["pos_order_items", "pos_order_items_menu_item_tenant_fkey"],
  ["purchase_orders", "purchase_orders_supplier_tenant_fkey"],
  ["purchase_orders", "purchase_orders_request_tenant_fkey"],
  ["stock_movements", "stock_movements_item_tenant_fkey"],
  ["assets", "assets_department_tenant_fkey"],
  ["assets", "assets_category_tenant_fkey"],
];

/**
 * Privileged routines a signed-in session may call that legitimately carry no
 * workspace lookup of their own. Each is either evaluated inside an access rule
 * that already supplies the scope, or touches no tenant data at all.
 */
const DOCUMENTED_EXCEPTIONS = new Set(["canonical_permission", "hr_is_self", "neo_role_permission_ids"]);

describe.runIf(HAS_SQL)("critical relationships are tenant-safe", () => {
  it("carries a composite workspace key on every critical link", () => {
    const present = new Set(
      sql(`SELECT c.relname || '|' || con.conname
             FROM pg_constraint con
             JOIN pg_class c ON c.oid = con.conrelid
            WHERE con.contype = 'f' AND con.conname LIKE '%_tenant_fkey'`).map((r) => r[0] ?? ""),
    );
    const missing = TENANT_SAFE_FKS.filter(([t, n]) => !present.has(`${t}|${n}`)).map(([t, n]) => `${t}.${n}`);
    expect(missing).toEqual([]);
  });

  it("references the parent by workspace and identifier together", () => {
    const wrong = sql(`
      SELECT con.conname
        FROM pg_constraint con
       WHERE con.contype = 'f' AND con.conname LIKE '%_tenant_fkey'
         AND array_length(con.conkey, 1) <> 2`).map((r) => r[0] ?? "");
    expect(wrong).toEqual([]);
  });
});

describe.runIf(HAS_SQL)("privileged routines establish their own workspace context", () => {
  it("leaves no sensitive callable routine without a tenant anchor", () => {
    const rows = sql(`
      WITH f AS (
        SELECT p.proname::text AS nm,
               pg_get_functiondef(p.oid) AS def,
               has_function_privilege('authenticated', p.oid, 'execute') AS auth_exec,
               p.prorettype = 'pg_catalog.trigger'::regtype AS is_trigger
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosecdef AND p.prokind = 'f'
      )
      SELECT nm FROM f
       WHERE auth_exec AND NOT is_trigger
         AND nm ~* 'fin_|payment|mpesa|payroll|hr_|pos_|stock|inventory|import|report|integration|automation|admin|role|permission'
         AND def !~* 'current_org_id|current_organisation_id|organization_id|auth\\.uid|has_permission|neo_assert_capability|is_org_admin'
       ORDER BY nm`).map((r) => r[0] ?? "");
    expect(rows.filter((n) => !DOCUMENTED_EXCEPTIONS.has(n))).toEqual([]);
  });

  it("keeps every privileged routine on a fixed search path", () => {
    const loose = sql(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef
         AND COALESCE(p.proconfig::text, '') NOT ILIKE '%search_path%'`).map((r) => r[0] ?? "");
    expect(loose).toEqual([]);
  });

  it("exposes only the deliberate signed-out routine", () => {
    const anon = sql(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef
         AND has_function_privilege('anon', p.oid, 'execute') ORDER BY 1`).map((r) => r[0] ?? "");
    // The branded property entrance is the second deliberate exception: it
    // resolves a hotel's public identity for its own sign-in page and grants
    // nothing; entering the property is a signed-in-only routine.
    // Plus the NEØ front door reads: public hotel list, public hotel page and
    // entrance states. Published data only; entering still requires a real
    // relationship resolved after sign-in.
    expect(anon).toEqual([
      "neo_property_doors",
      "neo_property_entrance",
      "neo_public_directory",
      "neo_public_experiences",
      "neo_public_menu",
      "neo_public_property",
    ]);
  });
});
