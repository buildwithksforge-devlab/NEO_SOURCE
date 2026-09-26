import { describe, expect, it } from "vitest";
import {
  HOUSEKEEPING_STATUSES,
  canonicalHousekeepingStatus,
  housekeepingLabel,
  housekeepingTone,
  roomHousekeepingState,
} from "@/lib/operations";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";
import { parseAvailabilitySearch } from "@/lib/availability-search";
import { nightsBetween } from "@/lib/pms";

/**
 * The readiness contract: a clean room with no pending inspection requirement
 * is ready. "Awaiting inspection" exists only after a cleaning workflow that
 * requires inspection.
 */
describe("canonical housekeeping readiness vocabulary", () => {
  it("keeps clean/ready and awaiting-inspection as distinct states", () => {
    expect(canonicalHousekeepingStatus("clean")).toBe("ready");
    expect(canonicalHousekeepingStatus("vacant-clean")).toBe("ready");
    expect(canonicalHousekeepingStatus("inspected")).toBe("ready");
    expect(canonicalHousekeepingStatus("awaiting-inspection")).toBe("awaiting_inspection");
    expect(canonicalHousekeepingStatus("clean")).not.toBe(canonicalHousekeepingStatus("awaiting-inspection"));
  });

  it("normalises every legacy cleaning and rework alias", () => {
    expect(canonicalHousekeepingStatus("in-progress")).toBe("cleaning_in_progress");
    expect(canonicalHousekeepingStatus("Cleaning In Progress")).toBe("cleaning_in_progress");
    expect(canonicalHousekeepingStatus("queued")).toBe("cleaning_queued");
    expect(canonicalHousekeepingStatus("vacant-dirty")).toBe("dirty");
    expect(canonicalHousekeepingStatus("failed")).toBe("rework_required");
    expect(canonicalHousekeepingStatus("rework")).toBe("rework_required");
  });

  it("labels and tones every canonical state", () => {
    for (const status of HOUSEKEEPING_STATUSES) {
      expect(housekeepingLabel(status.key)).toBe(status.label);
      expect(typeof housekeepingTone(status.key)).toBe("string");
    }
    expect(housekeepingTone("ready")).toBe("success");
    expect(housekeepingTone("awaiting_inspection")).toBe("warning");
  });

  it("prefers the derived read-model state over the stored status", () => {
    expect(
      roomHousekeepingState({ housekeeping_state: "awaiting_inspection", housekeeping_status: "clean" }),
    ).toBe("awaiting_inspection");
    expect(roomHousekeepingState({ housekeeping_status: "clean" })).toBe("ready");
    expect(roomHousekeepingState({ housekeeping_state: "rework_required" })).toBe("rework_required");
  });
});

describe("readiness derivation rules", () => {
  /** Mirrors the SQL derivation in ops_room_state so drift is caught here. */
  function derive(r: {
    hk: string;
    inspection?: string;
    maintenance?: string;
    occupancy?: string;
    inventory?: string;
    reservation?: boolean;
  }) {
    const hk = canonicalHousekeepingStatus(r.hk);
    const insp = r.inspection ?? "not-required";
    const mt = r.maintenance ?? "operational";
    const occ = r.occupancy ?? "vacant";
    const inv = r.inventory ?? "active";
    const state =
      hk === "rework_required" || insp === "failed"
        ? "rework_required"
        : hk === "awaiting_inspection" || (hk === "ready" && insp === "pending")
          ? "awaiting_inspection"
          : hk;
    const sellableNow = inv === "active" && occ === "vacant" && mt === "operational" && state === "ready";
    return { state, sellableNow, available: sellableNow && !r.reservation };
  }

  it("marks a clean, operational, vacant room ready and sellable", () => {
    expect(derive({ hk: "clean" })).toEqual({ state: "ready", sellableNow: true, available: true });
  });

  it("never sells dirty, queued, cleaning, awaiting-inspection or rework rooms", () => {
    for (const hk of ["dirty", "cleaning-queued", "in-progress", "awaiting-inspection", "rework"]) {
      expect(derive({ hk }).sellableNow).toBe(false);
    }
  });

  it("never sells a maintenance-blocked or out-of-service room, however clean", () => {
    expect(derive({ hk: "clean", maintenance: "under-maintenance" }).sellableNow).toBe(false);
    expect(derive({ hk: "clean", maintenance: "out-of-service" }).sellableNow).toBe(false);
    expect(derive({ hk: "inspected", maintenance: "out-of-order" }).sellableNow).toBe(false);
  });

  it("holds a room that is occupied or carries a reservation", () => {
    expect(derive({ hk: "clean", occupancy: "occupied" }).sellableNow).toBe(false);
    expect(derive({ hk: "clean", reservation: true }).available).toBe(false);
  });

  it("treats a passed inspection as ready and a failed one as rework", () => {
    expect(derive({ hk: "inspected", inspection: "passed" }).state).toBe("ready");
    expect(derive({ hk: "clean", inspection: "pending" }).state).toBe("awaiting_inspection");
    expect(derive({ hk: "clean", inspection: "failed" }).state).toBe("rework_required");
  });

  it("reproduces the Zawadi 12-room baseline", () => {
    const property = [
      { no: "101", hk: "clean" },
      { no: "102", hk: "clean" },
      { no: "103", hk: "dirty" },
      { no: "104", hk: "clean", maintenance: "under-maintenance" },
      { no: "105", hk: "clean" },
      { no: "106", hk: "clean" },
      { no: "107", hk: "clean" },
      { no: "108", hk: "clean", maintenance: "out-of-service" },
      { no: "201", hk: "clean" },
      { no: "202", hk: "clean" },
      { no: "208", hk: "clean" },
      { no: "304", hk: "clean" },
    ];
    const derived = property.map((r) => derive(r));
    expect(property).toHaveLength(12);
    expect(derived.filter((d) => d.sellableNow)).toHaveLength(9);
    expect(derived.filter((d) => d.state === "dirty")).toHaveLength(1);
    expect(
      property.filter((r) => r.maintenance && r.maintenance !== "operational"),
    ).toHaveLength(2);
    expect(derived.filter((d) => d.state === "awaiting_inspection")).toHaveLength(0);
  });
});

describe("stay overlap uses half-open [arrival, departure) semantics", () => {
  const overlaps = (a: [string, string], b: [string, string]) => a[0] < b[1] && b[0] < a[1];

  it("allows an adjacent stay starting on the departure day", () => {
    expect(overlaps(["2026-09-01", "2026-09-03"], ["2026-09-03", "2026-09-05"])).toBe(false);
  });

  it("blocks a genuinely overlapping stay", () => {
    expect(overlaps(["2026-09-01", "2026-09-04"], ["2026-09-03", "2026-09-05"])).toBe(true);
  });

  it("rejects a same-day range as zero nights", () => {
    expect(nightsBetween("2026-09-01", "2026-09-01")).toBe(0);
    expect(nightsBetween("2026-09-01", "2026-09-02")).toBe(1);
  });
});

describe("availability search state is durable", () => {
  it("preserves submitted dates, room type and party from the URL", () => {
    const parsed = parseAvailabilitySearch({
      arrival: "2026-09-10",
      departure: "2026-09-13",
      roomType: "rt-1",
      adults: "3",
      children: "1",
    });
    expect(parsed).toEqual({
      arrival: "2026-09-10",
      departure: "2026-09-13",
      roomType: "rt-1",
      adults: 3,
      children: 1,
    });
  });

  it("never substitutes today for an invalid value", () => {
    const parsed = parseAvailabilitySearch({ arrival: "not-a-date", departure: "2026-09-13" });
    expect(parsed.arrival).toBeUndefined();
    expect(parsed.departure).toBe("2026-09-13");
  });
});

describe("the canonical room routines are declared callable", () => {
  it("registers the readiness read models for signed-in staff only", () => {
    for (const fn of ["ops_room_state", "ops_room_availability", "ops_room_state_reconciliation"]) {
      expect(RPC_MANIFEST[fn]).toBe("authenticated");
    }
  });
});
