/**
 * Phase 8 — Kitchen Management System vocabulary.
 *
 * Extends the Phase 7 POS/KDS foundation: station tickets remain production
 * instructions attached to a POS order, never a second financial record.
 */

export const TICKET_STATUSES = [
  "new",
  "accepted",
  "preparing",
  "partially-ready",
  "ready",
  "served",
  "cancel-pending",
  "cancelled",
  "completed",
  "delayed",
] as const;

export const TICKET_ITEM_STATUSES = [
  "new",
  "accepted",
  "preparing",
  "ready",
  "collected",
  "served",
  "cancel-pending",
  "cancelled",
  "remake-requested",
  "remaking",
  "completed",
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketItemStatus = (typeof TICKET_ITEM_STATUSES)[number];

/** Mirrors `kitchen_item_transition()` in the database. The server is authoritative. */
export const ITEM_TRANSITIONS: Record<string, TicketItemStatus[]> = {
  new: ["accepted", "cancel-pending"],
  accepted: ["preparing", "cancel-pending"],
  preparing: ["ready", "cancel-pending"],
  ready: ["collected", "remake-requested"],
  collected: ["served", "remake-requested"],
  served: ["completed", "remake-requested"],
  "cancel-pending": ["cancelled", "preparing"],
  "remake-requested": ["remaking"],
  remaking: ["ready"],
};

export const ITEM_ACTION_LABELS: Record<string, string> = {
  accepted: "Accept",
  preparing: "Start preparing",
  ready: "Mark ready",
  collected: "Collected",
  served: "Served",
  completed: "Complete",
  "cancel-pending": "Request cancellation",
  cancelled: "Cancel",
  "remake-requested": "Request remake",
  remaking: "Start remake",
};

export const QUEUE_VIEWS = [
  { key: "new", label: "New" },
  { key: "accepted", label: "Accepted" },
  { key: "preparing", label: "Preparing" },
  { key: "partially-ready", label: "Partially ready" },
  { key: "ready", label: "Ready" },
  { key: "delayed", label: "Delayed" },
  { key: "cancelled", label: "Cancelled" },
] as const;

export const WASTE_CATEGORIES = [
  "preparation-trim",
  "spoiled-ingredient",
  "expired-ingredient",
  "burnt-overcooked",
  "preparation-mistake",
  "returned-meal",
  "overproduction",
  "portioning-error",
  "storage-issue",
  "damaged-item",
  "other",
];

export const REQUEST_STATUSES = [
  "draft",
  "submitted",
  "stores-reviewing",
  "available",
  "partially-available",
  "issued",
  "collected",
  "not-available",
  "escalated-to-procurement",
  "cancelled",
  "closed",
];

export const RECIPE_STATUSES = ["draft", "under-review", "approved", "active", "superseded", "archived"];

export const QUALITY_CHECKLIST_TYPES = [
  "recipe-compliance",
  "portion-control",
  "cooking-checks",
  "dietary-allergy",
  "presentation",
  "packaging",
  "buffet-setup",
  "room-service",
  "station-opening",
  "station-closing",
  "cleaning-hygiene",
];

export const EQUIPMENT_ISSUE_TYPES = [
  "equipment-breakdown",
  "temperature-control",
  "gas-lpg",
  "power",
  "water",
  "other",
];

/** Deduction points supported by Kitchen settings — exactly one may be active. */
export const DEDUCTION_POINTS = [
  { value: "sent-to-kitchen", label: "When the item is sent to the kitchen" },
  { value: "preparation-start", label: "When preparation begins" },
  { value: "marked-ready", label: "When the item is marked ready" },
  { value: "sale-finalized", label: "When the sale is finalized" },
  { value: "batch-produced", label: "When a batch is produced" },
] as const;

export type KitchenSettings = {
  default_kds_view: string;
  warning_percent: number;
  critical_percent: number;
  sort_rule: "received" | "priority" | "target";
  require_allergy_ack: boolean;
  require_recipe_approval: boolean;
  deduction_point: string;
  waste_approval_threshold: number;
  require_quality_check: boolean;
  supervisor_ready_approval: boolean;
  sound_alerts: boolean;
  require_handover: boolean;
  operational_day_start: string;
};

export const DEFAULT_KITCHEN_SETTINGS: KitchenSettings = {
  default_kds_view: "new",
  warning_percent: 80,
  critical_percent: 130,
  sort_rule: "received",
  require_allergy_ack: true,
  require_recipe_approval: true,
  deduction_point: "sale-finalized",
  waste_approval_threshold: 0,
  require_quality_check: false,
  supervisor_ready_approval: false,
  sound_alerts: true,
  require_handover: true,
  operational_day_start: "06:00",
};

export function titleCase(value?: string | null) {
  if (!value) return "—";
  return value
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function minutesSince(iso?: string | null) {
  if (!iso) return 0;
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

export type TimerState = "new" | "within-target" | "approaching" | "delayed" | "critical";

export function timerState(elapsed: number, target: number, settings = DEFAULT_KITCHEN_SETTINGS): TimerState {
  if (!target) return "new";
  const pct = (elapsed / target) * 100;
  if (pct >= settings.critical_percent) return "critical";
  if (pct > 100) return "delayed";
  if (pct >= settings.warning_percent) return "approaching";
  return "within-target";
}

export function timerTone(state: TimerState) {
  switch (state) {
    case "critical":
      return "destructive" as const;
    case "delayed":
      return "destructive" as const;
    case "approaching":
      return "warning" as const;
    default:
      return "success" as const;
  }
}

export function timerLabel(state: TimerState) {
  switch (state) {
    case "critical":
      return "Critical";
    case "delayed":
      return "Delayed";
    case "approaching":
      return "Approaching delay";
    default:
      return "Within target";
  }
}

export function ticketStatusTone(status: string) {
  switch (status) {
    case "ready":
    case "completed":
    case "served":
      return "success" as const;
    case "delayed":
    case "cancelled":
      return "destructive" as const;
    case "partially-ready":
    case "cancel-pending":
      return "warning" as const;
    default:
      return "default" as const;
  }
}

export function nextRequestNumber(prefix = "KR") {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
}

/**
 * Loosely typed database row. Kitchen queries use runtime-built select strings,
 * so rows are shaped by the query rather than by the generated table types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;
