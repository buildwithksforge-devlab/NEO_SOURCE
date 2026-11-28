import { PAYMENT_VIEW_KEYS } from "@/lib/payment-view-refresh";
export const SUPPLY_VIEW_KEYS = [
  ...PAYMENT_VIEW_KEYS,
  "procurement",
  "procurement-department",
  "inventory",
  "stores-department",
  "stock-needs",
  "reconciliation",
  "ops",
] as const;
/** Refresh active views of the same saved supply-chain work; inactive views become stale. */
export function invalidateSupplyViews(
  cache: { invalidateQueries: (filters: { queryKey: readonly unknown[] }) => unknown },
  extraKeys: readonly string[] = [],
): Promise<void> {
  const keys = [...new Set<string>([...SUPPLY_VIEW_KEYS, ...extraKeys])];
  return Promise.all(keys.map((key) => cache.invalidateQueries({ queryKey: [key] }))).then(
    () => undefined,
  );
}
