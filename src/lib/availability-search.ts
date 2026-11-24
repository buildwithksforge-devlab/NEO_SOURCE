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
export function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value) || Number(value.slice(0,4)) < 1) return false;
  const stamp = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0,10) === value;
}

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
  if (!isCalendarDate(date) || !Number.isInteger(days)) return date;
  const stamp = Date.parse(date + "T00:00:00Z") + days * 86_400_000;
  if (!Number.isFinite(stamp) || Math.abs(stamp) > 8640000000000000) return date;
  const result = new Date(stamp).toISOString().slice(0,10);
  return isCalendarDate(result) ? result : date;
}

/** Whole nights between actual calendar dates; backward ranges remain negative. */
export function calendarNights(arrival: string, departure: string): number {
  if (!isCalendarDate(arrival) || !isCalendarDate(departure)) return 0;
  return Math.round((Date.parse(departure + "T00:00:00Z") - Date.parse(arrival + "T00:00:00Z")) / 86_400_000);
}

export function parseAvailabilitySearch(search: Record<string, unknown>): AvailabilitySearch {
  const date = (v: unknown) => (typeof v === "string" && isCalendarDate(v) ? v : undefined);
  const count = (v: unknown, minimum: number) => {
    if (v === undefined || v === null || (typeof v === "string" && !v.trim())) return undefined;
    if (typeof v !== "number" && typeof v !== "string") return undefined;
    const n = Number(v);
    return Number.isInteger(n) && n >= minimum ? n : undefined;
  };
  return {
    arrival: date(search["arrival"]),
    departure: date(search["departure"]),
    roomType: typeof search["roomType"] === "string" ? search["roomType"] : undefined,
    adults: count(search["adults"], 1),
    children: count(search["children"], 0),
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
  const arrivalGiven = typeof search.arrival === "string" && isCalendarDate(search.arrival);
  const departureGiven = typeof search.departure === "string" && isCalendarDate(search.departure);

  const arrival = arrivalGiven
    ? (search.arrival as string)
    : propertyToday(options.timeZone ?? PROPERTY_TIME_ZONE, options.now ?? new Date());
  const departure = departureGiven ? (search.departure as string) : addCalendarDays(arrival, 1);

  const roomTypeGiven = typeof search.roomType === "string" && search.roomType !== "";
  const adultsGiven = typeof search.adults === "number" && Number.isInteger(search.adults) && search.adults >= 1;
  const childrenGiven = typeof search.children === "number" && Number.isInteger(search.children) && search.children >= 0;

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
