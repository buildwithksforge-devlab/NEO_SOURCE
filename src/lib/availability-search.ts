/**
 * One shared shape for the availability search context so the dates, room type
 * and occupancy an operator entered survive navigation to the waitlist or the
 * reservation wizard — and can never be silently reset to today.
 *
 * This module also owns the canonical DEFAULT contract for the search. A bare
 * `/pms/availability` URL must open on a valid, bookable range — never on a
 * zero-night validation error. All arithmetic here is pure calendar
 * arithmetic in the property's own timezone: `new Date(...).toISOString()`
 * drifts by a day for UTC+3 (Africa/Nairobi) and was the cause of the
 * "arrival === departure, 0 nights" defect on first open.
 */
export type AvailabilitySearch = {
  arrival?: string | undefined;
  departure?: string | undefined;
  roomType?: string | undefined;
  adults?: number | undefined;
  children?: number | undefined;
  roomId?: string | undefined;
};

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Property-local calendar. Dates are what the front desk sees, not UTC. */
export const PROPERTY_TIME_ZONE = "Africa/Nairobi";

export const AVAILABILITY_DEFAULTS = {
  roomType: "all",
  adults: 2,
  children: 0,
} as const;

/** Today's calendar date in the property's timezone (never a UTC-shifted day). */
export function propertyToday(timeZone: string = PROPERTY_TIME_ZONE, now: Date = new Date()): string {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  }
}

/**
 * Add whole calendar days to an ISO date with no timezone involved at all.
 * Handles month and year rollover, including leap days.
 */
export function addCalendarDays(date: string, days: number): string {
  if (!ISO_DATE.test(date)) return date;
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const stamp = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const next = new Date(stamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** Whole nights between two ISO dates, timezone-free. */
export function calendarNights(arrival: string, departure: string): number {
  if (!ISO_DATE.test(arrival) || !ISO_DATE.test(departure)) return 0;
  const [ay, am, ad] = arrival.split("-").map(Number) as [number, number, number];
  const [dy, dm, dd] = departure.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(dy, dm - 1, dd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

export function parseAvailabilitySearch(search: Record<string, unknown>): AvailabilitySearch {
  const date = (v: unknown) => (typeof v === "string" && ISO_DATE.test(v) ? v : undefined);
  const count = (v: unknown) => {
    if (v === undefined || v === null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
  };
  return {
    arrival: date(search["arrival"]),
    departure: date(search["departure"]),
    roomType: typeof search["roomType"] === "string" ? search["roomType"] : undefined,
    adults: count(search["adults"]),
    children: count(search["children"]),
    roomId: typeof search["roomId"] === "string" ? search["roomId"] : undefined,
  };
}

export type ResolvedAvailabilitySearch = {
  /** The values the page renders and queries with. */
  values: { arrival: string; departure: string; roomType: string; adults: number; children: number };
  /** True when the URL omitted one or more params and should be canonicalized. */
  needsCanonicalUrl: boolean;
  /**
   * True only when the operator explicitly supplied a departure that is not
   * after the arrival. Such input stays visible and invalid — it is never
   * silently "corrected" into a successful search.
   */
  explicitInvalidRange: boolean;
};

/**
 * The single default/normalisation contract for the availability search.
 *
 * - Absent/blank/unparsable arrival -> property-local today.
 * - Absent/blank/unparsable departure -> arrival + 1 calendar day.
 * - Explicit valid departure -> preserved exactly, even when it is invalid
 *   relative to the arrival (same day or earlier), which is then reported.
 */
export function resolveAvailabilitySearch(
  search: AvailabilitySearch,
  options: { timeZone?: string; now?: Date } = {},
): ResolvedAvailabilitySearch {
  const arrivalGiven = typeof search.arrival === "string" && ISO_DATE.test(search.arrival);
  const departureGiven = typeof search.departure === "string" && ISO_DATE.test(search.departure);

  const arrival = arrivalGiven
    ? (search.arrival as string)
    : propertyToday(options.timeZone ?? PROPERTY_TIME_ZONE, options.now ?? new Date());
  const departure = departureGiven ? (search.departure as string) : addCalendarDays(arrival, 1);

  const roomTypeGiven = typeof search.roomType === "string" && search.roomType !== "";
  const adultsGiven = typeof search.adults === "number";
  const childrenGiven = typeof search.children === "number";

  return {
    values: {
      arrival,
      departure,
      roomType: roomTypeGiven ? (search.roomType as string) : AVAILABILITY_DEFAULTS.roomType,
      adults: adultsGiven ? (search.adults as number) : AVAILABILITY_DEFAULTS.adults,
      children: childrenGiven ? (search.children as number) : AVAILABILITY_DEFAULTS.children,
    },
    needsCanonicalUrl: !arrivalGiven || !departureGiven || !roomTypeGiven || !adultsGiven || !childrenGiven,
    explicitInvalidRange: departureGiven && calendarNights(arrival, departure) <= 0,
  };
}
