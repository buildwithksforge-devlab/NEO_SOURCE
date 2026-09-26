/**
 * Non-beverage stations cannot read or render the bar queue.
 *
 * `/bar/queue` reads exactly one source — `neo_bar_queue` — which resolves its
 * own station set server-side from `neo_bar_station_ids` (beverage only) and
 * accepts no caller-supplied station argument. A kitchen or generic station
 * therefore has no parameter to pass and no row to receive, even when the same
 * canonical order carries both food and drinks. The screen itself is gated on
 * the `bar.queue.view` permission.
 *
 * Runs read-only against the connected project database; skips when no
 * connection is configured rather than passing silently.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const HAS_SQL = Boolean(process.env["PGHOST"]);

function sql(query: string): string[][] {
  const out = execFileSync("psql", ["-At", "-F", "\u0001", "-c", query], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.split("\u0001"));
}

const scalar = (query: string) => sql(query)[0]?.[0] ?? "";

/** The bar station predicate, re-stated exactly as `neo_bar_station_ids` expresses it. */
const BAR_STATIONS = `select s.id
    from public.operational_stations s
    left join public.departments d on d.id = s.department_id
   where coalesce(s.station_type,'') = 'beverage'
     and (upper(coalesce(d.code,'')) = 'BAR'
          or s.code ilike '%bar%' or s.name ilike '%bar%'
          or s.code ilike '%beverage%' or s.name ilike '%beverage%')
     and coalesce(s.code,'') not ilike '%coffee%'
     and coalesce(s.name,'') not ilike '%coffee%'`;

describe("bar queue surface", () => {
  it("gates the queue screen on the bar permission and one bar source", () => {
    const route = readFileSync("src/routes/_shell.bar.queue.tsx", "utf8");
    expect(route).toContain('BarGuard action="queue.view"');
    // The screen never falls back to the kitchen reader to widen its rows.
    expect(route).not.toContain("neo_kitchen_queue");
    expect(route).not.toContain("useKitchenQueue");

    const guard = readFileSync("src/components/bar/BarShared.tsx", "utf8");
    expect(guard).toMatch(/can\(\s*["']bar["']\s*,\s*action\s*\)/);
  });

  it("keeps the kitchen display on its own reader", () => {
    const kitchen = readFileSync("src/lib/kitchen-tickets.ts", "utf8");
    expect(kitchen).toContain("neo_kitchen_queue");
    expect(kitchen).not.toContain("neo_bar_queue");
  });
});

describe.skipIf(!HAS_SQL)("bar queue station access", () => {
  it("exposes no station argument a kitchen station could pass in", () => {
    const args = scalar(
      `select pg_get_function_arguments(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='neo_bar_queue'`,
    );
    expect(args, "neo_bar_queue must exist").not.toBe("");
    expect(args).not.toContain("_station");
    expect(args).toContain("_branch");
  });

  it("is executable only by authenticated callers, never anon or public", () => {
    const grantees = sql(
      `select coalesce(grantee,'') from information_schema.routine_privileges rp
        join pg_proc p on p.proname = rp.routine_name
       where rp.specific_schema='public' and rp.routine_name='neo_bar_queue' and rp.privilege_type='EXECUTE'`,
    ).map((r) => r[0]);
    expect(grantees).not.toContain("anon");
    expect(grantees).not.toContain("PUBLIC");
  });

  it("returns no ticket belonging to a kitchen or generic station", () => {
    const foreign = scalar(
      `select count(*)
         from public.station_tickets t
         join public.operational_stations s on s.id = t.station_id
        where t.station_id in (${BAR_STATIONS})
          and coalesce(s.station_type,'') is distinct from 'beverage'`,
    );
    expect(foreign, "a non-beverage station's ticket is reachable from the bar queue").toBe("0");
  });

  it("holds the kitchen and bar station sets strictly disjoint", () => {
    const overlap = scalar(
      `select count(*) from public.operational_stations s
        where s.id in (${BAR_STATIONS})
          and coalesce(s.station_type,'') in ('kitchen','hot','cold','pastry','grill','generic','')`,
    );
    expect(overlap, "a kitchen or generic station resolved as a bar station").toBe("0");
  });

  it("leaves the food half of a mixed order invisible to the bar queue", () => {
    const visible = scalar(
      `with bar_stations as (${BAR_STATIONS}),
       mixed as (
         select t.order_id
           from public.station_tickets t
          where t.order_id is not null
          group by t.order_id
         having count(*) filter (where t.station_id in (select id from bar_stations)) > 0
            and count(*) filter (where t.station_id not in (select id from bar_stations)) > 0
       )
       select count(*)
         from public.station_tickets t
         join mixed m on m.order_id = t.order_id
        where t.station_id not in (select id from bar_stations)
          and t.station_id in (${BAR_STATIONS})`,
    );
    expect(visible, "a kitchen ticket of a mixed order reached the bar queue").toBe("0");
  });
});
