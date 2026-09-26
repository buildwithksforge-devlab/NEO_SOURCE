import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RecipeEngineError,
  consumptionForSale,
  convertStrict,
  expandRecipeToStock,
  perUnitPreview,
  type RecipeRecord,
} from "@/lib/recipe-engine";

const BEANS = "stock-beans";
const MILK = "stock-milk";
const TOMATO = "stock-tomato";
const ONION = "stock-onion";

const baseUnitOf = (id: string) => (id === MILK || id === TOMATO ? (id === MILK ? "ml" : "g") : "g");

const cappuccino: RecipeRecord = {
  id: "r-cap",
  name: "Cappuccino",
  recipe_code: "BEV-CAP-01",
  recipe_type: "menu_item",
  status: "active",
  yield_quantity: 1,
  yield_unit: "portion",
  ingredients: [
    { id: "i1", component_type: "stock_item", stock_item_id: BEANS, quantity: 18, unit: "g" },
    { id: "i2", component_type: "stock_item", stock_item_id: MILK, quantity: 200, unit: "ml" },
  ],
};

const pizzaSauce: RecipeRecord = {
  id: "r-sauce",
  name: "Pizza Sauce",
  recipe_code: "PRE-SAU-01",
  recipe_type: "sub_recipe",
  status: "active",
  yield_quantity: 12,
  yield_unit: "L",
  ingredients: [
    { id: "s1", component_type: "stock_item", stock_item_id: TOMATO, quantity: 10, unit: "kg" },
    { id: "s2", component_type: "stock_item", stock_item_id: ONION, quantity: 500, unit: "g" },
  ],
};

const pizza: RecipeRecord = {
  id: "r-pizza",
  name: "Margherita",
  recipe_code: "FOO-PIZ-01",
  recipe_type: "menu_item",
  status: "active",
  yield_quantity: 1,
  yield_unit: "portion",
  ingredients: [
    { id: "p1", component_type: "sub_recipe", sub_recipe_id: "r-sauce", quantity: 120, unit: "ml" },
  ],
};

const map = (...rs: RecipeRecord[]) => new Map(rs.map((r) => [r.id, r]));

describe("recipe engine — per-item recipes", () => {
  it("consumes exactly one portion of components for a single sale", () => {
    const out = consumptionForSale(map(cappuccino), "r-cap", 1, baseUnitOf);
    expect(out.find((c) => c.stockItemId === BEANS)?.quantity).toBe(18);
    expect(out.find((c) => c.stockItemId === MILK)?.quantity).toBe(200);
  });

  it("scales linearly with quantity sold", () => {
    const out = consumptionForSale(map(cappuccino), "r-cap", 3, baseUnitOf);
    expect(out.find((c) => c.stockItemId === BEANS)?.quantity).toBe(54);
    expect(out.find((c) => c.stockItemId === MILK)?.quantity).toBe(600);
  });

  it("divides by yield for multi-portion recipes", () => {
    const batch: RecipeRecord = { ...cappuccino, id: "r-batch", yield_quantity: 4 };
    const out = consumptionForSale(map(batch), "r-batch", 1, baseUnitOf);
    expect(out.find((c) => c.stockItemId === BEANS)?.quantity).toBe(4.5);
  });

  it("previews per-unit usage without touching stock", () => {
    expect(perUnitPreview(cappuccino)).toEqual([
      { label: "Component", quantity: 18, unit: "g" },
      { label: "Component", quantity: 200, unit: "ml" },
    ]);
  });
});

describe("recipe engine — batch sub-recipes", () => {
  it("resolves a sub-recipe recursively to raw stock", () => {
    const out = consumptionForSale(map(pizza, pizzaSauce), "r-pizza", 1, baseUnitOf);
    // 120 ml of a 12 L batch = 1% of the batch = 100 g tomato, 5 g onion.
    expect(out.find((c) => c.stockItemId === TOMATO)?.quantity).toBeCloseTo(100, 6);
    expect(out.find((c) => c.stockItemId === ONION)?.quantity).toBeCloseTo(5, 6);
  });

  it("aggregates a component reached twice so it is deducted once", () => {
    const doubled: RecipeRecord = {
      ...pizza,
      ingredients: [
        ...pizza.ingredients,
        { id: "p2", component_type: "stock_item", stock_item_id: TOMATO, quantity: 50, unit: "g" },
      ],
    };
    const out = consumptionForSale(map(doubled, pizzaSauce), "r-pizza", 1, baseUnitOf);
    expect(out.filter((c) => c.stockItemId === TOMATO)).toHaveLength(1);
    expect(out.find((c) => c.stockItemId === TOMATO)?.quantity).toBeCloseTo(150, 6);
  });
});

describe("recipe engine — failure behaviour", () => {
  it("rejects a cycle instead of expanding forever", () => {
    const a: RecipeRecord = { ...pizzaSauce, id: "a", ingredients: [{ id: "x", component_type: "sub_recipe", sub_recipe_id: "b", quantity: 1, unit: "L" }] };
    const b: RecipeRecord = { ...pizzaSauce, id: "b", ingredients: [{ id: "y", component_type: "sub_recipe", sub_recipe_id: "a", quantity: 1, unit: "L" }] };
    expect(() => expandRecipeToStock(map(a, b), "a", 1)).toThrow(RecipeEngineError);
  });

  it("refuses a conversion across unit families rather than guessing", () => {
    expect(() => convertStrict(1, "g", "ml")).toThrow(/No unit conversion/);
    const bad: RecipeRecord = {
      ...pizza,
      ingredients: [{ id: "p1", component_type: "sub_recipe", sub_recipe_id: "r-sauce", quantity: 120, unit: "g" }],
    };
    expect(() => consumptionForSale(map(bad, pizzaSauce), "r-pizza", 1, baseUnitOf)).toThrow(RecipeEngineError);
  });

  it("refuses an inactive or missing recipe", () => {
    expect(() => consumptionForSale(map({ ...cappuccino, status: "draft" }), "r-cap", 1, baseUnitOf)).toThrow(
      /not active/,
    );
    expect(() => consumptionForSale(map(cappuccino), "nope", 1, baseUnitOf)).toThrow(/not found/);
  });

  it("refuses an ingredient that does not resolve to a stock item", () => {
    const bad: RecipeRecord = {
      ...cappuccino,
      ingredients: [{ id: "i1", component_type: "stock_item", stock_item_id: null, ingredient_name: "Beans", quantity: 18, unit: "g" }],
    };
    expect(() => consumptionForSale(map(bad), "r-cap", 1, baseUnitOf)).toThrow(/does not resolve/);
  });

  it("refuses a recipe with no usable yield", () => {
    expect(() => consumptionForSale(map({ ...cappuccino, yield_quantity: 0 }), "r-cap", 1, baseUnitOf)).toThrow(
      /yield/,
    );
  });
});

describe("canonical consumption stays with the inventory ledger", () => {
  const routeSource = readFileSync("src/routes/_shell.kitchen.recipes.tsx", "utf8");
  const engineSource = readFileSync("src/lib/recipe-engine.ts", "utf8");

  it("never moves stock from the client engine", () => {
    expect(engineSource).not.toMatch(/\.rpc\(|from\("stock_|supabase/);
  });

  it("keeps the recipe route behind the shared kitchen capability guard", () => {
    expect(routeSource).toContain('<KitchenGuard action="recipes.view">');
    expect(routeSource).toContain('can("kitchen", "recipes.create")');
  });
});
