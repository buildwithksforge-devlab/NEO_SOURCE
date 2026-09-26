/**
 * Recipe → production → inventory consumption contract.
 *
 * Two channels:
 *  - Pure engine assertions (always run): a recipe that cannot be fully resolved
 *    to raw stock raises a typed error instead of returning a partial component
 *    list, so no caller can silently deduct half a recipe.
 *  - Read-only SQL assertions (PG* environment): the canonical posting routine
 *    deducts each stock item exactly once per order item, is idempotent on retry,
 *    and never leaves the order's own property/organisation.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  RecipeEngineError,
  aggregateComponents,
  consumptionForSale,
  expandRecipeToStock,
  type RecipeIngredient,
  type RecipeRecord,
} from "@/lib/recipe-engine";

const HAS_SQL = Boolean(process.env["PGHOST"]);

function text(query: string): string {
  return execFileSync("psql", ["-At", "-c", query], { encoding: "utf8" });
}

function stock(id: string, quantity: number, unit: string): RecipeIngredient {
  return { id: `${id}-line`, component_type: "stock_item", stock_item_id: id, quantity, unit };
}

function sub(id: string, quantity: number, unit: string): RecipeIngredient {
  return { id: `${id}-line`, component_type: "sub_recipe", sub_recipe_id: id, quantity, unit };
}

const SAUCE: RecipeRecord = {
  id: "sauce",
  name: "Pizza sauce",
  recipe_type: "sub_recipe",
  status: "active",
  yield_quantity: 12,
  yield_unit: "L",
  ingredients: [stock("tomato", 10, "kg"), stock("salt", 200, "g")],
};

const PIZZA: RecipeRecord = {
  id: "pizza",
  name: "Margherita",
  recipe_type: "menu_item",
  status: "active",
  yield_quantity: 1,
  yield_unit: "portion",
  ingredients: [stock("flour", 250, "g"), sub("sauce", 200, "ml")],
};

const BASE_UNITS: Record<string, string> = { flour: "g", tomato: "kg", salt: "g" };
const baseUnitOf = (id: string) => BASE_UNITS[id] ?? "g";

const CATALOGUE = new Map<string, RecipeRecord>([
  ["sauce", SAUCE],
  ["pizza", PIZZA],
]);

describe("recipe expansion to raw stock", () => {
  it("resolves sub-recipes to raw stock with yield maths applied once", () => {
    const lines = consumptionForSale(CATALOGUE, "pizza", 3, baseUnitOf);
    const byItem = Object.fromEntries(lines.map((l) => [l.stockItemId, l]));
    // 3 pizzas × 250 g flour.
    expect(byItem["flour"]?.quantity).toBeCloseTo(750);
    // 3 × 200 ml of a 12 L batch => 0.05 batches => 0.5 kg tomato, 10 g salt.
    expect(byItem["tomato"]?.quantity).toBeCloseTo(0.5);
    expect(byItem["salt"]?.quantity).toBeCloseTo(10);
    // Each raw item appears exactly once — no duplicate deduction lines.
    expect(new Set(lines.map((l) => l.stockItemId)).size).toBe(lines.length);
  });

  it("aggregates a repeated ingredient into a single deduction line", () => {
    const doubled: RecipeRecord = {
      id: "doubled",
      name: "Doubled",
      recipe_type: "menu_item",
      status: "active",
      yield_quantity: 1,
      yield_unit: "portion",
      ingredients: [
        { id: "a", component_type: "stock_item", stock_item_id: "flour", quantity: 100, unit: "g" },
        { id: "b", component_type: "stock_item", stock_item_id: "flour", quantity: 150, unit: "g" },
      ],
    };
    const lines = aggregateComponents(
      expandRecipeToStock(new Map([["doubled", doubled]]), "doubled", 1),
      baseUnitOf,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.quantity).toBeCloseTo(250);
  });
});

describe("insufficient / unresolvable recipe consumption fails loudly", () => {
  const cases: [string, () => unknown, RecipeEngineError["code"]][] = [
    [
      "missing sub-recipe",
      () => expandRecipeToStock(new Map([["pizza", PIZZA]]), "pizza", 1),
      "missing-recipe",
    ],
    [
      "inactive sub-recipe",
      () =>
        consumptionForSale(
          new Map<string, RecipeRecord>([
            ["pizza", PIZZA],
            ["sauce", { ...SAUCE, status: "draft" }],
          ]),
          "pizza",
          1,
          baseUnitOf,
        ),
      "inactive-recipe",
    ],
    [
      "zero yield",
      () =>
        consumptionForSale(
          new Map<string, RecipeRecord>([["bad", { ...PIZZA, id: "bad", yield_quantity: 0 }]]),
          "bad",
          1,
          baseUnitOf,
        ),
      "bad-yield",
    ],
    [
      "ingredient with no stock item",
      () =>
        expandRecipeToStock(
          new Map<string, RecipeRecord>([
            [
              "loose",
              {
                ...PIZZA,
                id: "loose",
                ingredients: [
                  {
                    id: "x",
                    component_type: "stock_item",
                    ingredient_name: "Chef's garnish",
                    quantity: 5,
                    unit: "g",
                  },
                ],
              },
            ],
          ]),
          "loose",
          1,
        ),
      "unresolved-ingredient",
    ],
    [
      "impossible unit conversion",
      () =>
        consumptionForSale(
          new Map<string, RecipeRecord>([
            ["pizza", { ...PIZZA, ingredients: [sub("sauce", 200, "g")] }],
            ["sauce", SAUCE],
          ]),
          "pizza",
          1,
          baseUnitOf,
        ),
      "missing-conversion",
    ],
    [
      "recipe cycle",
      () =>
        expandRecipeToStock(
          new Map<string, RecipeRecord>([
            ["a", { ...PIZZA, id: "a", ingredients: [sub("b", 1, "portion")] }],
            [
              "b",
              {
                ...PIZZA,
                id: "b",
                recipe_type: "sub_recipe",
                ingredients: [sub("a", 1, "portion")],
              },
            ],
          ]),
          "a",
          1,
        ),
      "cycle",
    ],
  ];

  for (const [label, run, code] of cases) {
    it(`${label} raises a typed error and returns no partial lines`, () => {
      let thrown: unknown;
      try {
        run();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(RecipeEngineError);
      expect((thrown as RecipeEngineError).code).toBe(code);
      // The error carries an operator-readable message, not a bare code.
      expect(String((thrown as Error).message).length).toBeGreaterThan(10);
    });
  }
});

describe.runIf(HAS_SQL)("posting routine: once only, own property only", () => {
  const source = () =>
    text(`SELECT prosrc FROM pg_proc WHERE proname = 'inventory_consume_order_item_core'`);

  it("short-circuits when the same order item was already posted", () => {
    const src = source();
    expect(src).toMatch(/inventory_posting_events[\s\S]*status\s*=\s*'posted'/);
    expect(src).toMatch(/already-posted/);
  });

  it("passes a deterministic idempotency key per stock item and kind to the movement ledger", () => {
    const src = source();
    // Used quantity and wastage allowance are separate movements, so each
    // carries its own stable key and a retry can never deduct twice.
    expect(src).toMatch(/'waste:'\s*ELSE\s*'consume:'\s*END/);
    expect(src).toMatch(/_order_item::text\s*\|\|\s*':'\s*\|\|\s*v_comp\.item_id::text/);
  });

  it("aggregates components so each stock item moves at most once per order item and kind", () => {
    expect(source()).toMatch(/GROUP BY e\.stock_item_id, e\.kind/);
  });

  it("resolves the store within the order's own organisation and branch", () => {
    const src = source();
    // Store resolution is delegated to the station-aware resolver, which stays
    // scoped to the order's own organisation and branch.
    expect(src).toMatch(/neo_station_consumption_location\(/);
    expect(src).toMatch(/no-location/);
    const resolver = text(`SELECT prosrc FROM pg_proc WHERE proname = 'neo_station_consumption_location'`);
    expect(resolver).toMatch(/FROM stock_locations[\s\S]*organization_id = _org/);
    expect(resolver).toMatch(/sl\.branch_id = _branch/);
  });

  it("selects the active recipe within the order's organisation only", () => {
    expect(source()).toMatch(/FROM recipes[\s\S]*organization_id = v_org/);
  });

  it("keeps the stock ledger as the single deduction path", () => {
    expect(source()).toMatch(/PERFORM inventory_apply_movement\(/);
  });
});
