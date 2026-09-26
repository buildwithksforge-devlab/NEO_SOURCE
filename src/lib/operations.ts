/**
 * Phase 12 — Housekeeping, Laundry, Maintenance & Internal Requisitions vocabulary.
 *
 * Room status is owned by the Phase 5 PMS `rooms` table; the labels below only map
 * the stored values onto the operational language used across these screens.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Row = Record<string, any>;

export type Tone = "default" | "success" | "warning" | "info" | "destructive";

export function titleCase(value: unknown): string {
  return String(value ?? "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function shortDateTime(value: unknown): string {
  if (!value) return "—";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function shortDate(value: unknown): string {
  if (!value) return "—";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function minutesBetween(from: unknown, to: unknown): number | null {
  if (!from || !to) return null;
  const a = new Date(String(from)).getTime();
  const b = new Date(String(to)).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 60000));
}

/* ------------------------- room status vocabulary ------------------------- */

/**
 * One canonical housekeeping vocabulary for the whole platform, matching the
 * derived `housekeeping_state` returned by `ops_room_state`. Readiness and
 * "awaiting inspection" are separate states: a clean room with no pending
 * inspection requirement is ready, never awaiting inspection.
 */
export const HOUSEKEEPING_STATUSES = [
  { key: "dirty", label: "Vacant Dirty" },
  { key: "cleaning_queued", label: "Cleaning queued" },
  { key: "cleaning_in_progress", label: "Cleaning in Progress" },
  { key: "awaiting_inspection", label: "Awaiting inspection" },
  { key: "rework_required", label: "Rework required" },
  { key: "ready", label: "Clean / Ready" },
  { key: "out_of_service", label: "Out of Service" },
] as const;

const HOUSEKEEPING_ALIASES: Record<string, string> = {
  "in-progress": "cleaning_in_progress",
  in_progress: "cleaning_in_progress",
  cleaning: "cleaning_in_progress",
  "cleaning-in-progress": "cleaning_in_progress",
  "being-cleaned": "cleaning_in_progress",
  queued: "cleaning_queued",
  "cleaning-queued": "cleaning_queued",
  "awaiting-inspection": "awaiting_inspection",
  "ready-for-inspection": "awaiting_inspection",
  cleaned: "ready",
  clean: "ready",
  inspected: "ready",
  "vacant-clean": "ready",
  "vacant-dirty": "dirty",
  soiled: "dirty",
  failed: "rework_required",
  rework: "rework_required",
  "rework-required": "rework_required",
  "out-of-service": "out_of_service",
};

/** Maps any legacy or display value onto the canonical readiness state. */
export function canonicalHousekeepingStatus(value: unknown): string {
  const raw = String(value ?? "dirty").trim().toLowerCase();
  if (!raw) return "dirty";
  return HOUSEKEEPING_ALIASES[raw] ?? raw.replace(/[\s-]+/g, "_");
}

/**
 * Readiness for a room row from the canonical read model. The derived
 * `housekeeping_state` always wins; the raw stored status is only a fallback
 * for legacy rows read outside the read model.
 */
export function roomHousekeepingState(row: Record<string, unknown>): string {
  const derived = row["housekeeping_state"];
  if (typeof derived === "string" && derived) return canonicalHousekeepingStatus(derived);
  return canonicalHousekeepingStatus(row["housekeeping_status"]);
}


/** Maintenance side of the authoritative room record. */
export const MAINTENANCE_ROOM_STATUSES = [
  { key: "operational", label: "Operational" },
  { key: "under-maintenance", label: "Under Maintenance" },
  { key: "out-of-service", label: "Out of Service" },
  { key: "out-of-order", label: "Out of Order" },
  { key: "blocked", label: "Blocked" },
] as const;

export function housekeepingLabel(value: unknown): string {
  const key = canonicalHousekeepingStatus(value);
  const found = HOUSEKEEPING_STATUSES.find((s) => s.key === key);
  return found ? found.label : titleCase(key.replace(/_/g, " ") || "unknown");
}

export function maintenanceRoomLabel(value: unknown): string {
  const found = MAINTENANCE_ROOM_STATUSES.find((s) => s.key === value);
  return found ? found.label : titleCase(value || "operational");
}

export function housekeepingTone(value: unknown): Tone {
  switch (canonicalHousekeepingStatus(value)) {
    case "ready":
      return "success";
    case "awaiting_inspection":
      return "warning";
    case "cleaning_in_progress":
    case "cleaning_queued":
      return "info";
    case "rework_required":
      return "warning";
    case "dirty":
      return "destructive";
    default:
      return "default";
  }
}



export function maintenanceRoomTone(value: unknown): Tone {
  if (!value || value === "operational" || value === "ok" || value === "none") return "success";
  if (value === "under-maintenance") return "warning";
  return "destructive";
}

/* ------------------------------ housekeeping ------------------------------ */

export const HK_JOB_TYPES = [
  "checkout-cleaning",
  "stayover-cleaning",
  "arrival-preparation",
  "vip-preparation",
  "deep-cleaning",
  "turndown-service",
  "extra-towels",
  "extra-linen",
  "extra-amenities",
  "extra-bed",
  "baby-cot",
  "room-inspection",
  "public-area-cleaning",
  "event-venue-cleaning",
  "washroom-inspection",
  "minibar-check",
  "maintenance-follow-up",
] as const;

/**
 * Types the cleaning-task routine accepts. `HK_JOB_TYPES` is the full display
 * vocabulary of historical jobs; only these may be raised by hand, so the
 * create form must not offer anything else.
 */
export const HK_RAISEABLE_JOB_TYPES = [
  "checkout-cleaning",
  "stayover-cleaning",
  "deep-cleaning",
  "touch-up",
  "rework",
  "recovery",
] as const;

export const HK_JOB_STATUSES = [
  "pending",
  "assigned",
  "in-progress",
  "awaiting-inspection",
  "rework",
  "completed",
  "skipped",
  "cancelled",
] as const;

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export function jobStatusTone(status: unknown): Tone {
  switch (status) {
    case "completed":
      return "success";
    case "awaiting-inspection":
      return "warning";
    case "rework":
      return "destructive";
    case "in-progress":
      return "info";
    case "cancelled":
    case "skipped":
      return "default";
    default:
      return "default";
  }
}

export function priorityTone(priority: unknown): Tone {
  switch (priority) {
    case "emergency":
    case "urgent":
      return "destructive";
    case "high":
      return "warning";
    case "low":
      return "default";
    default:
      return "info";
  }
}

export const INSPECTION_TYPES = [
  { key: "standard", label: "Standard room inspection" },
  { key: "vip", label: "VIP room inspection" },
  { key: "deep-clean", label: "Deep-clean inspection" },
  { key: "maintenance-release", label: "Maintenance release inspection" },
  { key: "public-area", label: "Public-area inspection" },
] as const;

export const INSPECTION_RESULTS = [
  { key: "passed", label: "Passed" },
  { key: "passed-with-notes", label: "Passed with Notes" },
  { key: "failed", label: "Failed" },
  { key: "reinspection-required", label: "Reinspection Required" },
] as const;

export const DEFAULT_ROOM_CHECKLIST = [
  "Bed made",
  "Linen replaced",
  "Towels replaced",
  "Bathroom cleaned",
  "Toiletries replenished",
  "Floor cleaned",
  "Dust removed",
  "Waste removed",
  "Windows checked",
  "Lights checked",
  "Television checked",
  "Air conditioner checked",
  "Water checked",
  "Guest amenities replenished",
  "Damage inspected",
  "Lost property checked",
];

export const LOST_FOUND_STATUSES = [
  "reported",
  "in-custody",
  "potential-owner-identified",
  "contacted",
  "claimed",
  "returned",
  "disposed",
  "donated",
  "transferred-to-authorities",
] as const;

export const LOST_FOUND_CATEGORIES = [
  "general",
  "clothing",
  "documents",
  "electronics",
  "jewellery",
  "cash",
  "medication",
  "other",
] as const;

export const SENSITIVE_CATEGORIES = ["cash", "documents", "electronics", "jewellery"];

/* -------------------------------- laundry -------------------------------- */

export const GUEST_LAUNDRY_STATUSES = [
  "requested",
  "awaiting-collection",
  "collected",
  "received",
  "washing",
  "drying",
  "ironing",
  "quality-check",
  "packaged",
  "ready-for-delivery",
  "delivered",
  "completed",
  "on-hold",
  "disputed",
  "cancelled",
] as const;

export function laundryTone(status: unknown): Tone {
  switch (status) {
    case "completed":
    case "delivered":
      return "success";
    case "disputed":
    case "on-hold":
      return "destructive";
    case "ready-for-delivery":
    case "quality-check":
      return "warning";
    case "cancelled":
      return "default";
    default:
      return "info";
  }
}

export const LAUNDRY_SERVICE_TYPES = [
  { key: "wash-iron", label: "Wash & iron" },
  { key: "wash-fold", label: "Wash & fold" },
  { key: "dry-clean", label: "Dry cleaning" },
  { key: "iron-only", label: "Ironing only" },
  { key: "stain-treatment", label: "Stain treatment" },
] as const;

export const LINEN_CATEGORIES = [
  "bed-linen",
  "duvet-cover",
  "duvet",
  "pillowcase",
  "towel",
  "bath-mat",
  "curtain",
  "tablecloth",
  "napkin",
  "chef-uniform",
  "staff-uniform",
  "event-linen",
] as const;

export const LINEN_STATES = [
  "clean",
  "in-use",
  "soiled",
  "in-transit",
  "in-laundry",
  "damaged",
  "missing",
  "condemned",
  "available",
] as const;

export const LINEN_INCIDENT_REASONS = [
  "torn",
  "stained",
  "burnt",
  "worn-out",
  "lost",
  "guest-damage",
  "laundry-damage",
  "unknown",
] as const;

export const LAUNDRY_CYCLE_TYPES = [
  "normal",
  "delicate",
  "heavy-duty",
  "dry-clean-prep",
  "rewash",
  "special-treatment",
] as const;

/* ------------------------------ maintenance ------------------------------ */

export const FAULT_CATEGORIES = [
  "electrical",
  "plumbing",
  "carpentry",
  "painting",
  "air-conditioning",
  "water-system",
  "network",
  "security-equipment",
  "kitchen-equipment",
  "laundry-equipment",
  "furniture",
  "building",
  "vehicle",
  "preventive",
  "other",
] as const;

export const WO_PRIORITIES = ["low", "normal", "high", "urgent", "emergency"] as const;

export const WO_STATUSES = [
  "new",
  "assigned",
  "accepted",
  "diagnosis",
  "waiting-parts",
  "waiting-supplier",
  "in-progress",
  "completed",
  "awaiting-verification",
  "reopened",
  "closed",
  "cancelled",
] as const;

/** Kanban columns for the maintenance board. */
export const WO_BOARD_COLUMNS: { key: string; label: string; statuses: string[] }[] = [
  { key: "intake", label: "New & assigned", statuses: ["new", "assigned", "accepted"] },
  { key: "diagnosis", label: "Diagnosis", statuses: ["diagnosis"] },
  { key: "waiting", label: "Waiting for parts", statuses: ["waiting-parts", "waiting-supplier"] },
  { key: "repair", label: "Repair in progress", statuses: ["in-progress", "reopened"] },
  { key: "verify", label: "Verification", statuses: ["completed", "awaiting-verification"] },
  { key: "closed", label: "Closed", statuses: ["closed", "cancelled"] },
];

export function woStatusTone(status: unknown): Tone {
  switch (status) {
    case "closed":
      return "success";
    case "completed":
    case "awaiting-verification":
      return "info";
    case "waiting-parts":
    case "waiting-supplier":
      return "warning";
    case "reopened":
      return "destructive";
    default:
      return "default";
  }
}

export const ASSET_STATUSES = [
  "active",
  "in-storage",
  "assigned",
  "under-maintenance",
  "out-of-service",
  "lost",
  "disposed",
  "sold",
  "retired",
] as const;

export const ASSET_CONDITIONS = ["excellent", "good", "fair", "poor", "unserviceable"] as const;

/**
 * End states. Once an asset has left the estate — disposed, sold or retired —
 * it stays in the register as history and cannot be returned to service; a new
 * record is registered instead. "Lost" is deliberately not final, because found
 * property is a real and common outcome.
 */
export const ASSET_FINAL_STATUSES = ["disposed", "sold", "retired"] as const;

export function isAssetStatusTransitionAllowed(from: string, to: string): boolean {
  if (from === to) return true;
  return !(ASSET_FINAL_STATUSES as readonly string[]).includes(from);
}


export const PM_FREQUENCIES = [
  { key: "weekly", label: "Weekly", days: 7 },
  { key: "fortnightly", label: "Fortnightly", days: 14 },
  { key: "monthly", label: "Monthly", days: 30 },
  { key: "quarterly", label: "Quarterly", days: 90 },
  { key: "biannual", label: "Every 6 months", days: 182 },
  { key: "annual", label: "Annually", days: 365 },
] as const;

/* ----------------------------- requisitions ----------------------------- */

export const REQUISITION_STATUSES = [
  "draft",
  "submitted",
  "pending-supervisor",
  "awaiting-stores",
  "approved",
  "partially-approved",
  "ready-for-issue",
  "partially-issued",
  "issued",
  "partially-received",
  "received",
  "closed",
  "sent-back",
  "rejected",
  "cancelled",
] as const;

export function requisitionTone(status: unknown): Tone {
  switch (status) {
    case "received":
    case "closed":
      return "success";
    case "rejected":
    case "cancelled":
    case "sent-back":
      return "destructive";
    case "partially-issued":
    case "partially-received":
    case "partially-approved":
      return "warning";
    case "draft":
      return "default";
    default:
      return "info";
  }
}

export const FULFILMENT_MODELS = [
  { key: "direct-issue", label: "Direct issue (counts as consumption)" },
  { key: "mini-store", label: "Transfer to department mini-store" },
] as const;

/* ------------------------------- AI advisory ------------------------------ */

export type OpsInsight = { title: string; detail: string; tone: Tone };

/**
 * Advisory only. Derived from records the signed-in user can already read; it never
 * changes room status, approves requisitions, deducts stock or closes work orders.
 */
export function buildOperationsInsights(metrics: Row, workOrders: Row[], jobs: Row[]): OpsInsight[] {
  const out: OpsInsight[] = [];

  const faultsByRoom = new Map<string, { count: number; label: string }>();
  for (const wo of workOrders) {
    const label = wo["rooms"]?.room_number ?? wo["location_label"];
    if (!label) continue;
    const entry = faultsByRoom.get(String(label)) ?? { count: 0, label: String(label) };
    entry.count += 1;
    faultsByRoom.set(String(label), entry);
  }
  for (const entry of faultsByRoom.values()) {
    if (entry.count >= 3) {
      out.push({
        title: `Repeated faults at ${entry.label}`,
        detail: `${entry.count} maintenance requests recorded. Consider a full inspection during the next maintenance cycle.`,
        tone: "warning",
      });
    }
  }

  const dirty = num(metrics["rooms_dirty"]);
  if (dirty >= 8) {
    out.push({
      title: "Turnover pressure building",
      detail: `${dirty} rooms are waiting for cleaning. Consider adding attendants to the morning turnover shift.`,
      tone: "warning",
    });
  }

  const rework = jobs.filter((j) => j["status"] === "rework").length;
  if (rework >= 2) {
    out.push({
      title: "Repeated inspection failures",
      detail: `${rework} cleaning jobs are in rework. Review the checklist coverage and attendant briefing.`,
      tone: "destructive",
    });
  }

  if (num(metrics["pm_due"]) > 0) {
    out.push({
      title: "Preventive maintenance due",
      detail: `${num(metrics["pm_due"])} plans fall due within 14 days. Generate the work orders before the equipment window closes.`,
      tone: "info",
    });
  }

  if (num(metrics["laundry_unposted"]) > 0) {
    out.push({
      title: "Laundry charges not yet posted",
      detail: `${num(metrics["laundry_unposted"])} delivered laundry orders have no folio charge. Post them before departure.`,
      tone: "warning",
    });
  }

  if (!out.length) {
    out.push({
      title: "Operations look steady",
      detail: "No repeated faults, rework clusters or overdue preventive work detected in the records you can access.",
      tone: "success",
    });
  }
  return out;
}
