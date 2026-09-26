/**
 * The canonical room lifecycle.
 *
 * PMS, Housekeeping, Maintenance and availability must all read the same room
 * state. The database derives it in `public.ops_room_state` (inventory,
 * occupancy, housekeeping, inspection and maintenance combined); this module is
 * the single front-end mirror of that derivation, so no screen may invent its
 * own idea of "ready" or "sellable" from a raw `rooms` column.
 *
 * Lifecycle:
 *   Vacant Ready → Reserved/Assigned → Occupied → Checkout → Vacant Dirty →
 *   Cleaning → Awaiting Inspection → Vacant Ready
 * Maintenance branch:
 *   any eligible state → Maintenance Fault → Out of Order / Out of Service →
 *   Repair → Inspection → Housekeeping (if required) → Vacant Ready
 */

export type RoomStage =
  | "inactive"
  | "vacant-ready"
  | "reserved"
  | "occupied"
  | "house-use"
  | "checkout"
  | "vacant-dirty"
  | "cleaning"
  | "awaiting-inspection"
  | "rework"
  | "maintenance-fault"
  | "out-of-order"
  | "out-of-service";

/** A row from `ops_room_state`, narrowed to the fields the lifecycle needs. */
export type CanonicalRoomState = {
  room_id?: string | null;
  room_number?: string | null;
  inventory_status?: string | null;
  occupancy_status?: string | null;
  housekeeping_state?: string | null;
  inspection_status?: string | null;
  maintenance_status?: string | null;
  current_reservation_id?: string | null;
  departure_today?: boolean | null;
  sellable?: boolean | null;
  sellable_now?: boolean | null;
  sellability_reason?: string | null;
};

export const STAGE_LABELS: Record<RoomStage, string> = {
  inactive: "Not in inventory",
  "vacant-ready": "Vacant ready",
  reserved: "Reserved / assigned",
  occupied: "Occupied",
  "house-use": "House use",
  checkout: "Departing today",
  "vacant-dirty": "Vacant dirty",
  cleaning: "Cleaning",
  "awaiting-inspection": "Awaiting inspection",
  rework: "Rework required",
  "maintenance-fault": "Maintenance fault",
  "out-of-order": "Out of order",
  "out-of-service": "Out of service",
};

/**
 * The only transitions the platform recognises. A module may not shortcut the
 * chain — a completed clean cannot reach `vacant-ready` while inspection is
 * configured, and a completed repair cannot reach it while cleaning is due.
 */
export const ROOM_TRANSITIONS: Record<RoomStage, RoomStage[]> = {
  inactive: ["vacant-dirty", "vacant-ready"],
  "vacant-ready": ["reserved", "occupied", "maintenance-fault", "inactive"],
  reserved: ["occupied", "vacant-ready", "maintenance-fault"],
  occupied: ["checkout", "maintenance-fault"],
  checkout: ["vacant-dirty"],
  "vacant-dirty": ["cleaning", "maintenance-fault"],
  cleaning: ["awaiting-inspection", "vacant-ready", "rework", "maintenance-fault"],
  "awaiting-inspection": ["vacant-ready", "rework", "maintenance-fault"],
  rework: ["cleaning", "maintenance-fault"],
  "house-use": ["vacant-dirty", "vacant-ready", "maintenance-fault"],
  "maintenance-fault": ["out-of-order", "out-of-service", "vacant-dirty", "awaiting-inspection"],
  "out-of-order": ["awaiting-inspection", "vacant-dirty", "maintenance-fault"],
  "out-of-service": ["awaiting-inspection", "vacant-dirty", "maintenance-fault"],
};

export function canTransition(from: RoomStage, to: RoomStage): boolean {
  return (ROOM_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Resolve the canonical stage. Precedence matters: an inventory or maintenance
 * block outranks occupancy, and occupancy outranks housekeeping progress.
 */
export function roomStage(row: CanonicalRoomState): RoomStage {
  const inventory = row.inventory_status ?? "active";
  const maintenance = row.maintenance_status ?? "operational";
  const occupancy = row.occupancy_status ?? "vacant";
  const hk = row.housekeeping_state ?? "ready";
  const inspection = row.inspection_status ?? "not-required";

  if (inventory !== "active") return "inactive";
  if (maintenance === "out-of-order") return "out-of-order";
  if (maintenance === "out-of-service") return "out-of-service";
  if (maintenance === "under-maintenance") return "maintenance-fault";
  if (occupancy === "house-use") return "house-use";
  if (occupancy === "occupied") return row.departure_today ? "checkout" : "occupied";

  if (hk === "rework_required" || inspection === "failed") return "rework";
  if (hk === "awaiting_inspection" || inspection === "pending") return "awaiting-inspection";
  if (hk === "cleaning_in_progress" || hk === "cleaning_queued") return "cleaning";
  if (hk === "dirty") return "vacant-dirty";

  return row.current_reservation_id ? "reserved" : "vacant-ready";
}

/** Stages in which a room may never be sold, whatever another module believes. */
export const UNSELLABLE_STAGES: RoomStage[] = [
  "inactive",
  "out-of-order",
  "out-of-service",
  "maintenance-fault",
  "occupied",
  "checkout",
  "house-use",
  "vacant-dirty",
  "cleaning",
  "awaiting-inspection",
  "rework",
];

/** Mirrors the SQL `sellable` derivation — never a stored `rooms.sellable` flag. */
export function isSellable(row: CanonicalRoomState): boolean {
  return !UNSELLABLE_STAGES.includes(roomStage(row));
}

/** `sellable_now` additionally excludes rooms already held by a reservation. */
export function isSellableNow(row: CanonicalRoomState): boolean {
  return isSellable(row) && !row.current_reservation_id;
}

/** An occupied room can never be assigned to a second reservation. */
export function canAssignReservation(row: CanonicalRoomState): boolean {
  const stage = roomStage(row);
  return stage === "vacant-ready" || stage === "reserved";
}

/** Plain-language explanation for a room that cannot be sold. */
export function unsellableReason(row: CanonicalRoomState): string | null {
  if (isSellable(row)) return null;
  if (row.sellability_reason) return row.sellability_reason;
  return STAGE_LABELS[roomStage(row)];
}

/**
 * The stage a room reaches when a cleaning job is completed. Completion is not
 * Front Office readiness when inspection is configured for the property.
 */
export function stageAfterCleaning(inspectionRequired: boolean): RoomStage {
  return inspectionRequired ? "awaiting-inspection" : "vacant-ready";
}

/**
 * The stage a room reaches when maintenance work completes. A repaired room is
 * not sellable while cleaning or inspection remains outstanding.
 */
export function stageAfterMaintenance(input: {
  cleaningOutstanding: boolean;
  inspectionRequired: boolean;
}): RoomStage {
  if (input.cleaningOutstanding) return "vacant-dirty";
  return input.inspectionRequired ? "awaiting-inspection" : "vacant-ready";
}

/** Checkout leaves a dirty room — it never returns straight to availability. */
export function stageAfterCheckout(): RoomStage {
  return "vacant-dirty";
}

export function stageTone(stage: RoomStage): "success" | "warning" | "danger" | "accent" | "default" {
  if (stage === "vacant-ready") return "success";
  if (stage === "occupied" || stage === "reserved" || stage === "checkout") return "accent";
  if (stage === "out-of-order" || stage === "out-of-service" || stage === "rework") return "danger";
  if (stage === "inactive") return "default";
  return "warning";
}
