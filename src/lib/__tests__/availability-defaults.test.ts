/**
 * Live contradiction (production, same authenticated session):
 *   /pms/availability             -> arrival 2026-08-22, departure 2026-08-22, 0 nights, error
 *   /pms/availability?arrival=…   -> 1 night, 6 real room cards
 * The default/parser was wrong: `addDays` round-tripped through
 * `toISOString()`, which for Africa/Nairobi (UTC+3) returned the SAME day.
 * These tests pin the canonical default contract.
 */
import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  calendarNights,
  parseAvailabilitySearch,
  propertyToday,
  resolveAvailabilitySearch,
} from "@/lib/availability-search";

const NBO = "Africa/Nairobi";

describe("property-local calendar arithmetic", () => {
  it("does not drift for a UTC+3 property at the start of the local day", () => {
    // 2026-08-21T21:00:00Z is 2026-08-22 00:00 in Nairobi.
    const now = new Date("2026-08-21T21:00:00Z");
    expect(propertyToday(NBO, now)).toBe("2026-08-22");
    expect(addCalendarDays(propertyToday(NBO, now), 1)).toBe("2026-08-23");
  });

  it("rolls over months, years and leap days", () => {
    expect(addCalendarDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addCalendarDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(calendarNights("2026-12-31", "2027-01-02")).toBe(2);
  });
});

describe("availability default contract", () => {
  const now = new Date("2026-08-21T21:00:00Z"); // 2026-08-22 in Nairobi

  it("bare URL opens on today -> today + 1 night, never zero nights", () => {
    const r = resolveAvailabilitySearch(parseAvailabilitySearch({}), { timeZone: NBO, now });
    expect(r.values.arrival).toBe("2026-08-22");
    expect(r.values.departure).toBe("2026-08-23");
    expect(calendarNights(r.values.arrival, r.values.departure)).toBe(1);
    expect(r.explicitInvalidRange).toBe(false);
    expect(r.needsCanonicalUrl).toBe(true);
    expect(r.values).toMatchObject({ roomType: "all", adults: 2, children: 0 });
  });

  it("arrival only, or a blank/invalid departure, defaults departure to arrival + 1", () => {
    for (const departure of [undefined, "", "not-a-date"]) {
      const r = resolveAvailabilitySearch(
        parseAvailabilitySearch({ arrival: "2026-08-31", departure }),
        { timeZone: NBO, now },
      );
      expect(r.values.arrival).toBe("2026-08-31");
      expect(r.values.departure).toBe("2026-09-01");
      expect(r.explicitInvalidRange).toBe(false);
      expect(r.needsCanonicalUrl).toBe(true);
    }
  });

  it("preserves an explicit valid range exactly and needs no canonicalization", () => {
    const r = resolveAvailabilitySearch(
      parseAvailabilitySearch({
        arrival: "2026-08-24",
        departure: "2026-08-25",
        roomType: "all",
        adults: "2",
        children: "0",
      }),
      { timeZone: NBO, now },
    );
    expect(r.values).toEqual({
      arrival: "2026-08-24",
      departure: "2026-08-25",
      roomType: "all",
      adults: 2,
      children: 0,
    });
    expect(r.needsCanonicalUrl).toBe(false);
    expect(r.explicitInvalidRange).toBe(false);
  });

  it("keeps an explicit same-day or backward range visible and invalid", () => {
    for (const departure of ["2026-08-24", "2026-08-23"]) {
      const r = resolveAvailabilitySearch(
        parseAvailabilitySearch({ arrival: "2026-08-24", departure, roomType: "all", adults: "2", children: "0" }),
        { timeZone: NBO, now },
      );
      expect(r.values.departure).toBe(departure); // not silently repaired
      expect(r.explicitInvalidRange).toBe(true);
      expect(calendarNights(r.values.arrival, r.values.departure)).toBeLessThanOrEqual(0);
    }
  });

  it("canonicalization is idempotent — re-resolving the canonical URL cannot loop", () => {
    const first = resolveAvailabilitySearch(parseAvailabilitySearch({}), { timeZone: NBO, now });
    expect(first.needsCanonicalUrl).toBe(true);
    const second = resolveAvailabilitySearch(parseAvailabilitySearch({ ...first.values }), { timeZone: NBO, now });
    expect(second.needsCanonicalUrl).toBe(false);
    expect(second.values).toEqual(first.values);
  });

  it("the first committed query uses the normalized defaults, so it is enabled on first open", () => {
    const r = resolveAvailabilitySearch(parseAvailabilitySearch({}), { timeZone: NBO, now });
    const queryInput = {
      arrival: r.values.arrival,
      departure: r.values.departure,
      roomType: r.values.roomType === "all" ? null : r.values.roomType,
      adults: r.values.adults,
      children: r.values.children,
      enabled: calendarNights(r.values.arrival, r.values.departure) > 0,
    };
    expect(queryInput).toEqual({
      arrival: "2026-08-22",
      departure: "2026-08-23",
      roomType: null,
      adults: 2,
      children: 0,
      enabled: true,
    });
  });
});
