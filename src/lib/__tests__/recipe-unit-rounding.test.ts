import { describe, expect, it } from "vitest";
import { roundForUnit, convertStrict, canConvert } from "@/lib/recipe-engine";

/**
 * Counted things (a bun, a bottle, a ream) can only leave the store whole.
 * Measured things (grams, millilitres) keep their exact amount. Unit names are
 * typed by hand, so the same unit arrives spelled several ways.
 */
describe("whole-unit rounding", () => {
  const discrete = ["pc", "PC", "Piece", "pieces", "bottle", "Bottle ", "can", "ream", "bun", "pack", "PCS(Piece)", "Piece(PC)", "tot", "glass"];
  for (const unit of discrete) {
    it(`rounds ${unit} up to a whole unit`, () => {
      expect(roundForUnit(1.02, unit)).toBe(2);
      expect(roundForUnit(2, unit)).toBe(2);
      expect(roundForUnit(0.2, unit)).toBe(1);
    });
  }

  const measured = ["g", "kg", "ml", "l", "G", "KG", "ML"];
  for (const unit of measured) {
    it(`keeps ${unit} exact`, () => {
      expect(roundForUnit(20.4, unit)).toBe(20.4);
      expect(roundForUnit(183.6, unit)).toBe(183.6);
    });
  }

  it("applies a waste allowance before rounding, per portion sold", () => {
    const perPortion = 1 * 1.02; // 1 bun + 2% waste
    expect(roundForUnit(perPortion, "pc")).toBe(2);
    expect(roundForUnit(perPortion * 3, "pc")).toBe(4); // 3.06 buns -> 4
    expect(roundForUnit(180 * 1.02, "g")).toBe(183.6);
  });

  it("reverses symmetrically, so a void gives back exactly what was taken", () => {
    const taken = roundForUnit(1.02, "pc");
    expect(-taken).toBe(-2);
  });
});

describe("unit conversion", () => {
  it("converts within the same family", () => {
    expect(convertStrict(1, "kg", "g")).toBe(1000);
    expect(convertStrict(1, "l", "ml")).toBe(1000);
    expect(convertStrict(750, "ml", "l")).toBe(0.75);
  });

  it("converts messy spellings of the same unit", () => {
    expect(convertStrict(2, "KG", "g")).toBe(2000);
    expect(convertStrict(2, "PCS(Piece)", "pc")).toBe(2);
  });

  it("refuses to guess across families", () => {
    expect(canConvert("g", "ml")).toBe(false);
    expect(() => convertStrict(1, "g", "pc")).toThrow();
  });
});
