import { describe, expect, it } from "vitest";

import {
  canAssignReservation,
  canTransition,
  isSellable,
  isSellableNow,
  roomStage,
  stageAfterCheckout,
  stageAfterCleaning,
  stageAfterMaintenance,
  unsellableReason,
  type CanonicalRoomState,
} from "../room-lifecycle";

const room = (over: Partial<CanonicalRoomState> = {}): CanonicalRoomState => ({
  room_id: "r1",
  room_number: "113",
  inventory_status: "active",
  occupancy_status: "vacant",
  housekeeping_state: "ready",
  inspection_status: "not-required",
  maintenance_status: "operational",
  current_reservation_id: null,
  ...over,
});

describe("canonical room stage", () => {
  it("reads a clean vacant room as ready and sellable", () => {
    const r = room();
    expect(roomStage(r)).toBe("vacant-ready");
    expect(isSellable(r)).toBe(true);
    expect(isSellableNow(r)).toBe(true);
  });

  it("treats a held room as reserved and not sellable now", () => {
    const r = room({ current_reservation_id: "res-1" });
    expect(roomStage(r)).toBe("reserved");
    expect(isSellableNow(r)).toBe(false);
  });

  it("never sells an out-of-order room", () => {
    const r = room({ maintenance_status: "out-of-order" });
    expect(roomStage(r)).toBe("out-of-order");
    expect(isSellable(r)).toBe(false);
    expect(unsellableReason(r)).toBeTruthy();
  });

  it("never assigns an occupied room to a second reservation", () => {
    const r = room({ occupancy_status: "occupied" });
    expect(roomStage(r)).toBe("occupied");
    expect(canAssignReservation(r)).toBe(false);
  });

  it("keeps a dirty room unsellable after checkout completes", () => {
    expect(stageAfterCheckout()).toBe("vacant-dirty");
    const r = room({ housekeeping_state: "dirty" });
    expect(roomStage(r)).toBe("vacant-dirty");
    expect(isSellable(r)).toBe(false);
  });

  it("ranks maintenance above occupancy and occupancy above housekeeping", () => {
    expect(roomStage(room({ occupancy_status: "occupied", maintenance_status: "out-of-service" }))).toBe(
      "out-of-service",
    );
    expect(roomStage(room({ occupancy_status: "occupied", housekeeping_state: "dirty" }))).toBe(
      "occupied",
    );
    expect(roomStage(room({ inventory_status: "retired" }))).toBe("inactive");
  });
});

describe("completion does not shortcut the lifecycle", () => {
  it("holds a cleaned room for inspection when inspection is configured", () => {
    expect(stageAfterCleaning(true)).toBe("awaiting-inspection");
    expect(stageAfterCleaning(false)).toBe("vacant-ready");
  });

  it("does not make a repaired room sellable while cleaning or inspection is due", () => {
    expect(stageAfterMaintenance({ cleaningOutstanding: true, inspectionRequired: false })).toBe(
      "vacant-dirty",
    );
    expect(stageAfterMaintenance({ cleaningOutstanding: false, inspectionRequired: true })).toBe(
      "awaiting-inspection",
    );
    expect(stageAfterMaintenance({ cleaningOutstanding: false, inspectionRequired: false })).toBe(
      "vacant-ready",
    );
  });

  it("only permits recognised transitions", () => {
    expect(canTransition("occupied", "checkout")).toBe(true);
    expect(canTransition("checkout", "vacant-dirty")).toBe(true);
    expect(canTransition("checkout", "vacant-ready")).toBe(false);
    expect(canTransition("cleaning", "awaiting-inspection")).toBe(true);
    expect(canTransition("out-of-order", "vacant-ready")).toBe(false);
    expect(canTransition("vacant-ready", "occupied")).toBe(true);
  });
});
