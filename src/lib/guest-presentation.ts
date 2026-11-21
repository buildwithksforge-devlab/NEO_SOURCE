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

const activeOrderStatuses = new Set([
  "pending", "placed", "pending-payment", "payment-pending", "payment-verification", "confirmed", "accepted",
  "preparing", "in-preparation", "ready", "ready-for-pickup", "awaiting-rider", "rider-assigned", "dispatched",
  "on-the-way", "out-for-delivery", "en-route", "arrived", "picked-up",
]);
const cancelledOrderStatuses = new Set(["cancelled", "rejected", "declined", "failed", "delivery-failed", "returned"]);

export type GuestOrderBucket = "active" | "scheduled" | "completed" | "cancelled";

export function guestOrderSearch(search: Record<string, unknown>): { filter?: GuestOrderBucket } {
  const value = search["filter"];
  return value === "active" || value === "scheduled" || value === "completed" || value === "cancelled"
    ? { filter: value }
    : {};
}

export function orderBucket(status: unknown, scheduledFor?: unknown, fulfilment?: unknown) {
  const value = String(status ?? "").toLowerCase().replaceAll("_", "-");
  if (cancelledOrderStatuses.has(value)) return "cancelled";
  if (!activeOrderStatuses.has(value) && !(value === "collected" && fulfilment === "delivery")) return "completed";
  return scheduledFor && new Date(String(scheduledFor)).getTime() > Date.now() ? "scheduled" : "active";
}

type GuestFulfilment = "room-service" | "pickup" | "delivery";

export function chooseGuestFulfilment(
  inHouse: boolean,
  published: Record<GuestFulfilment, readonly { id: string }[] | undefined>,
  requestedItem?: string,
): GuestFulfilment {
  const priority: GuestFulfilment[] = inHouse ? ["room-service", "delivery", "pickup"] : ["delivery", "pickup"];
  return priority.find((mode) => requestedItem && published[mode]?.some((item) => item.id === requestedItem))
    ?? priority.find((mode) => published[mode]?.length)
    ?? (inHouse ? "room-service" : "delivery");
}
