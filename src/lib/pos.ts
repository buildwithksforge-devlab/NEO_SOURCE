/**
 * Phase 7 — Restaurant, Bar & POS vocabulary.
 *
 * Every list here mirrors a database CHECK constraint so the UI can never offer
 * a value the server will reject. Status transitions are enforced server-side by
 * `pos_enforce_order_status()` / `pos_enforce_item_status()`; the maps below are
 * only used to decide which buttons to show.
 */

export const ORDER_TYPES = [
  "dine-in",
  "bar",
  "coffee-station",
  "room-service",
  "takeaway",
  "delivery",
  "conference-catering",
  "event-catering",
  "staff-meal",
  "complimentary",
  "house-use",
] as const;

/**
 * Order types a POS operator may raise by hand. Delivery is deliberately
 * absent: a delivery sale needs an address, a zone, a fee, an ETA and a rider,
 * and those live on the delivery order. Raising "delivery" here produced a
 * second, disconnected meaning of the word — the Delivery desk never saw it.
 * Historical delivery orders still read and report normally.
 */
export const MANUAL_ORDER_TYPES = ORDER_TYPES.filter((t) => t !== "delivery");

export const ORDER_SOURCES = [
  "waiter-pos",
  "bar-pos",
  "coffee-pos",
  "reception",
  "room-service",
  "customer-portal",
  "delivery",
  "event-department",
  "other",
] as const;

export const ORDER_STATUSES = [
  "draft",
  "held",
  "confirmed",
  "sent",
  "accepted",
  "in-preparation",
  "partially-ready",
  "ready",
  "partially-served",
  "served",
  "awaiting-payment",
  "paid",
  "charged-to-room",
  "credit",
  "closed",
  "cancelled",
  "void-pending",
  "voided",
] as const;

export const ITEM_STATUSES = [
  "draft",
  "sent",
  "accepted",
  "preparing",
  "ready",
  "served",
  "cancel-pending",
  "cancelled",
  "voided",
] as const;

export const TABLE_STATUSES = [
  "available",
  "reserved",
  "seated",
  "ordering",
  "in-preparation",
  "partially-served",
  "awaiting-payment",
  "needs-cleaning",
  "blocked",
  "out-of-service",
] as const;

export const RESERVATION_STATUSES = [
  "enquiry",
  "tentative",
  "confirmed",
  "seated",
  "completed",
  "cancelled",
  "no-show",
] as const;

export const COURSES = ["drinks", "starters", "main", "dessert", "other"] as const;

export const PAYMENT_METHODS = [
  "cash",
  "mpesa",
  "card",
  "card-terminal",
  "qr",
  "bank-transfer",
  "corporate-credit",
  "room-charge",
  "complimentary",
  "other",
] as const;

export const PAYMENT_STATUSES = [
  "initiated",
  "pending",
  "confirmed",
  "failed",
  "cancelled",
  "reversed",
  "refunded",
] as const;

/**
 * Methods a processor must confirm before any money is treated as received.
 *
 * A card slip keyed in from the bank's own terminal is NOT one of these: that
 * money already moved, and the entry here is the record of it, marked unverified
 * until someone checks it against the slip.
 */
export const EXTERNAL_METHODS: Record<string, string> = {
  mpesa: "M-Pesa (Daraja)",
  "card-terminal": "Integrated card terminal",
  qr: "QR payment provider",
};

export const MENU_AVAILABILITY = [
  "available",
  "temporarily-unavailable",
  "sold-out",
  "disabled",
] as const;

export const TICKET_STATUSES = [
  "new",
  "accepted",
  "preparing",
  "ready",
  "delayed",
  "cancelled",
  "served",
] as const;

export type OrderType = (typeof ORDER_TYPES)[number];
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export function titleCase(value: string | null | undefined) {
  if (!value) return "—";
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function money(amount: number | string | null | undefined, _currency = "KES") {
  const n = Number(amount ?? 0);
  return new Intl.NumberFormat("en-KE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
}

/** Bills, receipts and printed documents keep the currency code. */
export function moneyWithCode(amount: number | string | null | undefined, currency = "KES") {
  return `${currency} ${money(amount)}`;
}

export function orderStatusTone(
  status: string,
): "default" | "success" | "warning" | "info" | "destructive" {
  if (["paid", "closed", "charged-to-room", "served"].includes(status)) return "success";
  if (["ready", "partially-ready", "partially-served"].includes(status)) return "info";
  if (["awaiting-payment", "void-pending", "held", "credit"].includes(status)) return "warning";
  if (["cancelled", "voided"].includes(status)) return "destructive";
  return "default";
}

export function itemStatusTone(
  status: string,
): "default" | "success" | "warning" | "info" | "destructive" {
  if (status === "served") return "success";
  if (status === "ready") return "info";
  if (["preparing", "accepted", "cancel-pending"].includes(status)) return "warning";
  if (["cancelled", "voided"].includes(status)) return "destructive";
  return "default";
}

export function tableStatusTone(
  status: string,
): "default" | "success" | "warning" | "info" | "destructive" {
  if (status === "available") return "success";
  if (["seated", "ordering", "in-preparation"].includes(status)) return "info";
  if (["awaiting-payment", "reserved", "needs-cleaning", "partially-served"].includes(status))
    return "warning";
  if (["blocked", "out-of-service"].includes(status)) return "destructive";
  return "default";
}

/**
 * Exact mirror of the server rulebook `public.neo_pos_status_rules()`, which
 * `pos_enforce_order_status()` reads. The database remains authoritative; this
 * copy exists so the UI can explain a rejected transition instead of failing
 * silently. `pos-send-idempotency.test.ts` asserts the two stay identical.
 */
export const ORDER_TRANSITIONS: Record<string, string[]> = {
  draft: ["held", "confirmed", "sent", "cancelled"],
  held: ["draft", "confirmed", "cancelled"],
  confirmed: ["sent", "cancelled"],
  sent: [
    "accepted",
    "in-preparation",
    "partially-ready",
    "ready",
    "awaiting-payment",
    "cancelled",
    "void-pending",
  ],
  accepted: ["in-preparation", "partially-ready", "ready", "awaiting-payment", "void-pending"],
  "in-preparation": ["partially-ready", "ready", "awaiting-payment", "void-pending"],
  "partially-ready": ["ready", "partially-served", "awaiting-payment", "void-pending"],
  ready: ["partially-served", "served", "awaiting-payment", "void-pending"],
  "partially-served": ["served", "awaiting-payment", "void-pending"],
  served: ["awaiting-payment", "void-pending"],
  "awaiting-payment": ["paid", "charged-to-room", "credit", "void-pending"],
  paid: ["closed", "void-pending"],
  "charged-to-room": ["closed", "void-pending"],
  credit: ["closed", "void-pending"],
  closed: ["awaiting-payment"],
  "void-pending": ["voided", "served", "awaiting-payment"],
};

/** The one canonical production-send state; `Send` never requires settlement. */
export const PRODUCTION_SEND_STATUS = "sent" as const;

export function allowedTransitions(status: string | null | undefined) {
  return ORDER_TRANSITIONS[status ?? ""] ?? [];
}

/** Human explanation of a rejected transition, including the allowed graph. */
export function describeTransitionFailure(from: string | null | undefined, to: string) {
  const allowed = allowedTransitions(from);
  return `“${titleCase(from)}” cannot become “${titleCase(to)}”. Allowed from ${titleCase(from)}: ${
    allowed.length ? allowed.map(titleCase).join(", ") : "none"
  }.`;
}

export const ITEM_TRANSITIONS: Record<string, string[]> = {
  draft: ["sent", "cancelled"],
  sent: ["accepted", "preparing", "ready"],
  accepted: ["preparing", "ready"],
  preparing: ["ready"],
  ready: ["served"],
};

export type PosSettings = {
  defaultOrderType: string;
  serviceChargePercent: number;
  defaultTaxPercent: number;
  billRounding: "none" | "nearest-1" | "nearest-5";
  receiptFooter: string;
  reservationDurationMinutes: number;
  prepTargetMinutes: number;
  delayThresholdMinutes: number;
  roomChargeVerification: "room-and-name" | "signature" | "pin";
  enforceShift: boolean;
  inventoryDeductionEvent: "finalised-sale" | "sent-to-station" | "disabled";
  openTabCreditLimit: number;
  offlinePolicy: "block-financial" | "warn-only";
};

export const DEFAULT_POS_SETTINGS: PosSettings = {
  defaultOrderType: "dine-in",
  serviceChargePercent: 10,
  defaultTaxPercent: 16,
  billRounding: "none",
  receiptFooter: "Thank you for dining with us.",
  reservationDurationMinutes: 120,
  prepTargetMinutes: 15,
  delayThresholdMinutes: 25,
  roomChargeVerification: "room-and-name",
  enforceShift: true,
  inventoryDeductionEvent: "finalised-sale",
  openTabCreditLimit: 0,
  offlinePolicy: "block-financial",
};

/** Minutes elapsed since an ISO timestamp. */
export function minutesSince(iso: string | null | undefined) {
  if (!iso) return 0;
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

export function delayTone(elapsed: number, target: number) {
  if (elapsed >= target * 1.5) return "destructive" as const;
  if (elapsed >= target) return "warning" as const;
  if (elapsed >= target * 0.7) return "info" as const;
  return "success" as const;
}

export function delayLabel(elapsed: number, target: number) {
  if (elapsed >= target * 1.5) return "Critical";
  if (elapsed >= target) return "Delayed";
  if (elapsed >= target * 0.7) return "Approaching";
  return "Within target";
}

/** Order numbers are unique per organization (DB constraint) — generated client-side. */
export function generateOrderNumber() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `POS-${stamp}-${rand}`;
}

export function lineTotal(quantity: number, unitPrice: number, modifierTotal = 0, discount = 0) {
  return Math.max(0, quantity * (unitPrice + modifierTotal) - discount);
}
