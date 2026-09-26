import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emptyIngredientRow, isRowComplete, rowsAreValid } from "@/components/kitchen/IngredientRows";

const recipeMaster = readFileSync("src/lib/recipe-master.ts", "utf8");
const kitchenData = readFileSync("src/lib/kitchen-data.ts", "utf8");
const recipesRoute = readFileSync("src/routes/_shell.kitchen.recipes.tsx", "utf8");

describe("recipe ingredient embed", () => {
  it("disambiguates recipe_ingredients, which has two foreign keys to recipes", () => {
    for (const source of [recipeMaster, kitchenData]) {
      expect(source).toContain("recipe_ingredients!recipe_ingredients_recipe_id_fkey");
      expect(source).not.toMatch(/[^!]recipe_ingredients\(/);
    }
  });
});

describe("repeatable ingredient sheet", () => {
  it("adds an independent row each time", () => {
    const rows = [emptyIngredientRow(), emptyIngredientRow(), emptyIngredientRow()];
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
  });

  it("requires a component, a positive quantity and a unit per row", () => {
    const row = emptyIngredientRow();
    expect(isRowComplete(row)).toBe(false);
    expect(isRowComplete({ ...row, stockItemId: "s1", quantity: "0" })).toBe(false);
    expect(isRowComplete({ ...row, stockItemId: "s1", quantity: "200", unit: "g" })).toBe(true);
    expect(isRowComplete({ ...row, componentType: "sub_recipe", subRecipeId: "r1", quantity: "20", unit: "ml" })).toBe(
      true,
    );
  });

  it("rejects a partially completed sheet", () => {
    const good = { ...emptyIngredientRow(), stockItemId: "s1", quantity: "200", unit: "g" };
    const bad = { ...emptyIngredientRow(), quantity: "30" };
    expect(rowsAreValid([good])).toBe(true);
    expect(rowsAreValid([good, bad])).toBe(false);
    expect(rowsAreValid([])).toBe(false);
  });

  it("writes the whole sheet in one insert from the recipe form", () => {
    expect(recipeMaster).toContain("useSaveRecipeComponents");
    expect(recipesRoute).toContain("<IngredientRows");
    expect(recipesRoute).toContain("saveComponents.mutateAsync");
  });
});
