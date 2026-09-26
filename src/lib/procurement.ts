/**
 * Procurement trail vocabulary.
 *
 * The trail is requisition → approval → RFQ → quotations → selection → LPO →
 * GRN/GRM → supplier invoice → payment → reconciliation → closure. Nothing in
 * that chain is ever deleted; corrections are cancellations, voids, returns,
 * credit notes or revised versions, all of which require a recorded reason.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Row = Record<string, any>;

export const LPO_STATUSES = [
  "draft",
  "pending-approval",
  "rejected",
  "approved",
  "pending-delivery",
  "sent",
  "partially-received",
  "fully-received",
  "partially-invoiced",
  "fully-invoiced",
  "partially-paid",
  "paid",
  "closed",
  "cancelled",
  "voided",
] as const;

export type LpoStatus = (typeof LPO_STATUSES)[number];

export const LPO_ACTIONS = [
  { key: "check", label: "Mark checked", needsReason: true, destructive: false },
  { key: "approve", label: "Approve", needsReason: true, destructive: false },
  { key: "send", label: "Send to supplier", needsReason: true, destructive: false },
  { key: "close", label: "Close outstanding", needsReason: true, destructive: false },
  { key: "cancel", label: "Cancel", needsReason: true, destructive: true },
  { key: "void", label: "Void", needsReason: true, destructive: true },
] as const;

export const DISCREPANCY_LABELS: Record<string, string> = {
  "duplicate-invoice": "Duplicate invoice",
  "no-purchase-order": "No purchase order",
  "unordered-item": "Item not ordered",
  "quantity-invoiced-over-received": "Invoiced more than accepted",
  "outstanding-delivery": "Outstanding delivery",
  "price-variance": "Price variance",
};

export const PRICING_TYPES = [
  { key: "normal", label: "Normal selling price" },
  { key: "promotional", label: "Promotional price" },
  { key: "negotiated", label: "Negotiated client price" },
  { key: "corporate", label: "Corporate contract price" },
  { key: "staff", label: "Staff price" },
  { key: "client-at-cost", label: "Client at cost" },
  { key: "staff-at-cost", label: "Staff at cost" },
  { key: "complimentary", label: "Management complimentary" },
] as const;

export const COMPLIMENTARY_CATEGORIES = [
  "room",
  "meal",
  "drink",
  "dessert",
  "conference-meal",
  "event-item",
  "venue-service",
  "other-service",
] as const;

export const BENEFICIARY_TYPES = ["guest", "corporate", "staff", "vendor", "management", "other"] as const;

export function titleCase(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function money(value: unknown, symbol = ""): string {
  return `${symbol}${num(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function lpoStatusTone(status: string): "default" | "success" | "warning" | "info" | "destructive" {
  const s = (status || "").toLowerCase();
  if (["approved", "fully-received", "fully-invoiced", "paid", "closed", "matched"].includes(s)) return "success";
  if (["cancelled", "voided", "rejected", "held"].includes(s)) return "destructive";
  if (["partially-received", "partially-invoiced", "partially-paid", "pending-approval", "pending-delivery", "review"].includes(s)) return "warning";
  if (["sent", "draft"].includes(s)) return "info";
  return "default";
}

/** Outstanding = ordered − accepted − cancelled. Never negative. */
export function outstandingQuantity(line: Row): number {
  return Math.max(num(line["quantity"]) - num(line["accepted_quantity"]) - num(line["cancelled_quantity"]), 0);
}

export function lineIsOutstanding(line: Row): boolean {
  return outstandingQuantity(line) > 0.0001;
}

const ORIGIN_LABELS: Record<string, string> = {
  reorder: "Reorder alert",
  shortage: "Store shortage",
  requisition: "Store requisition",
  department: "Department request",
  manual: "Direct request",
  direct: "Direct request",
};

/**
 * Human wording for where a requisition came from. The stored reference keeps
 * technical keys such as `reorder:<branch>:<item>`; nobody should have to read
 * an identifier on screen, so we name the origin, the store and the item.
 */
export function describeRequestOrigin(request: Row): string {
  const source = String(request["source"] ?? "").toLowerCase();
  const reference = String(request["source_reference"] ?? "");
  const prefix = (reference.split(":")[0] ?? "").toLowerCase();
  const base =
    ORIGIN_LABELS[source] ?? ORIGIN_LABELS[prefix] ?? (source ? titleCase(source) : "Direct request");

  const parts: string[] = [base];
  const branch = (request["branches"] as Row | null)?.["name"];
  const department = (request["departments"] as Row | null)?.["name"];
  if (branch) parts.push(String(branch));
  else if (department) parts.push(String(department));

  const lines = Array.isArray(request["purchase_request_lines"])
    ? (request["purchase_request_lines"] as Row[])
    : [];
  const first = lines[0];
  const itemName = first
    ? ((first["stock_items"] as Row | null)?.["name"] ?? first["description"] ?? null)
    : null;
  if (itemName) {
    parts.push(lines.length > 1 ? `${String(itemName)} +${lines.length - 1} more` : String(itemName));
  }
  return parts.join(" · ");
}

/** The value a special-price order gives away, kept visible for reporting. */
export function complimentaryValue(row: Row): number {
  return Math.max(num(row["normal_selling_price"]) * num(row["quantity"], 1) - num(row["amount_charged"]), 0);
}

export function formatDateTime(value: unknown): string {
  if (!value) return "—";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 16).replace("T", " ");
}
