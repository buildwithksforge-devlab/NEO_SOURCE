import { cn } from "@/lib/utils";
import { formatMoneyExact, moneyDisplay } from "@/lib/money-format";

/**
 * The one money component for glance surfaces (KPI tiles, summary strips).
 *
 * It renders the compact label and always carries the exact amount in the
 * accessible title, so precision is never lost — only deferred. Surfaces whose
 * purpose is accounting precision (statements, ledgers, invoices, exports)
 * must render `formatMoneyExact` directly instead, or pass `exact`.
 */
export function MoneyValue({
  value,
  currency = "KES",
  exact = false,
  code = false,
  className,
}: {
  value: unknown;
  currency?: string;
  exact?: boolean;
  /** Documents (invoices, folios, statements) show the currency code; glance surfaces do not. */
  code?: boolean;
  className?: string;
}) {
  if (exact) {
    return (
      <span data-money="exact" className={cn("neo-atomic tabular-nums", className)}>
        {formatMoneyExact(value, currency)}
      </span>
    );
  }

  const { label, exact: full, abbreviated } = moneyDisplay(value, currency, { code });
  return (
    <span
      data-money={abbreviated ? "compact" : "exact"}
      title={full}
      aria-label={full}
      className={cn("neo-atomic tabular-nums", className)}
    >
      {label}
    </span>
  );
}
