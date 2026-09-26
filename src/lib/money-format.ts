/**
 * One money display strategy for the whole product.
 *
 * Two shapes, one source of truth:
 *
 * - `formatMoneyExact` — the accounting shape. Full precision, grouped
 *   thousands, two decimals. Statements, ledgers, invoices, folios, exports
 *   and any surface whose purpose is the exact figure MUST use this.
 * - `formatMoneyCompact` — the glance shape. `KES 128.8M` instead of
 *   `KES 128,750,654.00`, for KPI tiles and summary strips where the column
 *   is narrow and the trend is the point. The exact figure stays reachable
 *   through the title/tooltip that `moneyDisplay` returns alongside it.
 *
 * Nothing rounds silently: compact output is explicitly abbreviated with a
 * K/M/B suffix so nobody can mistake it for the precise amount.
 */

const UNITS: { limit: number; suffix: string }[] = [
  { limit: 1_000_000_000, suffix: "B" },
  { limit: 1_000_000, suffix: "M" },
  { limit: 1_000, suffix: "K" },
];

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function group(n: number, decimals: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Glance surfaces omit the currency code: the operating currency is a tenant
 * setting, not a per-figure fact, so repeating it on every card is noise.
 * Documents (invoices, folios, statements, exports) still carry it, and the
 * accessible title on compact values always spells the currency out.
 */
export function formatFigureExact(value: unknown, decimals = 2): string {
  const n = toNumber(value);
  if (n === null) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}${group(Math.abs(n), decimals)}`;
}

/** Currency prefix, normalised. Defaults to the tenant's operating currency. */
export function moneyPrefix(currency = "KES"): string {
  const code = (currency || "KES").trim().toUpperCase();
  return code;
}

/**
 * Accounting shape — never abbreviated. `KES 128,750,654.00`.
 * A missing or non-numeric value returns an honest dash, never `KES 0.00`.
 */
export function formatMoneyExact(
  value: unknown,
  currency = "KES",
  decimals = 2,
): string {
  const n = toNumber(value);
  if (n === null) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}${moneyPrefix(currency)} ${group(Math.abs(n), decimals)}`;
}

/**
 * Glance shape — abbreviated only when the figure is large enough that the
 * abbreviation actually buys space. Below 1,000 it is identical to the exact
 * shape, so small amounts never lose their cents.
 */
export function formatMoneyCompact(
  value: unknown,
  currency = "KES",
  options: { code?: boolean } = {},
): string {
  const prefix = options.code === false ? "" : `${moneyPrefix(currency)} `;
  const n = toNumber(value);
  if (n === null) return "—";
  if (n === 0) return `${prefix}0`;

  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";

  const unit = UNITS.find((u) => abs >= u.limit);
  if (!unit) {
    // Under a thousand: cents still matter, so show them.
    return `${sign}${prefix}${group(abs, abs % 1 === 0 ? 0 : 2)}`;
  }

  const scaled = abs / unit.limit;
  // One decimal, dropped when it is a bare zero: 128.8M, 1.3B, 12.4K, 5M.
  const rendered = group(scaled, 1).replace(/\.0$/, "");
  return `${sign}${prefix}${rendered}${unit.suffix}`;
}

/**
 * What a compact surface should render: the short label plus the exact figure
 * for the `title`/tooltip, so the precise amount is always one hover or one
 * screen-reader stop away.
 */
export function moneyDisplay(
  value: unknown,
  currency = "KES",
  options: { code?: boolean } = {},
): { label: string; exact: string; abbreviated: boolean } {
  const label = formatMoneyCompact(value, currency, options);
  const exact = formatMoneyExact(value, currency);
  const abbreviated = formatMoneyCompact(value, currency, { code: true }) !== exact;
  return { label, exact, abbreviated };
}
