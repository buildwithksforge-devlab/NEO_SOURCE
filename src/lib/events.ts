/**
 * Phase 10 — Events, Conferences & Banqueting vocabulary and pure helpers.
 *
 * Nothing here talks to the network; the data layer lives in `events-data.ts`.
 * Statuses mirror the database CHECK constraints exactly.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export type Tone = "success" | "warning" | "destructive" | "info" | "default";

export const ENQUIRY_STATUSES = [
  "new",
  "contacted",
  "qualified",
  "site-visit-scheduled",
  "quotation-in-preparation",
  "quotation-sent",
  "negotiation",
  "awaiting-client",
  "converted",
  "lost",
  "cancelled",
  "archived",
] as const;

export const QUOTATION_STATUSES = [
  "draft",
  "pending-approval",
  "approved",
  "sent",
  "viewed",
  "accepted",
  "rejected",
  "revision-requested",
  "expired",
  "cancelled",
  "converted",
] as const;

export const BOOKING_STATUSES = [
  "provisional-hold",
  "awaiting-deposit",
  "awaiting-credit-approval",
  "confirmed",
  "in-planning",
  "ready",
  "in-progress",
  "completed",
  "cancelled",
  "postponed",
  "closed",
] as const;

export const PAYMENT_STATUSES = [
  "unpaid",
  "partially-paid",
  "paid",
  "overpaid",
  "refunded",
  "on-credit",
  "disputed",
] as const;

export const READINESS_STATES = [
  "not-started",
  "in-progress",
  "at-risk",
  "blocked",
  "ready",
  "completed",
] as const;

export const BEO_STATUSES = [
  "draft",
  "department-review",
  "pending-approval",
  "approved",
  "published",
  "superseded",
  "cancelled",
] as const;

export const SITE_VISIT_STATUSES = [
  "scheduled",
  "confirmed",
  "completed",
  "rescheduled",
  "cancelled",
  "no-show",
] as const;

export const LEAD_SOURCES = [
  "website",
  "guest-portal",
  "telephone",
  "whatsapp",
  "email",
  "walk-in",
  "corporate",
  "referral",
  "social-media",
  "returning-customer",
  "other",
] as const;

export const SERVICE_STYLES = [
  "buffet",
  "plated",
  "cocktail",
  "family-style",
  "tea-break",
  "packed-meal",
  "high-table",
  "children",
  "custom",
] as const;

export const SEATING_LAYOUTS = [
  "theatre",
  "classroom",
  "boardroom",
  "u-shape",
  "cabaret",
  "banquet",
  "cocktail",
  "custom",
] as const;

export const QUOTATION_CATEGORIES = [
  "food",
  "beverage",
  "venue",
  "hall-hire",
  "ground-hire",
  "decor",
  "tent",
  "furniture",
  "entertainment",
  "equipment",
  "accommodation",
  "excursion",
  "transport",
  "security",
  "photography",
  "staff",
  "other",
] as const;

export const RESOURCE_CATEGORIES = [
  "audio-visual",
  "furniture",
  "tents",
  "linen",
  "serving",
  "decor",
  "power",
  "lighting",
  "other",
] as const;

export const DEPARTMENT_KEYS = [
  "kitchen",
  "restaurant",
  "housekeeping",
  "front-office",
  "stores",
  "procurement",
  "finance",
  "marketing",
  "maintenance",
  "security",
] as const;

/** The information each department is allowed to see on an event. */
export const DEPARTMENT_SCOPES: Record<string, { label: string; sees: string[]; financial: boolean }> = {
  kitchen: {
    label: "Kitchen",
    financial: false,
    sees: ["Event reference & date", "Serving times", "Guest count", "Approved menu & portions", "Dietary & allergy warnings", "Production tasks", "Ingredient requirements"],
  },
  restaurant: {
    label: "Restaurant & Banqueting",
    financial: false,
    sees: ["Function schedule", "Guest count", "Service style", "Menu & beverage plan", "Seating & table setup", "Waitstaff assignments", "Special guest requirements"],
  },
  housekeeping: {
    label: "Housekeeping",
    financial: false,
    sees: ["Venue preparation tasks", "Cleaning schedule", "Washroom & linen requirements", "Guest-room requirements", "Setup & breakdown times"],
  },
  "front-office": {
    label: "Front Office",
    financial: false,
    sees: ["Accommodation requirements", "Group reservations & rooming list", "VIP arrivals", "Check-in / check-out dates", "Registration desk requirements"],
  },
  stores: {
    label: "Inventory & Stores",
    financial: false,
    sees: ["Reserved stock", "Event stock requests", "Stock availability", "Issues & returns", "Required issue dates"],
  },
  procurement: {
    label: "Procurement",
    financial: false,
    sees: ["Approved purchase requirements", "Required dates", "Approved quantities", "Supplier requirements"],
  },
  finance: {
    label: "Finance",
    financial: true,
    sees: ["Quotations & invoices", "Deposits & receipts", "Discounts & taxes", "Credit approvals", "Outstanding balances", "Event profitability"],
  },
  marketing: {
    label: "Marketing",
    financial: false,
    sees: ["Event type", "Approved photography schedule", "Branding requirements", "Testimonial request", "Client consent status"],
  },
  maintenance: {
    label: "Maintenance",
    financial: false,
    sees: ["Power & generator requirements", "Lighting", "Sound & electrical setup", "Equipment setup", "Setup & breakdown deadlines"],
  },
  security: {
    label: "Security",
    financial: false,
    sees: ["Guest estimates", "VIP requirements", "Parking & access control", "Security tasks", "Event times"],
  },
};

export const MILESTONE_LIBRARY = [
  "enquiry-received",
  "initial-contact",
  "site-visit",
  "quotation-prepared",
  "quotation-approved",
  "quotation-sent",
  "quotation-accepted",
  "deposit-due",
  "deposit-received",
  "credit-approved",
  "booking-confirmed",
  "menu-selected",
  "guest-count-confirmed",
  "beo-issued",
  "department-acknowledgment",
  "final-payment-due",
  "setup-started",
  "event-started",
  "event-completed",
  "breakdown-completed",
  "final-invoice-issued",
  "feedback-requested",
  "feedback-received",
  "event-closed",
] as const;

export function titleCase(value: string): string {
  if (!value) return "";
  return value
    .split(/[-_\s]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function formatMoney(symbol: string, value: unknown): string {
  return `${symbol} ${num(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatDate(value: unknown): string {
  if (!value) return "—";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

export function formatDateTime(value: unknown): string {
  if (!value) return "—";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return "—";
  return `${formatDate(value)} · ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

export function enquiryTone(status: string): Tone {
  if (status === "converted") return "success";
  if (status === "lost" || status === "cancelled") return "destructive";
  if (status === "new" || status === "contacted") return "info";
  if (status === "archived") return "default";
  return "warning";
}

export function quotationTone(status: string): Tone {
  if (status === "accepted" || status === "converted" || status === "approved") return "success";
  if (status === "rejected" || status === "cancelled" || status === "expired") return "destructive";
  if (status === "draft") return "default";
  return "info";
}

export function bookingTone(status: string): Tone {
  if (["confirmed", "ready", "completed", "closed"].includes(status)) return "success";
  if (["cancelled", "postponed"].includes(status)) return "destructive";
  if (["provisional-hold", "awaiting-deposit", "awaiting-credit-approval"].includes(status)) return "warning";
  return "info";
}

export function paymentTone(status: string): Tone {
  if (status === "paid") return "success";
  if (status === "unpaid" || status === "disputed") return "destructive";
  if (status === "refunded" || status === "overpaid") return "info";
  return "warning";
}

export function readinessTone(state: string): Tone {
  if (state === "ready" || state === "completed") return "success";
  if (state === "blocked") return "destructive";
  if (state === "at-risk") return "warning";
  if (state === "in-progress") return "info";
  return "default";
}

export function beoTone(status: string): Tone {
  if (status === "published" || status === "approved") return "success";
  if (status === "cancelled") return "destructive";
  if (status === "superseded") return "default";
  return "info";
}

export type QuoteLine = {
  quantity: number;
  unit_price: number;
  taxable?: boolean;
};

export type QuoteTotals = {
  subtotal: number;
  discount: number;
  serviceCharge: number;
  tax: number;
  grandTotal: number;
  deposit: number;
  balance: number;
};

/** Single source of truth for quotation arithmetic (also used for previews). */
export function quoteTotals(
  lines: QuoteLine[],
  opts: { discount?: number; serviceChargeRate?: number; taxRate?: number; depositPercent?: number },
): QuoteTotals {
  const subtotal = lines.reduce((sum, l) => sum + num(l.quantity) * num(l.unit_price), 0);
  const taxableBase = lines
    .filter((l) => l.taxable !== false)
    .reduce((sum, l) => sum + num(l.quantity) * num(l.unit_price), 0);
  const discount = Math.min(num(opts.discount), subtotal);
  const ratio = subtotal > 0 ? (subtotal - discount) / subtotal : 0;
  const serviceCharge = ((subtotal - discount) * num(opts.serviceChargeRate)) / 100;
  const tax = ((taxableBase * ratio + serviceCharge) * num(opts.taxRate)) / 100;
  const grandTotal = subtotal - discount + serviceCharge + tax;
  const deposit = (grandTotal * num(opts.depositPercent)) / 100;
  return {
    subtotal: round2(subtotal),
    discount: round2(discount),
    serviceCharge: round2(serviceCharge),
    tax: round2(tax),
    grandTotal: round2(grandTotal),
    deposit: round2(deposit),
    balance: round2(grandTotal - deposit),
  };
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function readinessPercent(row: Row): number {
  const total = num(row["total"]);
  if (total === 0) return 0;
  return Math.round((num(row["ready"]) / total) * 100);
}

/** Overall readiness label for a department rollup row. */
export function rollupState(row: Row): string {
  if (num(row["blocked"]) > 0) return "blocked";
  if (num(row["total"]) > 0 && num(row["ready"]) === num(row["total"])) return "ready";
  if (num(row["at_risk"]) > 0) return "at-risk";
  if (num(row["in_progress"]) > 0) return "in-progress";
  return "not-started";
}

/** Advisory-only AI heuristics computed from real event rows — never a provider call. */
export function advisoryInsights(bookings: Row[], symbol: string): { title: string; detail: string }[] {
  const out: { title: string; detail: string }[] = [];
  const upcoming = bookings.filter((b) => new Date(String(b["event_date"])) >= new Date());

  for (const b of upcoming.slice(0, 4)) {
    const guests = num(b["final_guests"]) || num(b["guaranteed_guests"]) || num(b["expected_guests"]);
    if (guests > 0) {
      out.push({
        title: `${b["event_reference"]} — staffing and beverage guidance`,
        detail: `${guests} guests expected on ${formatDate(b["event_date"])}. A ${b["service_style"]} service at this size typically needs about ${Math.max(2, Math.ceil(guests / 25))} service staff and roughly ${Math.ceil(guests * 1.5)} bottles of water. Advisory only — confirm with the coordinator.`,
      });
    }
    const outstanding = num(b["total_amount"]) - num(b["paid_amount"]);
    if (outstanding > 0 && b["status"] !== "cancelled") {
      out.push({
        title: `${b["event_reference"]} — outstanding balance`,
        detail: `${formatMoney(symbol, outstanding)} remains unpaid before ${formatDate(b["event_date"])}. Advisory only — Finance must confirm before any action.`,
      });
    }
  }

  if (out.length === 0) {
    out.push({
      title: "No advisory signals yet",
      detail: "Recommendations appear once events with guest counts and balances exist. AI never confirms bookings, approves discounts or moves stock.",
    });
  }
  return out.slice(0, 6);
}
