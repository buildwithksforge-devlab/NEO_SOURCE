/**
 * Phase 14 — Delivery platform vocabulary and pure helpers.
 * Money, statuses and advisory insights only; all authoritative pricing lives
 * in the database functions (delivery_quote_cart / delivery_place_order).
 */

export const DELIVERY_MODULE = "delivery";

export const ORDER_STATUSES = [
  "draft",
  "pending-payment",
  "payment-verification",
  "confirmed",
  "rejected",
  "in-preparation",
  "ready-for-pickup",
  "rider-assigned",
  "collected",
  "out-for-delivery",
  "delivered",
  "completion-disputed",
  "cancelled",
  "failed",
  "refunded",
  "closed",
] as const;

export const KITCHEN_STATUSES = [
  "not-sent",
  "new",
  "accepted",
  "preparing",
  "ready",
  "completed",
  "cancelled",
] as const;

export const DISPATCH_STATUSES = [
  "awaiting-kitchen",
  "awaiting-rider",
  "rider-assigned",
  "pickup-pending",
  "collected",
  "en-route",
  "delivered",
  "delivery-failed",
  "returned",
] as const;

export const RIDER_AVAILABILITY = [
  "offline",
  "available",
  "reserved",
  "assigned",
  "collecting",
  "delivering",
  "on-break",
  "unavailable",
  "shift-ended",
] as const;

export const FAILURE_REASONS = [
  "customer-unavailable",
  "incorrect-address",
  "customer-unreachable",
  "refused",
  "safety-issue",
  "vehicle-problem",
  "payment-failure",
  "damaged-order",
  "excessive-delay",
  "other",
] as const;

export const FEEDBACK_TOPICS = [
  { key: "food-quality", label: "Food quality", routeTo: "Kitchen Manager" },
  { key: "missing-item", label: "Missing or wrong item", routeTo: "Restaurant Manager" },
  { key: "packaging", label: "Packaging", routeTo: "Restaurant / Delivery Manager" },
  { key: "delivery-delay", label: "Delivery delay", routeTo: "Dispatch Manager" },
  { key: "rider-conduct", label: "Rider conduct", routeTo: "Delivery Manager" },
  { key: "payment", label: "Payment", routeTo: "Finance" },
  { key: "general", label: "General", routeTo: "Customer Care" },
] as const;

export const PACKAGING_CHECKLIST = [
  "Correct items",
  "Correct quantities",
  "Modifiers followed",
  "Sauces included",
  "Cutlery included where requested",
  "Drinks included",
  "Packaging intact",
  "Customer label correct",
  "Allergy note checked",
  "Receipt included",
] as const;

export type Tone = "neutral" | "success" | "warning" | "destructive" | "info";

export function titleCase(value: string | null | undefined) {
  if (!value) return "—";
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function money(value: number | string | null | undefined, _currency = "KES") {
  const n = Number(value ?? 0);
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function moneyWithCode(value: number | string | null | undefined, currency = "KES") {
  return `${currency} ${money(value)}`;
}

export function shortDateTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function minutesSince(value: string | null | undefined) {
  if (!value) return 0;
  return Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
}

export function orderStatusTone(status: string): Tone {
  if (["delivered", "closed"].includes(status)) return "success";
  if (["rejected", "cancelled", "failed", "completion-disputed"].includes(status)) return "destructive";
  if (["pending-payment", "payment-verification", "refunded"].includes(status)) return "warning";
  if (["in-preparation", "ready-for-pickup", "rider-assigned", "collected", "out-for-delivery"].includes(status))
    return "info";
  return "neutral";
}

export function dispatchStatusTone(status: string): Tone {
  if (status === "delivered") return "success";
  if (["delivery-failed", "returned"].includes(status)) return "destructive";
  if (["awaiting-rider", "pickup-pending"].includes(status)) return "warning";
  if (["rider-assigned", "collected", "en-route"].includes(status)) return "info";
  return "neutral";
}

export function riderStatusTone(status: string): Tone {
  if (status === "available") return "success";
  if (["assigned", "collecting", "delivering", "reserved"].includes(status)) return "info";
  if (["on-break", "unavailable"].includes(status)) return "warning";
  return "neutral";
}

/** Customer-facing availability wording — never exposes internal stock levels. */
export function customerAvailability(availability: string, deliveryEligible: boolean) {
  if (!deliveryEligible) return { label: "Not available for delivery", tone: "warning" as Tone };
  switch (availability) {
    case "available":
      return { label: "Available", tone: "success" as Tone };
    case "limited":
      return { label: "Limited", tone: "warning" as Tone };
    case "out-of-stock":
      return { label: "Sold out", tone: "destructive" as Tone };
    case "scheduled":
      return { label: "Available later", tone: "info" as Tone };
    default:
      return { label: "Temporarily unavailable", tone: "warning" as Tone };
  }
}

export type DeliveryOrderRow = {
  id: string;
  order_number: string;
  order_status: string;
  kitchen_status: string;
  dispatch_status: string;
  payment_status: string;
  payment_method: string;
  fulfilment_type: string;
  grand_total: number;
  delivery_fee: number;
  contact_name: string;
  contact_phone: string;
  rider_id: string | null;
  created_at: string;
  accepted_at: string | null;
  delivered_at: string | null;
  estimated_delivery_at: string | null;
  address_snapshot: Record<string, unknown>;
  branch_id: string | null;
  customer_id: string;
};

/**
 * Deterministic advisory insights. This is a rules engine, not a model — it is
 * labelled advisory in the UI and never mutates operational data.
 */
export function deliveryInsights(orders: DeliveryOrderRow[]) {
  const out: { title: string; detail: string; tone: Tone }[] = [];
  if (orders.length === 0) {
    return [
      {
        title: "No delivery history yet",
        detail: "Insights appear once delivery orders have been placed and completed.",
        tone: "neutral" as Tone,
      },
    ];
  }

  const byHour = new Map<number, number>();
  for (const o of orders) {
    const h = new Date(o.created_at).getHours();
    byHour.set(h, (byHour.get(h) ?? 0) + 1);
  }
  const peak = [...byHour.entries()].sort((a, b) => b[1] - a[1])[0];
  if (peak) {
    out.push({
      title: "Peak ordering window",
      detail: `${peak[1]} of ${orders.length} orders were placed around ${peak[0]}:00. Consider rostering additional riders for that window.`,
      tone: "info",
    });
  }

  const awaiting = orders.filter((o) => o.dispatch_status === "awaiting-rider").length;
  if (awaiting > 0) {
    out.push({
      title: "Orders waiting for a rider",
      detail: `${awaiting} order(s) are ready but unassigned. Review rider availability on the dispatch board.`,
      tone: "warning",
    });
  }

  const failed = orders.filter((o) => ["failed", "cancelled", "rejected"].includes(o.order_status)).length;
  const rate = Math.round((failed / orders.length) * 100);
  if (rate >= 10) {
    out.push({
      title: "Elevated failure rate",
      detail: `${rate}% of orders in this period were cancelled, rejected or failed. Review failure reasons before adjusting zones.`,
      tone: "destructive",
    });
  }

  const cod = orders.filter((o) => o.payment_method === "cash").length;
  if (cod > 0) {
    out.push({
      title: "Cash exposure",
      detail: `${cod} order(s) use cash on delivery. Confirm rider remittances are reconciled at shift end.`,
      tone: "neutral",
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Rider eligibility
 *
 * "Available" on its own never means a rider can be given work. A rider is
 * eligible only when every condition below holds at once, and the screens show
 * the failing condition rather than an unexplained count.
 * ------------------------------------------------------------------ */

export type RiderEligibilityInput = {
  active?: boolean | null;
  on_shift?: boolean | null;
  availability_status?: string | null;
  active_load?: number | null;
  max_active?: number | null;
  cash_handling_allowed?: boolean | null;
  branch_id?: string | null;
  /** Staff account behind the rider record; dispatch refuses unlinked riders. */
  profile_id?: string | null;
  /** Roster linkage verdict: linked | unlinked | missing-account | account-inactive | capability-missing. */
  linkage_status?: string | null;
};

export type RiderEligibility = {
  eligible: boolean;
  /** Plain-language reasons the rider cannot take work right now. */
  blockers: string[];
  /** Short chips for the roster line: e.g. ["Available", "Off shift"]. */
  chips: string[];
};

export function riderEligibility(
  rider: RiderEligibilityInput,
  options?: { branchId?: string | null | undefined; cashOrder?: boolean | undefined },
): RiderEligibility {
  const blockers: string[] = [];
  const chips: string[] = [];

  const branchId = options?.branchId ?? null;
  if (branchId && rider.branch_id && rider.branch_id !== branchId) {
    blockers.push("Another property");
    chips.push("Other property");
  }

  if (rider.active === false) {
    blockers.push("Rider account is not active");
    chips.push("Inactive");
  }

  // Dispatch itself refuses a rider record with no working staff account, so the
  // roster must state the same verdict instead of counting them as eligible.
  const linkage = (rider.linkage_status ?? (rider.profile_id ? "linked" : null))?.toLowerCase() ?? null;
  if (linkage && linkage !== "linked") {
    const reason =
      linkage === "unlinked"
        ? "No linked staff account"
        : linkage === "missing-account"
          ? "Staff account is missing"
          : linkage === "account-inactive"
            ? "Staff account is not active"
            : linkage === "capability-missing"
              ? "Staff account has no rider capability"
              : "Staff link is incomplete";
    blockers.push(reason);
    chips.push("Not linked");
  }


  const availability = (rider.availability_status ?? "unknown").toLowerCase();
  chips.push(titleCase(availability));
  if (availability !== "available") {
    blockers.push(`Availability is ${availability.replace(/[-_]/g, " ")}`);
  }

  if (rider.on_shift) {
    chips.push("On shift");
  } else {
    chips.push("Off shift");
    blockers.push("No active shift right now");
  }

  const max = rider.max_active ?? 3;
  const load = rider.active_load ?? 0;
  if (load >= max) blockers.push(`At capacity (${load}/${max})`);

  if (options?.cashOrder && rider.cash_handling_allowed === false) {
    blockers.push("Not cleared to carry cash");
    chips.push("No cash clearance");
  }

  return { eligible: blockers.length === 0, blockers, chips };
}

/* ------------------------------------------------------------------ *
 * Local time entry
 * ------------------------------------------------------------------ */

/**
 * Turn a `datetime-local` value typed by staff into a UTC instant, reading it
 * in the property's own timezone rather than whatever timezone the browser
 * happens to be in. A shift typed as 11:30 in Nairobi is stored as 08:30 UTC
 * even when the laptop is set to London.
 */
export function zonedInputToUtcIso(local: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(local.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as unknown as number[];
  const guess = Date.UTC(y!, mo! - 1, d!, h!, mi!, 0, 0);
  const offset = (at: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(at));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour") % 24,
      get("minute"),
      get("second"),
    );
    return asUtc - at;
  };
  let instant = guess - offset(guess);
  instant = guess - offset(instant);
  const date = new Date(instant);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/* ------------------------------------------------------------------ *
 * Delivery stage — the one calculation every delivery screen reads
 *
 * A delivery's stage is never the raw order_status: that column lags behind
 * the kitchen. The stage combines kitchen readiness (kept in step with the
 * kitchen tickets by the database), rider assignment, pickup confirmation and
 * delivery completion, so the dashboard, the queue and the rider app can never
 * disagree about where an order is.
 * ------------------------------------------------------------------ */

export type DeliveryStageId =
  | "intake"
  | "kitchen"
  | "awaiting-rider"
  | "with-rider"
  | "in-flight"
  | "closed"
  | "cancelled";

export type DeliveryStageInput = {
  order_status?: string | null;
  kitchen_status?: string | null;
  dispatch_status?: string | null;
  payment_status?: string | null;
  rider_id?: string | null;
  collected_at?: string | null;
  delivered_at?: string | null;
};

const CANCELLED_ORDER = ["cancelled", "rejected", "failed", "refunded"];
const CLOSED_ORDER = ["delivered", "closed", "completion-disputed"];
const IN_FLIGHT_ORDER = ["collected", "out-for-delivery"];
const INTAKE_ORDER = ["draft", "pending-payment", "payment-verification"];
/** Kitchen has finished everything it was asked to make. */
const KITCHEN_DONE = ["ready", "completed"];

/** Single source of truth for where a delivery order stands right now. */
export function resolveDeliveryStage(order: DeliveryStageInput): DeliveryStageId {
  const status = String(order.order_status ?? "");
  const dispatch = String(order.dispatch_status ?? "");
  const kitchen = String(order.kitchen_status ?? "");

  if (CANCELLED_ORDER.includes(status) || ["returned", "delivery-failed"].includes(dispatch))
    return "cancelled";
  if (CLOSED_ORDER.includes(status) || dispatch === "delivered" || order.delivered_at) return "closed";
  if (order.collected_at || IN_FLIGHT_ORDER.includes(status) || ["collected", "en-route"].includes(dispatch))
    return "in-flight";
  if (order.rider_id || status === "rider-assigned" || dispatch === "rider-assigned") return "with-rider";
  if (KITCHEN_DONE.includes(kitchen) || status === "ready-for-pickup" || dispatch === "awaiting-rider")
    return "awaiting-rider";
  if (INTAKE_ORDER.includes(status)) return "intake";
  return "kitchen";
}

export const DELIVERY_STAGES: { id: DeliveryStageId; label: string; hint: string; tone: Tone }[] = [
  { id: "intake", label: "Intake", hint: "payment awaiting confirmation", tone: "warning" },
  { id: "kitchen", label: "In kitchen", hint: "kitchen has not finished", tone: "info" },
  { id: "awaiting-rider", label: "Waiting for rider", hint: "kitchen ready, no rider yet", tone: "warning" },
  { id: "with-rider", label: "With rider", hint: "rider assigned, waiting for pickup", tone: "info" },
  { id: "in-flight", label: "In flight", hint: "rider has confirmed pickup", tone: "info" },
  { id: "closed", label: "Delivered & closed", hint: "delivery completed", tone: "success" },
  { id: "cancelled", label: "Cancelled", hint: "cancelled, rejected or failed", tone: "destructive" },
];

export function deliveryStageLabel(id: DeliveryStageId): string {
  return DELIVERY_STAGES.find((s) => s.id === id)?.label ?? "Unknown";
}

/** Count orders per stage using the same rules the lanes use. */
export function countDeliveryStages(orders: DeliveryStageInput[]): Record<DeliveryStageId, number> {
  const counts = Object.fromEntries(DELIVERY_STAGES.map((s) => [s.id, 0])) as Record<
    DeliveryStageId,
    number
  >;
  for (const order of orders) counts[resolveDeliveryStage(order)] += 1;
  return counts;
}
