import { describe, expect, it } from "vitest";
import { normalizeWeekday, normalizeWeekdays, isoWeekdayOf } from "@/lib/weekdays";
import { buildRatePlanRow, type RatePlanInput } from "@/lib/rates-data";

const base: RatePlanInput = {
  name: "QA Weekend",
  code: "qawknd",
  description: "",
  room_type_id: null,
  meal_plan_id: null,
  base_rate: 10000,
  currency: "kes",
  tax_treatment: "exclusive",
  tax_rate: 16,
  service_charge_rate: 0,
  included_occupancy: 2,
  extra_adult_charge: 0,
  child_per_night: 0,
  extra_bed_charge: 0,
  min_stay: null,
  max_stay: null,
  valid_from: null,
  valid_to: null,
  days_of_week: [],
  corporate_only: false,
  cancellation_policy: "",
  deposit_policy: "",
  status: "active",
};

describe("canonical weekdays", () => {
  it("maps labels, legacy strings and numbers to ISO integers", () => {
    expect(normalizeWeekday("sat")).toBe(6);
    expect(normalizeWeekday("SAT")).toBe(6);
    expect(normalizeWeekday("Saturday")).toBe(6);
    expect(normalizeWeekday("6")).toBe(6);
    expect(normalizeWeekday(6)).toBe(6);
    expect(normalizeWeekday("sun")).toBe(7);
    expect(normalizeWeekday("0")).toBe(7);
  });

  it("rejects unrecognised values with a truthful message", () => {
    expect(normalizeWeekday("caturday")).toBeNull();
    expect(() => normalizeWeekdays(["mon", "caturday"])).toThrow(/Unrecognised weekday/);
    expect(() => normalizeWeekdays([9])).toThrow(/Unrecognised weekday/);
  });

  it("sorts and de-duplicates", () => {
    expect(normalizeWeekdays(["sun", "sat", 6])).toEqual([6, 7]);
  });

  it("matches Postgres isodow", () => {
    expect(isoWeekdayOf("2026-08-22")).toBe(6); // Saturday
    expect(isoWeekdayOf("2026-08-24")).toBe(1); // Monday
  });
});

describe("rate plan payload", () => {
  it("sends integers for weekdays and normalises code/currency", () => {
    const row = buildRatePlanRow({ ...base, days_of_week: [6, 7] });
    expect(row.days_of_week).toEqual([6, 7]);
    expect(row.code).toBe("QAWKND");
    expect(row.currency).toBe("KES");
  });

  it("nulls blank optional values instead of sending empty strings", () => {
    const row = buildRatePlanRow({ ...base, valid_from: "", valid_to: "", room_type_id: "", min_stay: null });
    expect(row.valid_from).toBeNull();
    expect(row.valid_to).toBeNull();
    expect(row.room_type_id).toBeNull();
    expect(row.min_stay).toBeNull();
    expect(row.days_of_week).toBeNull();
  });

  it("validates stays, dates, currency and identifiers", () => {
    expect(() => buildRatePlanRow({ ...base, min_stay: 5, max_stay: 2 })).toThrow(/Maximum stay/);
    expect(() => buildRatePlanRow({ ...base, valid_from: "2026-05-10", valid_to: "2026-05-01" })).toThrow(/Effective to/);
    expect(() => buildRatePlanRow({ ...base, valid_from: "10/05/2026" })).toThrow(/valid date/);
    expect(() => buildRatePlanRow({ ...base, currency: "shillings" })).toThrow(/Currency/);
    expect(() => buildRatePlanRow({ ...base, room_type_id: "Deluxe Double" })).toThrow(/Room type/);
    expect(() => buildRatePlanRow({ ...base, name: "  " })).toThrow(/name is required/);
    expect(() => buildRatePlanRow({ ...base, tax_rate: 250 })).toThrow(/Tax rate/);
  });
});
