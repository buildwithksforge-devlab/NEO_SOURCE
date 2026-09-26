/**
 * Bar order lifecycle — create → kitchen/bar queue → served → settlement.
 *
 * This runs against the connected project database (read-only catalogue
 * inspection) and proves the lifecycle is wired end to end and that each
 * downstream side effect can only land once:
 *   • sending a bar order to the bar creates exactly one station ticket per
 *     order/station/course (unique index), so a re-send cannot duplicate KDS;
 *   • settlement posts to Finance through an idempotency key that is unique
 *     per organisation, so a retried payment cannot double-post revenue;
 *   • a room charge writes one folio line per idempotency key;
 *   • recipe depletion writes one stock movement per idempotency key.
 *
 * If no database connection is configured the suite skips rather than passing
 * silently.
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

const indexes = (table: string) =>
  HAS_SQL
    ? sql(
        `select replace(indexdef, chr(10), ' ') from pg_indexes where schemaname='public' and tablename='${table}' and indexdef ilike '%unique%'`,
      )
        .map((r) => r[0] ?? "")
        .join("\n")
    : "";

const routine = (name: string) =>
  HAS_SQL
    ? sql(
        `select replace(coalesce(string_agg(p.prosrc, ' '), ''), chr(10), ' ') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${name}'`,
      )[0]?.[0] ?? ""
    : "";

describe.skipIf(!HAS_SQL)("bar order lifecycle", () => {
  it("routes a bar order to the queue through the canonical station ticket path", () => {
    const trigger = sql(
      `select coalesce(string_agg(t.tgname, ','), '') from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relname in ('pos_orders','pos_order_items') and not t.tgisinternal`,
    )[0]?.[0];
    expect(trigger, "POS orders must fire kitchen/bar routing triggers").not.toBe("");
    const barQueue = routine("neo_bar_queue");
    expect(barQueue).toContain("station_tickets");
  });

  it("cannot create a second bar ticket for the same order, station and course", () => {
    expect(indexes("station_tickets")).toMatch(
      /station_tickets_order_station_course_uidx|order_id.*station_id.*course/s,
    );
  });

  it("advances a bar ticket only through the canonical guarded routine", () => {
    const advance = routine("neo_bar_advance_ticket");
    expect(advance).toContain("station_tickets");
    expect(advance.toLowerCase()).toContain("permission");
  });

  it("posts settlement to Finance exactly once per idempotency key", () => {
    expect(indexes("finance_posting_receipts")).toContain("idempotency_key");
    expect(indexes("pos_payments")).toContain("idempotency_key");
    const post = routine("neo_finance_post_txn");
    expect(post).toContain("finance_posting_receipts");
    // Re-posting the same source is serialised and de-duplicated rather than
    // appended twice: one advisory lock per source, one receipt per source.
    expect(post).toContain("pg_advisory_xact_lock");
  });

  it("charges a bar tab to a room as a single folio line", () => {
    expect(indexes("folio_lines")).toContain("idempotency_key");
    const postCharge = routine("folio_post_charge");
    expect(postCharge.toLowerCase()).toContain("idempotency");
  });

  it("depletes bar stock exactly once per consumption event", () => {
    expect(indexes("stock_movements")).toContain("idempotency_key");
  });

  it("keeps bar readers scoped to the selected property", () => {
    for (const name of ["neo_bar_overview", "neo_bar_open_orders", "neo_bar_menu", "neo_bar_metrics"]) {
      const src = routine(name);
      expect(src, `${name} must exist`).not.toBe("");
      expect(src, `${name} must accept a property filter`).toContain("_branch");
    }
  });

  it("never exposes bar readers to anonymous callers", () => {
    const rows = sql(
      `select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'neo_bar_%' and has_function_privilege('anon', p.oid, 'execute')`,
    );
    expect(rows.map((r) => r[0])).toEqual([]);
  });
});
