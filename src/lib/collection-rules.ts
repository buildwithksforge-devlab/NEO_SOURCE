/**
 * Rules that decide whether a cashier may take money for a bill.
 *
 * Pure and free of React so they can be exercised directly: the same rules
 * govern the dialog, and nothing here grants authority — the department's own
 * posting routine and RLS remain the authorities.
 */

export type CollectionAttempt = {
  /** Outstanding balance on the bill. */
  balance: number;
  /** Amount the cashier is taking; blank means the whole balance. */
  amount: string;
  /** Cash handed over; blank means exactly the amount. */
  tendered: string;
  method: string;
  /** The signed-in cashier's open till session, if any. */
  openShiftId: string | null;
  /** True while a collection is in flight. */
  pending: boolean;
};

export type CollectionVerdict = {
  /** The amount that will actually be collected. */
  value: number;
  /** Change owed back to the guest, cash only. */
  change: number;
  overpaid: boolean;
  shortTender: boolean;
  /** Cash without an open till can never reconcile at end of shift. */
  tillMissing: boolean;
  blocked: boolean;
  /** Why the collection cannot proceed, in the cashier's words. */
  reason: string | null;
};

/** Deterministic key so a double click cannot collect the same bill twice. */
export function collectionKey(source: string, sourceId: string, value: number): string {
  return `${source}:${sourceId}:${value.toFixed(2)}`;
}

export function evaluateCollection(attempt: CollectionAttempt): CollectionVerdict {
  const balance = Number(attempt.balance ?? 0);
  const value = attempt.amount === "" ? balance : Number(attempt.amount);
  const isCash = attempt.method === "cash";
  const valid = Number.isFinite(value) && value > 0;
  const overpaid = valid && value > balance + 0.009;
  const tenderedValue = attempt.tendered === "" ? value : Number(attempt.tendered);
  const shortTender =
    isCash && attempt.tendered !== "" && Number.isFinite(tenderedValue) && tenderedValue < value - 0.009;
  const change = isCash && Number.isFinite(tenderedValue) ? Math.max(0, tenderedValue - value) : 0;
  const tillMissing = isCash && !attempt.openShiftId;

  let reason: string | null = null;
  if (!valid) reason = "Enter the amount being collected.";
  else if (overpaid)
    reason = "More than the outstanding balance — an overpayment needs an approved refund instead.";
  else if (tillMissing) reason = "Open your till before taking cash, so the shift reconciles.";
  else if (shortTender) reason = "Cash tendered is less than the amount being collected.";

  return {
    value: valid ? value : 0,
    change,
    overpaid,
    shortTender,
    tillMissing,
    blocked: attempt.pending || reason !== null,
    reason,
  };
}
