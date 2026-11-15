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
