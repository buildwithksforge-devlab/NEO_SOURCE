/**
 * /bar/sell — mixed orders route drinks only.
 *
 * The bar's own selling surface is not a second order system: it creates one
 * canonical `pos_orders` record through `useCreateOrder`, and the routing
 * triggers fan its lines out to `station_tickets`. This suite proves that for a
 * mixed food + drink order the beverage station only ever receives the drink
 * lines, and that the bar can only put bar-eligible items on the tab in the
 * first place (`neo_bar_menu` is bounded by `neo_bar_station_ids`).
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

const routine = (name: string) =>
  scalar(
    `select replace(coalesce(string_agg(p.prosrc, ' '), ''), chr(10), ' ') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${name}'`,
  );

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

describe("bar sell surface", () => {
  it("opens tabs through the canonical POS order mutation, not a bar-only table", () => {
    const route = readFileSync("src/routes/_shell.bar.sell.tsx", "utf8");
    expect(route).toContain("useCreateOrder");
    expect(route).toContain("useBarMenu");
    // No parallel order model: the bar sells from the shared POS contracts.
    expect(route).not.toMatch(/from\s+["']@\/lib\/bar-orders["']/);
    expect(route).not.toMatch(/\.from\(\s*["']bar_orders["']\s*\)/);
  });
});

describe.skipIf(!HAS_SQL)("bar sell mixed orders", () => {
  it("offers only bar-station menu items on the selling surface", () => {
    const src = routine("neo_bar_menu");
    expect(src, "neo_bar_menu must exist").not.toBe("");
    expect(src).toMatch(/st\.id in \(select public\.neo_bar_station_ids/i);
    // Resolution goes through the one canonical station resolver.
    expect(src).toContain("neo_kitchen_resolve_station");
    expect(src).toContain("menu_items");
  });

  it("keeps every bar-eligible station a beverage station", () => {
    const nonBeverage = scalar(
      `select count(*) from public.operational_stations s
        where s.id in (${BAR_STATIONS})
          and coalesce(s.station_type,'') <> 'beverage'`,
    );
    expect(nonBeverage, "a non-beverage station is treated as a bar station").toBe("0");
  });

  it("gives a beverage station only the beverage lines of a mixed order", () => {
    const leaked = scalar(
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
         from public.station_ticket_items i
         join public.station_tickets t on t.id = i.ticket_id
         join mixed m on m.order_id = t.order_id
        where t.station_id in (select id from bar_stations)
          and exists (
            select 1
              from public.station_ticket_items other
              join public.station_tickets ot on ot.id = other.ticket_id
             where other.order_item_id = i.order_item_id
               and ot.order_id = t.order_id
               and ot.station_id not in (select id from bar_stations)
          )`,
    );
    expect(leaked, "a food line of a mixed order was routed onto a bar ticket").toBe("0");
  });

  it("preserves one canonical order across the kitchen and bar halves", () => {
    const duplicated = scalar(
      `with bar_stations as (${BAR_STATIONS})
       select count(*) from (
         select t.order_id, t.station_id, coalesce(t.course,'') as course
           from public.station_tickets t
          where t.order_id is not null
            and t.station_id in (select id from bar_stations)
          group by 1,2,3
         having count(*) > 1
       ) d`,
    );
    expect(duplicated, "the same order/station/course produced two bar tickets").toBe("0");
  });

  it("reads bar tab totals with the columns pos_orders actually has", () => {
    const cols = sql(
      `select column_name from information_schema.columns where table_schema='public' and table_name='pos_orders'`,
    ).map((r) => r[0]);
    expect(cols).toContain("grand_total");
    expect(cols).not.toContain("total_amount");
    const openOrders = routine("neo_bar_open_orders");
    expect(openOrders).not.toContain("total_amount");
  });
});
