/**
 * Phase 9 — Inventory, Stores & Procurement vocabulary.
 *
 * Stock is always stored in an item's base unit. Purchase, recipe and count
 * units are converted by the database (`inventory_convert`), so every screen
 * here only ever displays what the ledger already holds.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Row = Record<string, any>;

export const STOCK_CATEGORY_KINDS = [
  { key: "food", label: "Food" },
  { key: "beverage", label: "Beverage" },
  { key: "alcohol", label: "Alcohol" },
  { key: "cleaning", label: "Cleaning & chemicals" },
  { key: "linen", label: "Linen & laundry" },
  { key: "amenities", label: "Guest amenities" },
  { key: "packaging", label: "Packaging" },
  { key: "maintenance", label: "Maintenance & spares" },
  { key: "stationery", label: "Stationery" },
  { key: "other", label: "Other" },
] as const;

export const LOCATION_TYPES = [
  { key: "store", label: "Main store" },
  { key: "kitchen", label: "Kitchen store" },
  { key: "bar", label: "Bar store" },
  { key: "housekeeping", label: "Housekeeping store" },
  { key: "maintenance", label: "Maintenance store" },
  { key: "cold-room", label: "Cold room" },
  { key: "dry-store", label: "Dry store" },
  { key: "outlet", label: "Outlet / section" },
] as const;

export const UNITS = [
  "kg",
  "g",
  "l",
  "ml",
  "pc",
  "portion",
  "bottle",
  "pack",
  "crate",
  "box",
  "bag",
  "roll",
  "cup",
  "tbsp",
  "tsp",
] as const;

export const MOVEMENT_TYPES = [
  "opening",
  "receipt",
  "issue",
  "transfer-in",
  "transfer-out",
  "consumption",
  "adjustment",
  "stock-take",
  "damage",
  "expiry",
  "waste",
  "return",
] as const;

export const ADJUSTMENT_REASONS = [
  { key: "damaged", label: "Damaged" },
  { key: "expired", label: "Expired" },
  { key: "spoilage", label: "Spoilage" },
  { key: "theft", label: "Theft / loss" },
  { key: "data-correction", label: "Data correction" },
  { key: "opening-balance", label: "Opening balance" },
] as const;

export const REQUEST_STATUSES = [
  "draft",
  "submitted",
  "pending-approval",
  "approved",
  "rejected",
  "ordered",
  "closed",
] as const;

export const ORDER_STATUSES = [
  "draft",
  "pending-approval",
  "approved",
  "pending-delivery",
  "sent",
  "partially-received",
  "received",
  "cancelled",
] as const;

export const STOCK_TAKE_TYPES = [
  { key: "scheduled", label: "Scheduled full count" },
  { key: "spot", label: "Spot check" },
  { key: "cycle", label: "Cycle count" },
  { key: "shift", label: "Shift close count" },
] as const;

export function titleCase(value: string): string {
  return value
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function formatQuantity(value: unknown, unit?: unknown): string {
  const n = num(value);
  const rounded = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
  return `${rounded.toLocaleString()}${unit ? ` ${String(unit)}` : ""}`;
}

export function formatMoney(value: unknown, symbol = ""): string {
  const n = num(value);
  return `${symbol}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export type StockHealth = "out" | "critical" | "low" | "healthy" | "over";

export function stockHealth(onHand: number, min: number, max?: number | null): StockHealth {
  if (onHand <= 0) return "out";
  if (min > 0 && onHand <= min * 0.5) return "critical";
  if (min > 0 && onHand <= min) return "low";
  if (max && max > 0 && onHand > max) return "over";
  return "healthy";
}

export function healthTone(health: StockHealth): "default" | "success" | "warning" | "info" | "destructive" {
  switch (health) {
    case "out":
    case "critical":
      return "destructive";
    case "low":
      return "warning";
    case "over":
      return "info";
    default:
      return "success";
  }
}

export function healthLabel(health: StockHealth): string {
  return { out: "Out of stock", critical: "Critical", low: "Below minimum", healthy: "Healthy", over: "Overstocked" }[health];
}

export function statusTone(status: string): "default" | "success" | "warning" | "info" | "destructive" {
  const s = status.toLowerCase();
  if (["approved", "received", "posted", "closed", "completed", "matched"].includes(s)) return "success";
  if (["pending", "pending-approval", "pending-delivery", "submitted", "partially-received", "open", "draft"].includes(s)) return "warning";
  if (["rejected", "cancelled", "disputed"].includes(s)) return "destructive";
  if (["sent", "ordered", "received-partial"].includes(s)) return "info";
  return "default";
}

/** Days until a batch expires; negative when already expired. */
export function daysUntil(date: unknown): number | null {
  if (!date) return null;
  const t = new Date(String(date)).getTime();
  if (Number.isNaN(t)) return null;
  return Math.round((t - Date.now()) / 86_400_000);
}

export function nextDocNumber(prefix: string, existing: number): string {
  return `${prefix}-${String(existing + 1).padStart(5, "0")}`;
}
