import { describe, expect, it } from "vitest";
import {
  aggregateComponents,
  consumptionForSale,
  isDiscreteUnit,
  wholeUnitIssue,
  type RecipeRecord,
} from "@/lib/recipe-engine";

/**
 * Whole-unit maths. A bun, a bottle, a can or an egg is counted whole: the
 * quantity a sale uses stays a whole number, and any wastage allowance becomes
 * its own whole entry instead of turning one bun into 1.02 pc.
 */
const burger = (waste: number): RecipeRecord => ({
  id: "r1",
  name: "Burger",
  recipe_type: "menu_item",
  status: "active",
  yield_quantity: 1,
  yield_unit: "portion",
  ingredients: [
    { id: "i1", component_type: "stock_item", stock_item_id: "bun", quantity: 1, unit: "piece", waste_allowance: waste },
    { id: "i2", component_type: "stock_item", stock_item_id: "mince", quantity: 180, unit: "g", waste_allowance: waste },
  ],
});

const baseUnit = (id: string) => (id === "bun" ? "piece" : "g");

describe("whole-unit recipe maths", () => {
  it("knows which units are counted whole", () => {
    for (const u of ["piece", "PCS(Piece)", "bottle", "bun", "egg", "can"]) {
      expect(isDiscreteUnit(u)).toBe(true);
    }
    for (const u of ["g", "kg", "ml", "L"]) expect(isDiscreteUnit(u)).toBe(false);
  });

  it("refuses a fractional quantity for a whole-unit ingredient", () => {
    expect(wholeUnitIssue(1.02, "piece")).toMatch(/whole/i);
    expect(wholeUnitIssue(1, "piece")).toBeNull();
    expect(wholeUnitIssue(0.375, "kg")).toBeNull();
  });

  it("deducts exactly one bun for one burger, with no wastage entry", () => {
    const out = consumptionForSale(new Map([["r1", burger(0)]]), "r1", 1, baseUnit);
    const bun = out.filter((c) => c.stockItemId === "bun");
    expect(bun).toHaveLength(1);
    expect(bun[0]).toMatchObject({ quantity: 1, unit: "piece", kind: "use" });
    expect(out.find((c) => c.stockItemId === "mince")).toMatchObject({ quantity: 180, kind: "use" });
  });

  it("records wastage on a whole-unit item as a separate whole entry", () => {
    const out = consumptionForSale(new Map([["r1", burger(2)]]), "r1", 1, baseUnit);
    const bun = out.filter((c) => c.stockItemId === "bun");
    expect(bun.find((c) => c.kind === "use")?.quantity).toBe(1);
    expect(bun.find((c) => c.kind === "waste")?.quantity).toBe(1);
    expect(bun.every((c) => Number.isInteger(c.quantity))).toBe(true);
    // Weighed ingredients keep their decimals and their own wastage line.
    const mince = out.filter((c) => c.stockItemId === "mince");
    expect(mince.find((c) => c.kind === "use")?.quantity).toBeCloseTo(180);
    expect(mince.find((c) => c.kind === "waste")?.quantity).toBeCloseTo(3.6);
  });

  it("converts weighed ingredients to the stock item's base unit", () => {
    const out = aggregateComponents(
      [{ stockItemId: "oil", quantity: 40, unit: "ml", kind: "use" }],
      () => "L",
    );
    expect(out[0]?.quantity).toBeCloseTo(0.04);
  });
});
