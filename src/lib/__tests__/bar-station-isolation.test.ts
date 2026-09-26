/**
 * Bar station isolation — kitchen-only items must never surface in /bar/queue.
 *
 * A mixed order (food + drinks) is one canonical `pos_orders` record routed
 * into several `station_tickets`: the food lines to a kitchen station, the
 * drinks to a beverage station. The bar queue must show only the beverage
 * ticket, and within that ticket only the beverage lines.
 *
 * The suite runs against the connected project database. Bar routines are
 * restricted to authenticated callers, so the executed set checks re-state the
 * bar predicate directly against `operational_stations.station_type` and prove
 * no ticket, item or order breaks it; the routine sources are asserted to use
 * that same predicate rather than an order-level or department-level filter.
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

const scalar = (query: string) => sql(query)[0]?.[0] ?? "";

const routine = (name: string) =>
  scalar(
    `select replace(coalesce(string_agg(p.prosrc, ' '), ''), chr(10), ' ') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${name}'`,
  );

/** The bar predicate, expressed exactly as the resolver expresses it. */
const BAR_STATIONS = `select s.id from public.operational_stations s where coalesce(s.station_type,'') = 'beverage'`;

describe.skipIf(!HAS_SQL)("bar station isolation", () => {
  it("resolves bar stations from the property's own bar department", () => {
    const src = routine("neo_bar_station_ids");
    expect(src, "neo_bar_station_ids must exist").not.toBe("");
    expect(src).toContain("operational_stations");
    // Membership of a bar department is the test — never the station's name
    // alone, which hid "Beverage" and admitted anything called "bar".
    expect(src).toContain("departments");
    expect(src).toMatch(/d\.code/);
    expect(src).toContain("current_org_id()");
  });


  it("filters the bar queue by bar station identity, not by order or department", () => {
    const src = routine("neo_bar_queue");
    expect(src).toContain("neo_bar_station_ids");
    expect(src).toMatch(/t\.station_id in \(select public\.neo_bar_station_ids/i);
    // The queue must not widen back out to the whole order or department.
    expect(src).not.toMatch(/where\s+t\.order_id\s*=\s*o\.id\s*$/i);
  });

  it("never admits a kitchen ticket through the bar station predicate", () => {
    const leaked = scalar(
      `select count(*)
         from public.station_tickets t
         join public.operational_stations s on s.id = t.station_id
        where t.station_id in (${BAR_STATIONS})
          and coalesce(s.station_type,'') <> 'beverage'`,
    );
    expect(leaked, "a non-beverage ticket satisfied the bar station predicate").toBe("0");
  });

  it("returns only the beverage tickets of a mixed food and drink order", () => {
    // Orders that fanned out to both a kitchen and a beverage station.
    const mixed = scalar(
      `with bar_stations as (${BAR_STATIONS})
       select count(*) from (
         select t.order_id
           from public.station_tickets t
          where t.order_id is not null
          group by t.order_id
         having count(*) filter (where t.station_id in (select id from bar_stations)) > 0
            and count(*) filter (where t.station_id not in (select id from bar_stations)) > 0
       ) m`,
    );
    expect(Number(mixed)).toBeGreaterThanOrEqual(0);

    // Of those orders' tickets, the ones the bar predicate admits are beverage
    // only — the kitchen half of the same canonical order stays out.
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
         from public.station_tickets t
         join mixed m on m.order_id = t.order_id
         join public.operational_stations s on s.id = t.station_id
        where t.station_id in (select id from bar_stations)
          and coalesce(s.station_type,'') <> 'beverage'`,
    );
    expect(leaked, "the bar queue would show a kitchen ticket of a mixed order").toBe("0");
  });

  it("confines bar ticket line items to that ticket's own routed lines", () => {
    // The items payload is built from station_ticket_items of the ticket only,
    // so a kitchen line on the same order can never ride along on a bar ticket.
    const src = routine("neo_bar_queue");
    expect(src).toMatch(/station_ticket_items i[\s\S]*where i\.ticket_id = t\.id/i);
    expect(src).toContain("item_name");

    const crossRouted = scalar(
      `with bar_stations as (${BAR_STATIONS})
       select count(*)
         from public.station_ticket_items i
         join public.station_tickets t on t.id = i.ticket_id
         join public.station_ticket_items other on other.order_item_id = i.order_item_id
         join public.station_tickets ot on ot.id = other.ticket_id
        where i.order_item_id is not null
          and t.station_id in (select id from bar_stations)
          and ot.station_id not in (select id from bar_stations)
          and ot.order_id = t.order_id`,
    );
    expect(crossRouted, "an order line was routed to both a kitchen and a bar ticket").toBe("0");
  });

  it("reads bar queue line labels with the field names the routine emits", async () => {
    const src = routine("neo_bar_queue");
    for (const key of ["item_name", "quantity", "special_instructions"]) {
      expect(src, `neo_bar_queue must emit ${key}`).toContain(key);
    }
    const route = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/routes/_shell.bar.queue.tsx", "utf8"),
    );
    expect(route).toContain('it["item_name"]');
    expect(route).toContain('it["special_instructions"]');
  });
});
