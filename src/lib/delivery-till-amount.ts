/** Decimal input validation; no binary multiplication equality test for money. */
export function parseTillVerifiedAmount(value: string): number | null {
  const input = value.trim();
  if (input.length > 32 || !/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(input)) return null;
  const [whole, fraction = ""] = input.split(".");
  const cents = BigInt(whole || "0") * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const amount = Number(input);
  const exact = `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  const [serializedWhole, serializedFraction = ""] = String(amount).split(".");
  const serialized = `${serializedWhole}.${serializedFraction.padEnd(2, "0")}`;
  return Number.isFinite(amount) && serialized === exact ? amount : null;
}
