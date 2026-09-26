/**
 * Room package revenue allocation.
 *
 * A guest pays one combined package price. Internally that price is split across
 * the departments that actually earn it (Rooms, Breakfast, Lunch, Dinner, other
 * components). The split is configuration, never a second guest charge, and the
 * component totals must always equal the package selling price.
 */

export const PACKAGE_TYPES = [
  { value: "room-only", label: "Room Only", components: ["room"] },
  { value: "bed-breakfast", label: "Bed and Breakfast", components: ["room", "breakfast"] },
  { value: "half-board", label: "Half Board", components: ["room", "breakfast", "dinner"] },
  { value: "full-board", label: "Full Board", components: ["room", "breakfast", "lunch", "dinner"] },
  { value: "custom", label: "Custom Package", components: ["room"] },
] as const;

export type PackageType = (typeof PACKAGE_TYPES)[number]["value"];

export const COMPONENT_TYPES = [
  { value: "room", label: "Accommodation", meal: false },
  { value: "breakfast", label: "Breakfast", meal: true },
  { value: "lunch", label: "Lunch", meal: true },
  { value: "dinner", label: "Dinner", meal: true },
  { value: "other", label: "Other component", meal: false },
] as const;

export const OCCUPANCY_TYPES = ["any", "single", "double", "triple", "family"] as const;
export const GUEST_CATEGORIES = ["any", "adult", "child", "extra-guest"] as const;

export const DISCOUNT_RULES = [
  { value: "proportional", label: "Proportionally across all components" },
  { value: "rooms-only", label: "Applied to Rooms only" },
  { value: "meals-only", label: "Applied to Meals only" },
  { value: "manual", label: "Manually allocated (requires approval)" },
] as const;

export const ENTITLEMENT_STATUSES = ["pending", "consumed", "missed", "packed", "replaced", "cancelled"] as const;

export type Row = Record<string, unknown>;

export const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);

export function componentLabel(type: string) {
  return COMPONENT_TYPES.find((c) => c.value === type)?.label ?? type;
}

export function packageTypeLabel(type: string) {
  return PACKAGE_TYPES.find((p) => p.value === type)?.label ?? type;
}

export function isMealComponent(type: string) {
  return COMPONENT_TYPES.find((c) => c.value === type)?.meal ?? false;
}

/** Amount a component contributes to the package price. */
export function componentAmount(component: Row, packagePrice: number) {
  return component["method"] === "percentage"
    ? Math.round(((packagePrice * num(component["percentage"])) / 100) * 100) / 100
    : num(component["amount"]);
}

/** Rule-level balance check used by the UI; the database enforces the same rule on activation. */
export function ruleBalance(rule: Row, components: Row[]) {
  const price = num(rule["package_price"]);
  const allocated = components.reduce((sum, c) => sum + componentAmount(c, price), 0);
  const percentage = components.reduce(
    (sum, c) => sum + (c["method"] === "percentage" ? num(c["percentage"]) : 0),
    0,
  );
  const variance = Math.round((price - allocated) * 100) / 100;
  return {
    price,
    allocated: Math.round(allocated * 100) / 100,
    variance,
    percentage: Math.round(percentage * 1000) / 1000,
    balanced: components.length > 0 && Math.abs(variance) <= 0.01,
  };
}

export function money(value: unknown, _currency = "KES") {
  return num(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function moneyWithCode(value: unknown, currency = "KES") {
  return `${currency} ${money(value)}`;
}

export function titleCase(value: string) {
  return value
    .split(/[-_\s]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

/** Group posted allocations by folio line so package totals can be reconciled. */
export function reconcileByCharge(allocations: Row[]) {
  const map = new Map<string, { line: string; price: number; allocated: number; components: Row[] }>();
  for (const a of allocations) {
    if (a["status"] === "reversed") continue;
    const key = String(a["folio_line_id"] ?? a["id"]);
    const entry = map.get(key) ?? { line: key, price: num(a["package_price"]), allocated: 0, components: [] };
    entry.allocated += num(a["allocated_amount"]);
    entry.components.push(a);
    map.set(key, entry);
  }
  return [...map.values()].map((e) => ({
    ...e,
    allocated: Math.round(e.allocated * 100) / 100,
    variance: Math.round((e.price - e.allocated) * 100) / 100,
    balanced: Math.abs(e.price - e.allocated) <= 0.01,
  }));
}
