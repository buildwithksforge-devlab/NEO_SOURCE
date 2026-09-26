import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STATION_ROUTING_PRECEDENCE, ticketRoutingException } from "@/lib/kitchen-tickets";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Deployed definitions exported from the live database. */
const SQL = read("src/lib/__tests__/fixtures/kitchen-routing.sql");

const fn = (name: string) => {
  const start = SQL.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} missing from fixture`).toBeGreaterThan(-1);
  const next = SQL.indexOf("CREATE OR REPLACE FUNCTION", start + 10);
  return SQL.slice(start, next === -1 ? undefined : next);
};

const resolver = fn("neo_kitchen_resolve_station");
const reconcile = fn("neo_kitchen_reconcile_stations");
const invariants = fn("neo_kitchen_invariant_violations");
const routeOrder = fn("neo_pos_send_to_kitchen");
const legacyRouteOrder = fn("kitchen_route_order");
const routeItem = fn("neo_kitchen_route_order_item");

describe("canonical routing resolver precedence", () => {
  it("evaluates item rules, then category rules, then the persisted order-item station, then menu defaults", () => {
    const order = STATION_ROUTING_PRECEDENCE.filter((s) => s !== "missing-routing").map((source) =>
      resolver.indexOf(`'source', '${source}'`),
    );
    for (const idx of order) expect(idx).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("returns a typed missing-routing failure and never an arbitrary station", () => {
    expect(resolver).toContain("'missing-routing'");
    expect(resolver).toContain("'missing', true");
    // No blind "pick any station" fallback may survive in the resolver.
    expect(resolver).not.toMatch(/FROM public\.operational_stations s\s+WHERE s\.organization_id = _org\s+AND coalesce\(s\.active, true\)\s+AND s\.station_type = 'production'/);
  });

  it("scopes every candidate station to the same organisation, branch and active state", () => {
    expect(fn("neo_station_is_usable")).toContain("s.organization_id = _org");
    expect(fn("neo_station_is_usable")).toContain("coalesce(s.active, true)");
    expect(fn("neo_station_is_usable")).toContain("s.branch_id = _branch");
    for (const rule of ["rr.organization_id = _org", "rr.branch_id = _branch", "coalesce(rr.active, true)"]) {
      expect(resolver).toContain(rule);
    }
    expect(resolver.match(/neo_station_is_usable/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it("is the single resolver used by send-to-kitchen, backfill and reconciliation", () => {
    expect(routeItem).toContain("neo_kitchen_resolve_station");
    expect(fn("kitchen_resolve_station")).toContain("neo_kitchen_route_order_item");
    expect(fn("neo_resolve_item_station")).toContain("neo_kitchen_resolve_station");
    expect(routeOrder).toContain("neo_kitchen_route_order_item");
    // the legacy entry point is a thin delegate, never a second generator
    expect(legacyRouteOrder).toContain("neo_pos_send_to_kitchen");
    expect(legacyRouteOrder).not.toContain("INSERT INTO public.station_tickets");
    expect(reconcile).toContain("neo_kitchen_route_order_item");
  });
});

describe("one ticket, one station", () => {
  it("permits a draft bill to enter production while preserving terminal guards", () => {
    expect(routeOrder).not.toContain("_o.status IN ('draft','held','cancelled','voided')");
    expect(routeOrder).toContain("_o.status IN ('held','cancelled','voided')");
    expect(routeOrder).toContain("_o.status IN ('draft','open','new','draft-sent')");
    expect(routeOrder).toContain("status = 'sent', sent_at = COALESCE(sent_at, now())");
  });

  it("send-to-kitchen keys tickets by order, station and course so mixed orders split", () => {
    expect(routeOrder).toContain("ON CONFLICT (order_id, COALESCE(station_id");
    expect(routeOrder).toContain("_order, _station,");
  });

  it("reconciliation partitions by resolved item station, deterministically", () => {
    expect(reconcile).toContain("GROUP BY station_id");
    expect(reconcile).toContain("ORDER BY count(*) DESC, station_id::text");
  });

  it("keeps the original ticket identity for the primary partition and system-generates the others", () => {
    expect(reconcile).toContain("_target_ticket := _t.id");
    expect(reconcile).toContain("md5(_p.station_id::text)");
    expect(reconcile).toContain("'Station partition of '");
  });

  it("moves only ticket-item links and never duplicates order items", () => {
    expect(reconcile).toContain("UPDATE public.station_ticket_items i SET ticket_id = _target_ticket");
    expect(reconcile).toContain("d.ticket_id = _target_ticket AND d.order_item_id = i.order_item_id");
    expect(reconcile).not.toContain("INSERT INTO public.pos_order_items");
    expect(reconcile).not.toContain("DELETE FROM");
  });

  it("preserves status, timestamps, chef attribution, delay reason and audit fields", () => {
    for (const col of [
      "received_at",
      "accepted_at",
      "started_at",
      "ready_at",
      "completed_at",
      "cancelled_at",
      "assigned_chef_id",
      "delay_reason",
      "priority_reason",
      "created_by",
      "routing_note",
    ]) {
      expect(reconcile).toContain(col);
    }
  });

  it("re-aggregates each partition without re-emitting ready notifications or events", () => {
    expect(reconcile).toContain("'partially-ready'");
    expect(reconcile).not.toContain("emit_domain_event");
    expect(reconcile).not.toContain("INSERT INTO public.notifications");
  });

  it("is idempotent: it only visits tickets that still violate the station invariant", () => {
    expect(reconcile).toContain("t.station_id IS NULL OR oi.station_id IS DISTINCT FROM t.station_id");
  });

  it("refuses cross-organisation reconciliation and requires an organisation", () => {
    expect(reconcile).toContain("Cross-organisation reconciliation is not permitted");
    expect(reconcile).toContain("No active organization");
  });
});

describe("kitchen invariants cover station defects", () => {
  it("detects null ticket station, null item station, mixed stations and mismatches", () => {
    for (const v of [
      "'status-aggregation'",
      "'ticket-station-null'",
      "'ticket-station-mixed'",
      "'item-station-null'",
      "'ticket-item-station-mismatch'",
    ]) {
      expect(invariants).toContain(v);
    }
  });

  it("is a plain invoker view over the tickets so RLS still applies to the reader", () => {
    expect(invariants).toContain("LANGUAGE sql");
    expect(invariants).not.toContain("SECURITY DEFINER");
  });
});

describe("routing exception surfaces only when routing is unresolved", () => {
  it("treats a resolved station as configured", () => {
    expect(ticketRoutingException({ station_id: "s1", station_missing: false })).toBe(false);
    expect(ticketRoutingException({ station_id: null, station_missing: true })).toBe(true);
  });

  it("keeps the routing routines authenticated-only", () => {
    for (const name of [
      "neo_kitchen_reconcile_stations",
    ]) {
      expect(RPC_MANIFEST[name as keyof typeof RPC_MANIFEST]).toBe("authenticated");
    }
  });
});
