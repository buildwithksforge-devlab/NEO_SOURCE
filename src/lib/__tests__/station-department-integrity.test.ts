/**
 * Station ownership integrity.
 *
 * A production/beverage station must be owned by a real, active department in
 * the same workspace and property. When Main Bar sat under a retired "Bar"
 * department, visibility checks could not resolve who owned a drink ticket:
 * the Bar Queue looked empty, notifications had no valid recipients and a
 * fallback query risked exposing tickets too broadly.
 *
 * Bar belongs under Food & Beverage — a standalone Bar department is not
 * required — so this guards the invariant rather than the department name.
 *
 * Read-only against the connected project database; skips when no connection
 * is configured rather than passing silently.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const HAS_SQL = Boolean(process.env["PGHOST"]);

const scalar = (query: string) =>
  execFileSync("psql", ["-At", "-c", query], { encoding: "utf8" }).split("\n")[0] ?? "";

describe.skipIf(!HAS_SQL)("station department integrity", () => {
  it("gives every active station a property and an active same-workspace department", () => {
    const broken = scalar(
      `select count(*) from public.operational_stations s
         left join public.departments d on d.id = s.department_id
        where coalesce(s.active, true)
          and (s.department_id is null
               or s.branch_id is null
               or d.id is null
               or not coalesce(d.active, false)
               or d.organization_id is distinct from s.organization_id
               or (d.branch_id is not null and d.branch_id <> s.branch_id))`,
    );
    expect(broken, "a station is missing a property or owned by a retired/foreign department").toBe("0");
  });

  it("enforces the same rule for future edits with a database guard", () => {
    const trigger = scalar(
      `select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where c.relname = 'operational_stations'
          and t.tgname = 'neo_station_department_guard'
          and not t.tgisinternal`,
    );
    expect(trigger, "operational_stations must carry the department guard trigger").toBe("1");
  });

  it("never exposes the guard routine to app callers", () => {
    const callable = scalar(
      `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'neo_station_department_guard'
          and (has_function_privilege('anon', p.oid, 'execute')
               or has_function_privilege('authenticated', p.oid, 'execute'))`,
    );
    expect(callable).toBe("0");
  });

  it("keeps bar stations resolvable for the bar queue after the move to Food & Beverage", () => {
    // Same predicate `neo_bar_station_ids` uses: resolution is by beverage
    // station identity, not by owning a department literally named "Bar".
    const bars = scalar(
      `select count(*) from public.operational_stations s
         left join public.departments d on d.id = s.department_id
        where coalesce(s.station_type,'') = 'beverage'
          and (upper(coalesce(d.code,'')) = 'BAR'
               or s.code ilike '%bar%' or s.name ilike '%bar%'
               or s.code ilike '%beverage%' or s.name ilike '%beverage%')
          and coalesce(s.code,'') not ilike '%coffee%'
          and coalesce(s.name,'') not ilike '%coffee%'`,
    );
    expect(Number(bars), "no station resolves as a bar station").toBeGreaterThan(0);
  });
});
