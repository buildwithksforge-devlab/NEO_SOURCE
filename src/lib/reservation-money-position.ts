export type ReservationMoneyPosition = {
  currency: string; quote: number; obligation: number; collected: number;
  pending: number; outstanding: number; credit: number; headroom: number;
  payment_status: string; deposit_paid: number;
};

/** Validate the server equation; do not reconstruct money from cached reservation columns. */
export function requireReservationMoneyPosition(value: unknown, reservationId: string): ReservationMoneyPosition {
  const message = "Reservation amounts do not reconcile. Refresh and review the saved payments before collecting again.";
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  const row = value as Record<string, unknown>;
  if (row["reservation_id"] !== reservationId || typeof row["currency"] !== "string" || !/^[A-Z]{3}$/.test(row["currency"])
    || !["unpaid", "part-paid", "paid"].includes(String(row["payment_status"]))) throw new Error(message);
  const amount = (key: string) => {
    const n = row[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || !Number.isSafeInteger(Math.round(n * 100))) throw new Error(message);
    return n;
  };
  const position = {currency:row["currency"],quote:amount("quote"),obligation:amount("obligation"),
    collected:amount("collected"),pending:amount("pending"),outstanding:amount("outstanding"),credit:amount("credit"),
    headroom:amount("headroom"),deposit_paid:amount("deposit_paid"),payment_status:String(row["payment_status"])};
  const agrees = (a: number,b: number) => Math.abs(a-b) < 0.005;
  if (!agrees(position.outstanding,Math.max(position.obligation-position.collected,0))
    || !agrees(position.credit,Math.max(position.collected-position.obligation,0))
    || !agrees(position.headroom,Math.max(position.outstanding-position.pending,0))
    || position.deposit_paid > position.collected + 0.005) throw new Error(message);
  return position;
}
