/**
 * Phase 5 — Front Office & Property Management System.
 *
 * Vocabulary shared by every PMS screen. The database owns the data; this module
 * owns the labels, tones and small pure helpers so screens stay presentational.
 * Nothing here invents reservations, rooms or money — empty means empty.
 */
import { PAYMENT_METHOD_CATALOGUE, type PaymentMethodDefinition } from "@/lib/payment-methods";
import { addCalendarDays, calendarNights, propertyToday } from "@/lib/availability-search";


export const ROOM_CONDITIONS = [
  "vacant-clean",
  "vacant-dirty",
  "occupied-clean",
  "occupied-dirty",
  "reserved",
  "inspected",
  "out-of-order",
  "out-of-service",
  "maintenance",
  "blocked",
] as const;
export type RoomCondition = (typeof ROOM_CONDITIONS)[number];

/** Authoritative housekeeping axis — same vocabulary as Housekeeping. */
export const HOUSEKEEPING_STATUSES = [
  "dirty",
  "cleaning-queued",
  "in-progress",
  "awaiting-inspection",
  "rework",
  "clean",
  "inspected",
] as const;
/** Authoritative maintenance axis — same vocabulary as Maintenance. */
export const MAINTENANCE_STATUSES = ["operational", "under-maintenance", "out-of-service", "out-of-order"] as const;
export const OCCUPANCY_STATUSES = ["vacant", "occupied", "house-use"] as const;

export const RESERVATION_STATUSES = [
  "enquiry",
  "on-hold",
  "waitlisted",
  "tentative",
  "pending-deposit",
  "confirmed",
  "guaranteed",
  "checked-in",
  "checked-out",
  "cancelled",
  "no-show",
  "closed",
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const BOOKING_SOURCES = [
  "direct",
  "walk-in",
  "telephone",
  "email",
  "website",
  "booking.com",
  "expedia",
  "travel-agent",
  "tour-operator",
  "corporate",
  "group",
  "other",
] as const;

export const RESERVATION_TYPES = [
  "individual",
  "multi-room",
  "group",
  "corporate",
  "long-stay",
  "day-use",
  "complimentary",
  "house-use",
  "waitlist",
] as const;

export const GUARANTEE_METHODS = ["none", "deposit", "credit-card", "corporate-credit", "voucher", "company-lpo"] as const;

/**
 * Folio payment methods, derived from the one canonical catalogue.
 *
 * Recorded tenders (cash, card, bank transfer, corporate credit, voucher, OTA)
 * are always available — the money is taken outside NEØ and recorded here.
 * M-Pesa is the only provider-initiated method, and its availability comes from
 * the workspace's saved configuration at runtime, never from a constant.
 */
export const PAYMENT_METHODS: PaymentMethodDefinition[] = [
  "cash",
  "corporate-credit",
  "card",
  "bank-transfer",
  "voucher",
  "ota-prepaid",
  "mpesa",
].flatMap((value) => PAYMENT_METHOD_CATALOGUE.filter((m) => m.value === value));



export const FOLIO_STATUSES = ["draft", "open", "under-review", "settled", "closed", "reopened", "voided"] as const;

export const FOLIO_CATEGORIES = [
  "accommodation",
  "restaurant",
  "coffee-station",
  "bar",
  "room-service",
  "laundry",
  "excursion",
  "transfer",
  "event",
  "miscellaneous",
] as const;

export const GUEST_REQUEST_CATEGORIES = [
  "housekeeping",
  "maintenance",
  "extra-bed",
  "baby-cot",
  "laundry",
  "room-service",
  "transport",
  "excursion",
  "wake-up-call",
  "accessibility",
  "other",
] as const;

export const GUEST_REQUEST_STATUSES = ["new", "assigned", "in-progress", "waiting", "completed", "cancelled"] as const;

export const WAITLIST_STATUSES = [
  "waiting",
  "availability-found",
  "contacted",
  "converted",
  "declined",
  "expired",
  "cancelled",
] as const;

export const OTA_CHANNELS = [
  { channel: "booking.com", name: "Booking.com" },
  { channel: "expedia", name: "Expedia" },
  { channel: "agoda", name: "Agoda" },
  { channel: "airbnb", name: "Airbnb" },
  { channel: "channel-manager", name: "Channel manager" },
] as const;

export const MEAL_PLAN_SEEDS = [
  { code: "RO", name: "Room Only", includes: [] as string[] },
  { code: "BB", name: "Bed and Breakfast", includes: ["Breakfast"] },
  { code: "HB", name: "Half Board", includes: ["Breakfast", "Dinner"] },
  { code: "FB", name: "Full Board", includes: ["Breakfast", "Lunch", "Dinner"] },
];

export type Tone = "default" | "success" | "warning" | "info" | "destructive";

export function titleCase(value: string | null | undefined) {
  if (!value) return "—";
  return value
    .split(/[-_.]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

export function roomConditionTone(condition: string): Tone {
  switch (condition) {
    case "vacant-clean":
    case "inspected":
      return "success";
    case "occupied-clean":
    case "occupied-dirty":
      return "info";
    case "vacant-dirty":
      return "warning";
    case "out-of-order":
    case "out-of-service":
    case "maintenance":
    case "blocked":
      return "destructive";
    default:
      return "default";
  }
}

export function reservationStatusTone(status: string): Tone {
  switch (status) {
    case "confirmed":
    case "guaranteed":
    case "checked-in":
      return "success";
    case "tentative":
    case "pending-deposit":
    case "on-hold":
    case "waitlisted":
      return "warning";
    case "cancelled":
    case "no-show":
      return "destructive";
    case "checked-out":
    case "closed":
      return "info";
    default:
      return "default";
  }
}

export function folioStatusTone(status: string): Tone {
  switch (status) {
    case "open":
      return "info";
    case "settled":
    case "closed":
      return "success";
    case "under-review":
    case "reopened":
      return "warning";
    case "voided":
      return "destructive";
    default:
      return "default";
  }
}

export function money(amount: number | string | null | undefined, _currency = "KES") {
  const value = typeof amount === "string" ? Number(amount) : (amount ?? 0);
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-KE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** Folios, invoices and guest documents keep the currency code. */
export function moneyWithCode(amount: number | string | null | undefined, currency = "KES") {
  const rendered = money(amount);
  return rendered === "—" ? rendered : `${currency} ${rendered}`;
}

export function nightsBetween(arrival: string, departure: string) {
  return Math.max(0, calendarNights(arrival, departure));
}

export function today() {
  return propertyToday();
}

export function addDays(date: string, days: number) {
  return addCalendarDays(date, days);
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const d = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Confirmation numbers are generated client-side then uniquely constrained per organisation. */
export function generateConfirmationNumber() {
  const stamp = new Date();
  const y = stamp.getFullYear().toString().slice(2);
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `RES-${y}${(stamp.getMonth() + 1).toString().padStart(2, "0")}-${rand}`;
}

/** PMS permission helper — every screen gates on `can("pms", action)`. */
export const PMS = {
  dashboard: "dashboard.view",
  reservationsView: "reservations.view",
  reservationsCreate: "reservations.create",
  reservationsEdit: "reservations.edit",
  reservationsCancel: "reservations.cancel",
  reservationsNoShow: "reservations.mark_no_show",
  roomsView: "rooms.view",
  roomsAssign: "rooms.assign",
  roomsTransfer: "rooms.transfer",
  roomsBlock: "rooms.block",
  checkIn: "checkin.perform",
  checkOut: "checkout.perform",
  foliosView: "folios.view",
  postCharge: "folios.post_charge",
  paymentsRecord: "payments.record",
  refundsRequest: "refunds.request",
  groups: "groups.manage",
  corporate: "corporate.manage",
  ota: "ota.view",
  reports: "reports.view",
  reportsExport: "reports.export",
  settings: "settings.manage",
} as const;

export const DEFAULT_PMS_SETTINGS = {
  checkInTime: "14:00",
  checkOutTime: "10:00",
  operationalDayBoundary: "03:00",
  defaultReservationStatus: "tentative",
  defaultRoomCondition: "vacant-clean",
  defaultMealPlan: "BB",
  holdMinutes: 30,
  depositPercent: 30,
  requireDepositToConfirm: true,
  cancellationHours: 48,
  noShowChargeNights: 1,
  earlyCheckInFee: 0,
  lateCheckOutFee: 0,
  allowOverbooking: false,
  overbookingLimit: 0,
  readyPolicy: "inspected",
  nightlyPostingTime: "23:30",
  roomChargeLimit: 0,
  registrationTerms: "",
  identityRequired: true,
};

export type PmsSettings = typeof DEFAULT_PMS_SETTINGS;
