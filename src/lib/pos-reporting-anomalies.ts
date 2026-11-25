/**
 * Operational bill-value review signals.
 *
 * A flag is a review recommendation, not a finding
 * of fraud, accounting error, or recognized revenue.
 *
 * This function never changes source transactions.
 */

export type PosAnomalyBill = {
  id: string;
  grand_total: number | null;
};

export function unusualPosBillIds(
  bills: readonly PosAnomalyBill[],
): ReadonlySet<string> {
  const values = bills
    .map((bill) => bill.grand_total)
    .filter(
      (value): value is number =>
        typeof value === "number" &&
        Number.isFinite(value) &&
        value > 0,
    )
    .sort((a, b) => a - b);

  if (values.length < 5) {
    return new Set<string>();
  }

  const middle = Math.floor(values.length / 2);

  const median =
    values.length % 2 === 0
      ? (values[middle - 1]! + values[middle]!) / 2
      : values[middle]!;

  if (!Number.isFinite(median) || median <= 0) {
    return new Set<string>();
  }

  // Conservative operational review threshold.
  // Future releases can make this property-configurable.
  const threshold = Math.max(
    1_000_000,
    median * 20,
  );

  return new Set(
    bills
      .filter(
        (bill) =>
          typeof bill.grand_total === "number" &&
          Number.isFinite(bill.grand_total) &&
          bill.grand_total >= threshold,
      )
      .map((bill) => bill.id),
  );
}
