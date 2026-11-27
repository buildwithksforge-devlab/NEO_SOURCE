import { describe, expect, it } from "vitest";

import {
  classifySupplierAvailability,
  prepareSupplierAvailabilityLine,
  assertAvailabilityResponse,
} from "../supplier-availability";

const input = {
  requestLineId: "line-1",
  requested: 20,
  available: "12",
  leadTimeDays: "2",
};

describe("supplier availability", () => {

  it("recognizes full availability", () => {
    expect(classifySupplierAvailability(20,20))
      .toBe("available");
  });

  it("recognizes partial availability", () => {
    expect(classifySupplierAvailability(20,12))
      .toBe("partial");
  });

  it("recognizes unavailable products", () => {
    expect(classifySupplierAvailability(20,0))
      .toBe("unavailable");
  });

  it("rejects excessive quantities", () => {
    expect(() =>
      classifySupplierAvailability(20,21)
    ).toThrow();
  });

  it("rejects negative quantities", () => {
    expect(() =>
      classifySupplierAvailability(20,-1)
    ).toThrow();
  });

  it("rejects nonfinite quantities", () => {
    expect(() =>
      classifySupplierAvailability(20,Infinity)
    ).toThrow();
  });

  it("rejects invalid request quantities", () => {
    expect(() =>
      classifySupplierAvailability(0,0)
    ).toThrow();
  });

  it("accepts decimal quantities", () => {
    expect(prepareSupplierAvailabilityLine({
      ...input,
      available: "12.5",
    }).available_quantity).toBe(12.5);
  });

  it("does not interpret blank input as zero", () => {
    expect(() =>
      prepareSupplierAvailabilityLine({
        ...input,
        available: "",
      })
    ).toThrow();
  });

  it("records delivery lead time", () => {
    expect(
      prepareSupplierAvailabilityLine(input).lead_time_days
    ).toBe(2);
  });

  it("rejects fractional lead time", () => {
    expect(() =>
      prepareSupplierAvailabilityLine({
        ...input,
        leadTimeDays: "2.5",
      })
    ).toThrow();
  });

  it("supports alternatives", () => {
    expect(prepareSupplierAvailabilityLine({
      ...input,
      alternative: "Alternative supplier product",
    }).alternative).toBe(
      "Alternative supplier product"
    );
  });

  it("requires a persisted response", () => {
    expect(() =>
      assertAvailabilityResponse({ok:true})
    ).toThrow();
  });

  it("returns confirmed response identity", () => {
    expect(assertAvailabilityResponse({
      ok:true,
      response_id:"response-1",
    })).toBe("response-1");
  });

});