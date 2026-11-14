export function guestDisplayName(profile: Record<string, unknown> | null | undefined, metadata: Record<string, unknown> | null | undefined) {
  for (const value of [profile?.['full_name'], metadata?.['full_name']]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** A missing/zero/invalid configured rate is not a published free stay. */
export function publishedNightlyRate(value: unknown): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

/** Compare the quoted base with the server total without inventing tax facts. */
export function roomQuoteBreakdown(offer: {nightly_rate:number;nights:number;total_amount:number;tax_rate?:number;service_charge_rate?:number}) {
  const {nightly_rate:rate,nights,total_amount:total} = offer;
  if (!Number.isFinite(rate) || rate < 0 || !Number.isInteger(nights) || nights < 1 || !Number.isFinite(total) || total < 0) return null;
  const base = Math.round(rate * nights * 100) / 100;
  if (!Number.isFinite(base)) return null;
  return {base, adjustment:Math.round((total-base)*100)/100, total};
}

export function calendarNights(arrival: string, departure: string) {
  const day = (value:string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const time=Date.parse(value+'T00:00:00Z');
    return Number.isFinite(time) && new Date(time).toISOString().slice(0,10)===value ? time : NaN;
  };
  const a=day(arrival),d=day(departure);
  return Number.isFinite(a)&&Number.isFinite(d)&&d>a ? (d-a)/86400000 : 0;
}
