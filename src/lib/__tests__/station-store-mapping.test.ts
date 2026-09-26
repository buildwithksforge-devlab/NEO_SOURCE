/**
 * Station → supply store mapping contract.
 *
 * Two channels:
 *  - Pure assertions (always run): the readiness states and page summary the
 *    Kitchen Settings workspace shows are derived from the mapping rows, never
 *    from a screen-local guess.
 *  - Read-only SQL assertions (PG* environment): the canonical routines refuse
 *    a cross-property store, refuse an inactive store, refuse an unauthorised
 *    actor, refuse a removal that would leave live production unable to post,
 *    and record the before/after values in the audit trail. Historical stock
 *    movements keep the store they were posted against.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  STATION_STATE_LABEL,
  summariseStations,
  type StationConsoleRow,
} from "@/lib/station-store-routing";

const HAS_SQL = Boolean(process.env["PGHOST"]);
const text = (q: string): string => execFileSync("psql", ["-At", "-c", q], { encoding: "utf8" });

function row(over: Partial<StationConsoleRow>): StationConsoleRow {
  return {
    stationId: "s1",
    stationName: "Hot Kitchen",
    stationCode: "HOT-KITCHEN",
    stationType: "production",
    departmentName: "Main Kitchen",
    branchId: "b1",
    locationId: "l1",
    locationName: "Main Food Store",
    locationActive: true,
    mappedExplicitly: true,
    recipesActive: 3,
    directItems: 4,
    routedItems: 0,
    changedAt: null,
    changedByName: null,
    state: "ready",
    ...over,
  };
}

describe("station store readiness summary", () => {
  it("counts ready, unset and blocked stations from the same rows", () => {
    const rows = [
      row({}),
      row({ stationId: "s2", state: "needs_setup", locationId: null, directItems: 2 }),
      row({ stationId: "s3", state: "store_inactive", locationActive: false, directItems: 1 }),
      row({ stationId: "s4", state: "no_production", recipesActive: 0, directItems: 0 }),
    ];
    const s = summariseStations(rows);
    expect(s.total).toBe(4);
    expect(s.ready).toBe(1);
    expect(s.needsSetup).toBe(2);
    expect(s.recipes).toBe(9);
    expect(s.routedItems).toBe(7);
    // Only the two misconfigured stations carry items that cannot post stock.
    expect(s.blocked).toBe(3);
  });

  it("names every readiness state the operator can be shown", () => {
    expect(Object.keys(STATION_STATE_LABEL).sort()).toEqual([
      "cross_property",
      "needs_setup",
      "no_production",
      "ready",
      "store_inactive",
    ]);
  });
});

describe.skipIf(!HAS_SQL)("station store routines", () => {
  it("assigns only an active store on the station's own property", () => {
    const src = text(
      `SELECT prosrc FROM pg_proc WHERE proname = 'neo_station_store_set'`,
    );
    expect(src).toMatch(/NOT v_loc\.active/);
    expect(src).toMatch(/v_loc\.branch_id <> v_station\.branch_id/);
    expect(src).toMatch(/_location IS NULL/); // an explicit selection is required
  });

  it("refuses an actor without configuration rights", () => {
    const src = text(`SELECT prosrc FROM pg_proc WHERE proname = 'neo_station_store_set'`);
    expect(src).toMatch(/has_permission\('inventory','settings\.manage'\)/);
    expect(src).toMatch(/do not have permission/);
  });

  it("refuses a removal that would strand live recipes or menu items", () => {
    const src = text(`SELECT prosrc FROM pg_proc WHERE proname = 'neo_station_store_clear'`);
    expect(src).toMatch(/v_after IS NULL AND v_deps > 0/);
    expect(src).toMatch(/unable to deduct stock/);
  });

  it("writes the actor and before/after store into the audit trail", () => {
    const set = text(`SELECT prosrc FROM pg_proc WHERE proname = 'neo_station_store_set'`);
    const clear = text(`SELECT prosrc FROM pg_proc WHERE proname = 'neo_station_store_clear'`);
    for (const src of [set, clear]) {
      expect(src).toMatch(/log_audit_event/);
      expect(src).toMatch(/location_name', v_prev_name/);
    }
    expect(set).toMatch(/station_store_assigned|station_store_changed/);
    expect(clear).toMatch(/station_store_removed/);
  });

  it("keeps one resolver for every consuming surface", () => {
    const console_ = text(`SELECT prosrc FROM pg_proc WHERE proname = 'neo_station_store_console'`);
    expect(console_).toMatch(/neo_station_consumption_location/);
    const consumers = text(
      `SELECT count(*) FROM pg_proc WHERE prosrc LIKE '%neo_station_consumption_location%'`,
    ).trim();
    expect(Number(consumers)).toBeGreaterThan(1);
  });

  it("never rewrites the store recorded on a historical movement", () => {
    const src = text(`SELECT prosrc FROM pg_proc WHERE proname = 'neo_station_store_set'`);
    expect(src).not.toMatch(/UPDATE\s+(public\.)?inventory_movements/i);
    const clear = text(`SELECT prosrc FROM pg_proc WHERE proname = 'neo_station_store_clear'`);
    expect(clear).not.toMatch(/UPDATE\s+(public\.)?inventory_movements/i);
  });

  it("keeps one mapping row per station so a retry cannot duplicate it", () => {
    const uniq = text(
      `SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.station_consumption_stores'::regclass AND contype = 'u'`,
    ).trim();
    expect(Number(uniq)).toBeGreaterThan(0);
  });
});
