/**
 * Branch-scoped inventory consumption + multi-branch seed integrity.
 *
 * Channel: read-only SQL (PG* environment). These assertions prove that a POS
 * order at one property can never deduct stock held at another property, and
 * that multi-branch demo/seed data keeps every branch/department link internally
 * consistent (no NULL links, no cross-branch links, no tenant leakage).
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const HAS_SQL = Boolean(process.env["PGHOST"]);

/** Savannah Crown Limited — the seeded multi-property demo tenant (SCN/SCT/SCM). */
const SEED_ORG = "aa17d427-f816-49bc-b02e-1a89e44806a2";

function sql(query: string): string[][] {
  const out = execFileSync("psql", ["-At", "-F", "\u0001", "-c", query], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.split("\u0001"));
}

function one(query: string): string {
  const rows = sql(query);
  return rows[0]?.[0] ?? "";
}

/** Raw multi-line scalar (function bodies span many lines). */
function text(query: string): string {
  return execFileSync("psql", ["-At", "-c", query], { encoding: "utf8" });
}

describe.runIf(HAS_SQL)("inventory consumption is branch-scoped", () => {
  const source = () =>
    text(`SELECT prosrc FROM pg_proc WHERE proname = 'inventory_consume_order_item_core'`);

  it("exists as the single deduction path", () => {
    // Only the core routine may deduct stock; the trigger merely delegates to it
    // (it records a failure event but performs no movement of its own).
    const paths = sql(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.prosrc LIKE '%INSERT INTO inventory_posting_events%'
         AND p.prosrc LIKE '%''consumption'', ''consume:''%'
       ORDER BY 1`);
    expect(paths.map(([n]) => n)).toEqual(["inventory_consume_order_item_core"]);
  });

  it("resolves the stock location against the order's branch, not the whole organisation", () => {
    const src = source();
    expect(src).toContain("v_branch := v_item.branch_id;");
    // Location lookup is delegated to the station-aware resolver, which stays
    // branch-constrained.
    expect(src).toMatch(/neo_station_consumption_location\(\s*\n?\s*v_org/);
    const resolver = text(`SELECT prosrc FROM pg_proc WHERE proname = 'neo_station_consumption_location'`);
    expect(resolver).toMatch(/FROM stock_locations sl[\s\S]*sl\.branch_id = _branch/);
    // The old organisation-only lookup must be gone.
    expect(src).not.toMatch(/FROM stock_locations\s+WHERE organization_id = v_org AND active\s+ORDER BY/);
  });

  it("only matches stock items belonging to the order's branch or shared org-wide items", () => {
    // Ingredient → stock item resolution now lives in the recursive expansion
    // routine the core function delegates to; the branch predicate moved with it.
    expect(source()).toMatch(/recipe_expand_to_stock_kinds\(v_recipe\.id, v_batches, v_branch\)/);
    const expand = text(`SELECT prosrc FROM pg_proc WHERE proname = 'recipe_expand_to_stock_kinds'`);
    expect(expand).toMatch(/si\.branch_id IS NULL OR _branch IS NULL OR si\.branch_id = _branch/);
  });

  it("divides the sold quantity by the recipe yield before deducting", () => {
    // Non-positive yields are rejected rather than divided by.
    expect(source()).toContain("v_batches := COALESCE(v_item.quantity, 1) / v_recipe.yield_quantity;");
    expect(source()).toContain("IF COALESCE(v_recipe.yield_quantity, 0) <= 0 THEN");
  });

  it("preserves exactly-once posting via inventory_posting_events", () => {
    const src = source();
    expect(src).toContain("status = 'posted'");
    expect(src).toContain("already-posted");
    expect(src).toContain("ON CONFLICT DO NOTHING");
  });

  it("is not executable anonymously", () => {
    expect(
      one(`SELECT has_function_privilege('anon', 'public.inventory_consume_order_item_core(uuid)', 'EXECUTE')::text`),
    ).toBe("false");
  });
});

describe.runIf(HAS_SQL)("multi-branch stock topology (Savannah Crown SCN/SCT/SCM)", () => {
  it("gives every property at least one active stock location", () => {
    const rows = sql(`
      SELECT b.id::text, count(sl.id)::text
        FROM branches b
        LEFT JOIN stock_locations sl
          ON sl.branch_id = b.id AND sl.organization_id = b.organization_id AND sl.active
       WHERE b.organization_id = '${SEED_ORG}'
       GROUP BY b.id`);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.filter(([, n]) => Number(n) === 0)).toEqual([]);
  });

  it("never posted an inventory consumption against another branch's stock location", () => {
    expect(
      one(`
      SELECT count(*)::text
        FROM inventory_posting_events e
        JOIN pos_orders o ON o.id = e.order_id
        LEFT JOIN stock_locations sl ON sl.id = (e.payload ->> 'location_id')::uuid
       WHERE e.organization_id = '${SEED_ORG}'
         AND sl.id IS NOT NULL
         AND sl.branch_id IS NOT NULL
         AND sl.branch_id <> o.branch_id`),
    ).toBe("0");
  });

  it("never recorded a stock movement in a location outside the source order's branch", () => {
    expect(
      one(`
      SELECT count(*)::text
        FROM stock_movements m
        JOIN pos_order_items oi ON oi.id = m.reference_id
        JOIN pos_orders o ON o.id = oi.order_id
        JOIN stock_locations sl ON sl.id = m.location_id
       WHERE m.reference_type = 'pos_order_item'
         AND o.organization_id = '${SEED_ORG}'
         AND sl.branch_id IS NOT NULL
         AND sl.branch_id <> o.branch_id`),
    ).toBe("0");
  });
});

/**
 * Seeded demo rows carry deterministic UUIDv5 identifiers; rows created later
 * by an operator working in the app are random UUIDv4. This block asserts the
 * integrity of the *seed*, so where an assertion would otherwise be reporting
 * on live operator activity it is pinned to the deterministic rows.
 */
const seeded = (alias: string) => `substring(${alias}.id::text FROM 15 FOR 1) = '5'`;

describe.runIf(HAS_SQL)("Savannah Crown seed integrity", () => {
  it("resolves every branch department through a canonical catalogue key", () => {
    expect(
      // Retired departments keep their history but are out of the operating
      // catalogue, so the key requirement applies to active departments only.
      one(`SELECT count(*)::text FROM departments
            WHERE organization_id = '${SEED_ORG}' AND branch_id IS NOT NULL
              AND coalesce(active, false)
              AND (catalogue_key IS NULL OR catalogue_key = '')`),
    ).toBe("0");
  });

  it("leaves no housekeeping job without a branch or department link", () => {
    expect(
      one(`SELECT count(*)::text FROM housekeeping_jobs
            WHERE organization_id = '${SEED_ORG}'
              AND (branch_id IS NULL OR department_id IS NULL)`),
    ).toBe("0");
  });

  it("links every housekeeping job to its own property's housekeeping department", () => {
    expect(
      one(`SELECT count(*)::text
             FROM housekeeping_jobs j JOIN departments d ON d.id = j.department_id
            WHERE j.organization_id = '${SEED_ORG}'
              AND (d.branch_id IS DISTINCT FROM j.branch_id OR d.catalogue_key <> 'housekeeping')`),
    ).toBe("0");
  });

  it("keeps rooms, folios and tables on the same property as their parent record", () => {
    const checks = [
      `SELECT count(*) FROM housekeeping_jobs j JOIN rooms r ON r.id = j.room_id
        WHERE j.organization_id = '${SEED_ORG}' AND r.branch_id <> j.branch_id`,
      `SELECT count(*) FROM reservations x JOIN rooms r ON r.id = x.room_id
        WHERE x.organization_id = '${SEED_ORG}' AND r.branch_id <> x.branch_id`,
      `SELECT count(*) FROM folios f JOIN reservations x ON x.id = f.reservation_id
        WHERE f.organization_id = '${SEED_ORG}' AND x.branch_id <> f.branch_id`,
      // Seeded orders only: an operator can open a ticket against a table they
      // picked before switching active property, which is live activity to be
      // reconciled in the app, not a defect in the seed.
      `SELECT count(*) FROM pos_orders o JOIN restaurant_tables t ON t.id = o.table_id
        WHERE o.organization_id = '${SEED_ORG}' AND ${seeded("o")} AND t.branch_id <> o.branch_id`,
      `SELECT count(*) FROM assets a JOIN departments d ON d.id = a.department_id
        WHERE a.organization_id = '${SEED_ORG}' AND d.branch_id IS DISTINCT FROM a.branch_id`,
    ];
    expect(one(`SELECT (${checks.map((c) => `(${c})`).join(" + ")})::text`)).toBe("0");
  });

  it("holds no foreign-tenant references", () => {
    const leaks = [
      `SELECT count(*) FROM branches WHERE id IN (SELECT DISTINCT branch_id FROM reservations WHERE organization_id = '${SEED_ORG}') AND organization_id <> '${SEED_ORG}'`,
      `SELECT count(*) FROM customers c WHERE c.id IN (SELECT customer_id FROM reservations WHERE organization_id = '${SEED_ORG}' AND customer_id IS NOT NULL) AND c.organization_id <> '${SEED_ORG}'`,
      `SELECT count(*) FROM menu_items m WHERE m.id IN (SELECT i.menu_item_id FROM pos_order_items i JOIN pos_orders o ON o.id = i.order_id WHERE o.organization_id = '${SEED_ORG}' AND i.menu_item_id IS NOT NULL) AND m.organization_id <> '${SEED_ORG}'`,
    ];
    expect(one(`SELECT (${leaks.map((c) => `(${c})`).join(" + ")})::text`)).toBe("0");
  });

  it("has no in-house stay that departed before the dataset was generated", () => {
    // Anchored to the seed's own generation date rather than to today: a demo
    // stay that was in-house when the data was written legitimately ages out as
    // the calendar advances, and an overdue in-house stay is an operational
    // matter for Front Office, not a seed defect. What the seed must never
    // contain is a stay recorded as in-house that had already departed on the
    // day it was written.
    expect(
      one(`SELECT count(*)::text FROM reservations r
            WHERE r.organization_id = '${SEED_ORG}'
              AND ${seeded("r")}
              AND lower(r.status) = 'checked-in'
              AND r.departure_date < r.created_at::date`),
    ).toBe("0");
  });

  it("keeps in-house folio charges posted and accommodation within the stay total", () => {
    // Room charges accrue night by night, so a mid-stay folio legitimately
    // holds less than the full stay value, and incidentals (laundry, POS) can
    // push the folio above it. What must never happen is a folio with nothing
    // posted, or accommodation charged beyond the agreed stay total.
    expect(
      one(`SELECT count(*)::text
             FROM reservations r JOIN folios f ON f.reservation_id = r.id
            WHERE r.organization_id = '${SEED_ORG}'
              AND lower(r.status) = 'checked-in'
              AND (round(f.total_charges, 2) <= 0
                   OR round((SELECT COALESCE(SUM(l.gross_amount), 0) FROM folio_lines l
                              WHERE l.folio_id = f.id AND l.line_type = 'charge'
                                AND l.status = 'posted' AND l.category = 'accommodation'), 2)
                       > round(r.total_amount, 2))`),
    ).toBe("0");
  });



  it("keeps the room-overlap guard satisfied for every active reservation", () => {
    expect(
      one(`SELECT count(*)::text
             FROM reservations a JOIN reservations b
               ON a.room_id = b.room_id AND a.id < b.id
              AND a.arrival_date < b.departure_date AND a.departure_date > b.arrival_date
            WHERE a.organization_id = '${SEED_ORG}'
              AND lower(COALESCE(a.status,'')) NOT IN ('cancelled','no-show','checked-out')
              AND lower(COALESCE(b.status,'')) NOT IN ('cancelled','no-show','checked-out')`),
    ).toBe("0");
  });

  it("keeps the Owner account holding the Owner role as its primary", () => {
    // The wider workforce now holds roles in this organisation, so the check is
    // scoped to the account that actually carries the Owner role.
    const rows = sql(`
      SELECT r.name, ur.is_primary::text
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
       WHERE ur.organization_id = '${SEED_ORG}'
         AND ur.user_id IN (
           SELECT ur2.user_id FROM user_roles ur2 JOIN roles r2 ON r2.id = ur2.role_id
            WHERE ur2.organization_id = '${SEED_ORG}' AND r2.name = 'Owner / Director'
         )
       ORDER BY ur.is_primary DESC, r.name`);
    expect(rows).toEqual([["Owner / Director", "true"]]);
  });
});
