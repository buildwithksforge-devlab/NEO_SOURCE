/**
 * M-Pesa only accepts whole shillings. A bill paid in full by M-Pesa is charged
 * at the nearest shilling (under 50 cents rounds down, 50 cents or more rounds
 * up) and the bill records the difference as rounding. A folio collection or a
 * smaller amount typed by staff is a part payment: it must already be whole and
 * never adds rounding.
 *
 * The database applies the same rule (public.neo_mpesa_whole_amount); this
 * module only shows staff what will be charged before they send the prompt.
 */
export type MpesaSource = "pos_order" | "folio";

export type MpesaChargePlan = {
  /** Whole-shilling amount the phone will be asked for. */
  amount: number;
  /** Difference the bill records: amount minus balance (0 when none). */
  rounding: number;
};

function toCents(value: number): number {
  return Math.round(value * 100);
}

/** Nearest whole shilling; exactly 50 cents rounds up. */
export function mpesaWholeAmount(balance: number): number {
  if (!Number.isFinite(balance) || balance <= 0) return 0;
  const cents = toCents(balance);
  return Math.floor((cents + 50) / 100);
}

/** What a full-balance M-Pesa charge would ask for, per bill type. */
export function mpesaChargePlan(balance: number, source: MpesaSource): MpesaChargePlan {
  if (!Number.isFinite(balance) || balance <= 0) return { amount: 0, rounding: 0 };
  const cents = toCents(balance);
  if (source === "folio") {
    // Folio collections are whole-shilling part payments; cents stay on the folio.
    return { amount: Math.floor(cents / 100), rounding: 0 };
  }
  const amount = mpesaWholeAmount(balance);
  return { amount, rounding: (amount * 100 - cents) / 100 };
}

/** Largest amount staff may type for this bill. */
export function mpesaMaxAmount(balance: number, source: MpesaSource): number {
  return source === "pos_order" ? Math.max(mpesaWholeAmount(balance), 0) : Math.max(balance, 0);
}
