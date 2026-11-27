/** The atomic database routine must confirm application, not just HTTP/RPC transport success. */
export function mpesaResultApplied(value: unknown, code: number): boolean {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
 const r=value as Record<string,unknown>;
 const expected=code===0?'success':code===1032?'cancelled':[1037,1019].includes(code)?'timeout':'failed';
 return r['ok']!==false && r['status']===expected && (r['applied']===true || r['duplicate']===true);
}

/** Observe the saved attempt while its dialog is open, including late results. */
export function mpesaObservationInterval(status: unknown): number | false {
 return status === 'success' ? false : 4000;
}

export function mpesaSupportsTotal(amount: unknown, currency: string): boolean {
 return (typeof amount === 'number' || (typeof amount === 'string' && amount.trim() !== ''))
  && currency === 'KES' && Number.isSafeInteger(Number(amount)) && Number(amount) > 0;
}


// NEO_MPESA_LATE_RESULT_V1

export type MpesaLateResultState =
  | "overpayment-accounted"
  | "awaiting-accounting";

export interface MpesaLateResult {
  state: MpesaLateResultState;
  exceptionId: string;
  journalId: string | null;
  financiallyPosted: boolean;
  retryRequired: boolean;
}

function validPaymentEvidenceId(value: unknown): value is string {

  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) &&
    value !== "00000000-0000-0000-0000-000000000000";

}

/**
 * Additional provider money is not settlement of the
 * original bill. Keep these result states separate.
 */
export function mpesaLateResult(
  value: unknown,
  code: number,
): MpesaLateResult | null {

  if(
    code !== 0 ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ){

    return null;

  }

  const r=value as Record<string,unknown>;

  if(
    r["ok"] === false ||
    r["handled"] !== true ||
    r["applied"] !== false ||
    r["duplicate"] === true ||
    !validPaymentEvidenceId(r["exception_id"])
  ){

    return null;

  }

  if(
    r["status"] === "overpayment-accounted" &&
    r["financially_posted"] === true &&
    r["retry_required"] === false &&
    validPaymentEvidenceId(r["journal_id"])
  ){

    return {

      state:"overpayment-accounted",

      exceptionId:r["exception_id"],

      journalId:r["journal_id"],

      financiallyPosted:true,

      retryRequired:false,

    };

  }

  if(
    r["status"] === "awaiting-accounting" &&
    r["financially_posted"] === false &&
    r["retry_required"] === true &&
    (
      r["journal_id"] === undefined ||
      r["journal_id"] === null
    )
  ){

    return {

      state:"awaiting-accounting",

      exceptionId:r["exception_id"],

      journalId:null,

      financiallyPosted:false,

      retryRequired:true,

    };

  }

  return null;

}


/**
 * Acknowledge only completed financial outcomes.
 * A preserved but unposted receipt remains retryable.
 */
export function mpesaCallbackAcknowledgable(
  value: unknown,
  code: number,
): boolean {

  if(mpesaResultApplied(value,code)){

    return true;

  }

  return mpesaLateResult(value,code)?.state
    === "overpayment-accounted";

}
