import { describe, expect, it } from "vitest";
import { parseAvailabilitySearch } from "@/lib/availability-search";
import { addDays, nightsBetween, today } from "@/lib/pms";
import { groupByProperty } from "@/components/pms/AvailabilitySearchPage";
import type { AvailableRoom } from "@/lib/pms-data";

/**
 * The availability contract: what the operator submits is what is searched,
 * what the URL carries, and what the database is asked for.
 */

function committedFrom(search: Record<string, unknown>) {
  const parsed = parseAvailabilitySearch(search);
  const arrival = parsed.arrival ?? today();
  return {
    arrival,
    departure: parsed.departure ?? addDays(arrival, 1),
    roomType: parsed.roomType ?? "all",
    adults: parsed.adults ?? 2,
    children: parsed.children ?? 0,
  };
}

describe("availability search state", () => {
  it("defaults departure to arrival + 1 night", () => {
    const c = committedFrom({});
    expect(c.arrival).toBe(today());
    expect(c.departure).toBe(addDays(today(), 1));
    expect(nightsBetween(c.arrival, c.departure)).toBe(1);
  });

  it("round-trips the submitted values through the URL", () => {
    const submitted = {
      arrival: "2026-08-24",
      departure: "2026-08-25",
      roomType: "rt-fam",
      adults: 2,
      children: 1,
    };
    const url = new URLSearchParams(
      Object.entries(submitted).map(([k, v]) => [k, String(v)]),
    );
    const c = committedFrom(Object.fromEntries(url.entries()));
    expect(c).toEqual(submitted);
    expect(nightsBetween(c.arrival, c.departure)).toBe(1);
  });

  it("reconstructs the same search on refresh, back and forward", () => {
    const params = { arrival: "2026-08-24", departure: "2026-08-28", adults: "3" };
    expect(committedFrom(params)).toEqual(committedFrom(params));
    expect(committedFrom(params).departure).toBe("2026-08-28");
  });

  it("never substitutes today for an invalid date and keeps the rest of the search", () => {
    const c = parseAvailabilitySearch({ arrival: "24/08/2026", departure: "2026-08-25", roomType: "rt-1" });
    expect(c.arrival).toBeUndefined();
    expect(c.departure).toBe("2026-08-25");
    expect(c.roomType).toBe("rt-1");
  });

  it("carries the selected room into the reservation handoff", () => {
    expect(parseAvailabilitySearch({ roomId: "room-101" }).roomId).toBe("room-101");
  });

  it("treats a same-day range as zero nights", () => {
    expect(nightsBetween("2026-08-22", "2026-08-22")).toBe(0);
  });
});

/** Mirrors the SQL in public.pms_available_rooms so drift is caught here. */
type Room = {
  no: string;
  type: string;
  branch: string;
  hk?: string;
  inspection?: string;
  maintenance?: string;
  occupancy?: string;
  status?: string;
  capacity?: number;
  ooo?: [string, string | null];
  stays?: Array<[string, string]>;
  blocks?: Array<[string, string]>;
  holds?: Array<[string, string]>;
};

const overlapHalfOpen = (a: [string, string], b: [string, string]) => a[0] < b[1] && b[0] < a[1];
const overlapClosed = (a: [string, string | null], b: [string, string]) =>
  a[0] < b[1] && b[0] <= (a[1] ?? "9999-12-31");

function available(
  rooms: Room[],
  q: {
    arrival: string;
    departure: string;
    todayIs: string;
    roomType?: string;
    party?: number;
    branch?: string;
    groupHeld?: Record<string, number>;
    unassignedDemand?: Record<string, number>;
  },
) {
  const stay: [string, string] = [q.arrival, q.departure];
  const candidates = rooms.filter((r) => {
    if ((r.status ?? "active") !== "active") return false;
    if ((r.maintenance ?? "operational") !== "operational") return false;
    if (q.branch && r.branch !== q.branch) return false;
    if (q.roomType && r.type !== q.roomType) return false;
    if (q.party && (r.capacity ?? 2) < q.party) return false;
    const ready =
      ["clean", "inspected"].includes(r.hk ?? "clean") &&
      ["not-required", "passed"].includes(r.inspection ?? "not-required") &&
      (r.occupancy ?? "vacant") === "vacant";
    if (q.arrival <= q.todayIs && !ready) return false;
    if (r.ooo && overlapClosed(r.ooo, stay)) return false;
    if ((r.stays ?? []).some((s) => overlapHalfOpen(s, stay))) return false;
    if ((r.blocks ?? []).some((s) => overlapClosed([s[0], s[1]], stay))) return false;
    if ((r.holds ?? []).some((s) => overlapHalfOpen(s, stay))) return false;
    return true;
  });
  // Inventory the same way the SQL does: rank per room type, then drop the
  // rooms consumed by group blocks and unassigned confirmed demand.
  const byType = new Map<string, Room[]>();
  for (const r of candidates) byType.set(r.type, [...(byType.get(r.type) ?? []), r]);
  const out: Room[] = [];
  for (const [type, list] of byType) {
    const consumed = (q.groupHeld?.[type] ?? 0) + (q.unassignedDemand?.[type] ?? 0);
    const ranked = [...list].sort((a, b) => (a.no < b.no ? 1 : -1));
    out.push(...ranked.slice(consumed));
  }
  return out.map((r) => r.no).sort();
}

const ZAWADI: Room[] = [
  { no: "101", type: "std", branch: "zawadi" },
  { no: "102", type: "std", branch: "zawadi" },
  { no: "103", type: "std", branch: "zawadi", hk: "dirty" },
  { no: "104", type: "std", branch: "zawadi", maintenance: "under-maintenance" },
  { no: "105", type: "dlx", branch: "zawadi" },
  { no: "106", type: "dlx", branch: "zawadi" },
  { no: "107", type: "dlx", branch: "zawadi" },
  { no: "108", type: "dlx", branch: "zawadi", maintenance: "out-of-service" },
  { no: "201", type: "fam", branch: "zawadi", capacity: 4 },
  { no: "202", type: "fam", branch: "zawadi", capacity: 4 },
  { no: "208", type: "fam", branch: "zawadi", capacity: 4 },
  { no: "304", type: "ste", branch: "zawadi", capacity: 4 },
];

describe("Zawadi Springs Nairobi availability baseline", () => {
  const TODAY = "2026-08-22";

  it("never offers the dirty room 103 for a same-day arrival", () => {
    const rooms = available(ZAWADI, { arrival: TODAY, departure: "2026-08-23", todayIs: TODAY });
    expect(rooms).not.toContain("103");
  });

  it("offers room 103 again for a future arrival once it can be cleaned", () => {
    const rooms = available(ZAWADI, { arrival: "2026-08-24", departure: "2026-08-25", todayIs: TODAY });
    expect(rooms).toContain("103");
  });

  it("never offers maintenance-blocked 104 or out-of-service 108", () => {
    for (const range of [
      ["2026-08-22", "2026-08-23"],
      ["2026-08-24", "2026-08-28"],
    ] as Array<[string, string]>) {
      const rooms = available(ZAWADI, { arrival: range[0], departure: range[1], todayIs: TODAY });
      expect(rooms).not.toContain("104");
      expect(rooms).not.toContain("108");
    }
  });

  it("excludes a room inside an out-of-order interval only while it lasts", () => {
    const withOoo: Room[] = ZAWADI.map((r) =>
      r.no === "105" ? { ...r, ooo: ["2026-08-24", "2026-08-26"] as [string, string] } : r,
    );
    expect(available(withOoo, { arrival: "2026-08-25", departure: "2026-08-26", todayIs: TODAY })).not.toContain("105");
    expect(available(withOoo, { arrival: "2026-08-27", departure: "2026-08-28", todayIs: TODAY })).toContain("105");
  });

  it("excludes rooms with an overlapping assigned stay, block or hold", () => {
    const busy: Room[] = ZAWADI.map((r) =>
      r.no === "101"
        ? { ...r, stays: [["2026-08-24", "2026-08-26"]] as Array<[string, string]> }
        : r.no === "102"
          ? { ...r, blocks: [["2026-08-24", "2026-08-25"]] as Array<[string, string]> }
          : r.no === "106"
            ? { ...r, holds: [["2026-08-24", "2026-08-25"]] as Array<[string, string]> }
            : r,
    );
    const rooms = available(busy, { arrival: "2026-08-24", departure: "2026-08-25", todayIs: TODAY });
    expect(rooms).not.toContain("101");
    expect(rooms).not.toContain("102");
    expect(rooms).not.toContain("106");
  });

  it("allows a stay starting on the departure day of another stay", () => {
    const busy: Room[] = ZAWADI.map((r) =>
      r.no === "101" ? { ...r, stays: [["2026-08-22", "2026-08-24"]] as Array<[string, string]> } : r,
    );
    expect(available(busy, { arrival: "2026-08-24", departure: "2026-08-25", todayIs: TODAY })).toContain("101");
  });

  it("reduces Family Room inventory for the unassigned confirmed 24→28 stay", () => {
    const open = available(ZAWADI, { arrival: "2026-08-24", departure: "2026-08-28", todayIs: TODAY, roomType: "fam" });
    const withDemand = available(ZAWADI, {
      arrival: "2026-08-24",
      departure: "2026-08-28",
      todayIs: TODAY,
      roomType: "fam",
      unassignedDemand: { fam: 1 },
    });
    expect(open).toHaveLength(3);
    expect(withDemand).toHaveLength(2);
  });

  it("subtracts group-held inventory on top of unassigned demand", () => {
    const rooms = available(ZAWADI, {
      arrival: "2026-08-24",
      departure: "2026-08-28",
      todayIs: TODAY,
      roomType: "fam",
      groupHeld: { fam: 1 },
      unassignedDemand: { fam: 1 },
    });
    expect(rooms).toHaveLength(1);
  });

  it("honours room type, party size and property filters", () => {
    expect(
      available(ZAWADI, { arrival: "2026-08-24", departure: "2026-08-25", todayIs: TODAY, roomType: "dlx" }),
    ).toEqual(["105", "106", "107"]);
    expect(
      available(ZAWADI, { arrival: "2026-08-24", departure: "2026-08-25", todayIs: TODAY, party: 4 }),
    ).toEqual(["201", "202", "208", "304"]);
    expect(
      available(ZAWADI, { arrival: "2026-08-24", departure: "2026-08-25", todayIs: TODAY, branch: "other" }),
    ).toEqual([]);
  });
});

describe("available room cards", () => {
  const room = (over: Partial<AvailableRoom>): AvailableRoom => ({
    room_id: "r1",
    room_number: "101",
    room_type_id: "t1",
    room_type_name: "Standard",
    floor: "1",
    branch_id: "b1",
    branch_name: "Zawadi Springs Nairobi",
    max_occupancy: 2,
    readiness: "ready",
    maintenance_status: "operational",
    occupancy_status: "vacant",
    nights: 1,
    qualification: "Sellable",
    ...over,
  });

  it("labels every card with its property when several properties are returned", () => {
    const groups = groupByProperty([
      room({}),
      room({ room_id: "r2", branch_id: "b2", branch_name: "Mawimbi Beach" }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Zawadi Springs Nairobi", "Mawimbi Beach"]);
    expect(groups.every((g) => g.rooms.length === 1)).toBe(true);
  });

  it("never leaves a card unlabelled", () => {
    const groups = groupByProperty([room({ branch_id: null, branch_name: null })]);
    expect(groups[0]?.label).toBe("Property not set");
  });
});
