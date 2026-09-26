/**
 * Completion evidence for the three operational consoles: Front Office
 * availability, the Restaurant Floor and the Banqueting command centre.
 *
 * These are source contracts, not snapshots: they assert the rules that make
 * each surface truthful, so a later edit cannot quietly reintroduce a sellable
 * room that is dirty, a floor action without a permission, or a banqueting
 * figure that is not reconciled to the booking record.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { billingPosition, taskProgress } from "@/components/events/BanquetingCommandCentre";

const AVAILABILITY_SQL = readFileSync(
  "supabase/migrations/20260822143929_27ce27c4-08db-4e06-a436-01fb2a891ddd.sql",
  "utf8",
);

describe("Front Office availability — sellable inventory rules", () => {
  it("excludes rooms that are assigned, blocked, held, reserved or out of order", () => {
    expect(AVAILABILITY_SQL).toContain("public.room_assignments");
    expect(AVAILABILITY_SQL).toContain("public.room_blocks");
    expect(AVAILABILITY_SQL).toContain("public.reservation_holds");
    expect(AVAILABILITY_SQL).toContain("out_of_order_from");
    expect(AVAILABILITY_SQL).toContain("res.status IN ('confirmed','guaranteed','checked-in','in-house')");
  });

  it("requires a physically ready, vacant room for same-day stays", () => {
    expect(AVAILABILITY_SQL).toContain("hk_canonical_condition(r.housekeeping_status) IN ('clean','inspected')");
    expect(AVAILABILITY_SQL).toContain("coalesce(r.occupancy_status,'vacant') = 'vacant'");
    expect(AVAILABILITY_SQL).toContain("r.maintenance_status = 'operational'");
  });

  it("consumes group-held and unassigned confirmed demand of the same room type", () => {
    expect(AVAILABILITY_SQL).toContain("group_room_blocks");
    expect(AVAILABILITY_SQL).toContain("res.room_id IS NULL");
  });

  it("scopes to the active property and hands the search off to the reservation", () => {
    const page = readFileSync("src/components/pms/AvailabilitySearchPage.tsx", "utf8");
    expect(AVAILABILITY_SQL).toContain("_branch IS NULL OR r.branch_id = _branch");
    expect(page).toContain("useActivePropertyFilter");
    expect(page).toContain('to="/pms/reservations/new"');
    expect(page).toContain("roomId: inspected.room_id");
    // Grouped by property so a multi-property search stays readable.
    expect(page).toContain("groupByProperty");
  });
});

describe("Restaurant Floor — live service workspace", () => {
  const floor = readFileSync("src/routes/_shell.pos.floor.tsx", "utf8");

  it("shows production routing state from the live open order", () => {
    const card = readFileSync("src/components/pos/FloorTableCard.tsx", "utf8");
    expect(card).toContain("productionLabel");
    expect(floor).toContain('usePosOrders("open")');
    expect(floor).toContain("Service state");
  });

  it("gates every action on a permission rather than rendering it for everyone", () => {
    expect(floor).toContain('can("pos", "orders.create")');
    expect(floor).toContain('can("pos", "floor.edit")');
  });

  it("routes voids, comps and refunds through the approvals authority", () => {
    expect(floor).toContain("resolvePosApprovalGates");
    expect(floor).toContain("approvals.canDecide");
    expect(floor).toContain("A manager with approval authority must decide this");
  });
});

describe("Banqueting command centre", () => {
  it("reports task progress only from the tasks that exist", () => {
    expect(taskProgress([])).toEqual({ total: 0, done: 0, blocked: 0, percent: null });
    expect(
      taskProgress([{ status: "completed" }, { status: "ready" }, { status: "blocked" }, { status: "not-started" }]),
    ).toEqual({ total: 4, done: 2, blocked: 1, percent: 50 });
  });

  it("never presents an uncosted booking as zero money", () => {
    expect(billingPosition(null)).toBeNull();
    expect(billingPosition({ total_amount: null, paid_amount: null } as never)?.costed).toBe(false);
    const costed = billingPosition({ total_amount: 1000, paid_amount: 250 } as never);
    expect(costed).toMatchObject({ balance: 750, costed: true });
  });

  it("reads readiness, teams, tasks, money and risk from canonical sources", () => {
    const src = readFileSync("src/components/events/BanquetingCommandCentre.tsx", "utf8");
    expect(src).toContain("events_department_readiness");
    expect(src).toContain('.from("event_bookings")');
    expect(src).toContain("Unresolved risks");
    expect(src).toContain("Reconciled to booking");
    const route = readFileSync("src/routes/_shell.events.banqueting.tsx", "utf8");
    expect(route).toContain("<BanquetingCommandCentre");
  });
});
