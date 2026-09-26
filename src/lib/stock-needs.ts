/**
 * Department stock needs — one status vocabulary.
 *
 * A need is *reported* by a department, *acknowledged* by whoever reviews it,
 * and leaves the queue only once it is *requisitioned* (or declined). Screens
 * had been asking for the literal status `pending`, which no record ever
 * carries, so every open-needs summary answered zero and a kitchen need could
 * never be turned into a requisition. Callers now ask for a queue — "open" —
 * and this module decides which persisted statuses that means.
 */

/** Statuses that still require someone to act. */
export const OPEN_STOCK_NEED_STATUSES = ["reported", "acknowledged", "pending"] as const;

/** Statuses that have left the queue. */
export const CLOSED_STOCK_NEED_STATUSES = ["requisitioned", "declined", "fulfilled"] as const;

/**
 * Read older shortage records safely.
 *
 * Needs reported before the lifecycle fields existed carry no urgency, origin,
 * issued quantity or catalogue link. Normalising on read keeps the original
 * department, description, quantity, unit, reporter and property intact while
 * giving every record the shape the queue works with.
 */
export function normaliseNeedRow<T extends Record<string, unknown>>(row: T): T {
  return {
    ...row,
    urgency: row["urgency"] ?? row["priority"] ?? "normal",
    origin: row["origin"] ?? "reported",
    status: String(row["status"] ?? "reported"),
    fulfilled_quantity: Number(row["fulfilled_quantity"] ?? 0),
    stock_item_id: row["stock_item_id"] ?? null,
    purchase_request_id: row["purchase_request_id"] ?? null,
  } as T;
}

export function isOpenStockNeed(status: unknown): boolean {
  return (OPEN_STOCK_NEED_STATUSES as readonly string[]).includes(
    String(status ?? "").trim().toLowerCase(),
  );
}

/**
 * Apply a requested status filter to a `department_stock_needs` query.
 *
 * `all` filters nothing; `open` (and the legacy alias `pending`) expands to the
 * open statuses; anything else is an exact status the caller asked for.
 */
// The Supabase query builder is generic across every department call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyStockNeedStatus<T extends { eq: any; in: any }>(query: T, status: string): T {
  const wanted = status.trim().toLowerCase();
  if (wanted === "all" || wanted === "") return query;
  if (wanted === "open" || wanted === "pending")
    return query.in("status", OPEN_STOCK_NEED_STATUSES as unknown as string[]) as T;
  return query.eq("status", wanted) as T;
}
