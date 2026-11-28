import { describe, expect, it } from "vitest";
import { mpesaChargePlan, mpesaMaxAmount, mpesaWholeAmount } from "@/lib/mpesa-amount";

describe("M-Pesa nearest-shilling rounding", () => {
  it("rounds 50 cents up: KES 1,380.50 is charged 1,381 with 0.50 rounding", () => {
    expect(mpesaChargePlan(1380.5, "pos_order")).toEqual({ amount: 1381, rounding: 0.5 });
  });

  it("rounds under 50 cents down: KES 1,380.40 is charged 1,380 with -0.40 rounding", () => {
    expect(mpesaChargePlan(1380.4, "pos_order")).toEqual({ amount: 1380, rounding: -0.4 });
  });

  it("leaves a whole bill unchanged", () => {
    expect(mpesaChargePlan(1380, "pos_order")).toEqual({ amount: 1380, rounding: 0 });
  });

  it("cannot charge a balance under 50 cents", () => {
    expect(mpesaWholeAmount(0.4)).toBe(0);
  });

  it("charges folios as whole-shilling part payments with no rounding", () => {
    expect(mpesaChargePlan(1380.5, "folio")).toEqual({ amount: 1380, rounding: 0 });
  });

  it("lets staff charge up to the rounded bill, not more", () => {
    expect(mpesaMaxAmount(1380.5, "pos_order")).toBe(1381);
    expect(mpesaMaxAmount(1380.5, "folio")).toBe(1380.5);
  });
});
