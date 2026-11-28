import { describe, expect, it } from "vitest";
import { recipeCommandError } from "../recipe-command-error";
import { prepareRecipeSheet } from "../recipe-engine";
describe("recipe backend installation errors", () => {
  it("explains the shared manual/import deployment requirement without losing the draft", () => {
    expect(
      recipeCommandError({
        code: "PGRST202",
        message:
          "Could not find the function public.neo_recipe_sheet_save(_attempt, _components, _recipe) in the schema cache",
      }).message,
    ).toContain("Manual entry and spreadsheet import");
  });
  it("preserves genuine validation and permission errors", () => {
    expect(
      recipeCommandError({ code: "42501", message: "Not permitted to save recipes" }).message,
    ).toBe("Not permitted to save recipes");
  });
});
describe("direct-sale imports", () => {
  const masters = {
    menuItems: [{ id: "menu", name: "Heineken" }],
    stockItems: [{ id: "stock", name: "Heineken 330ml", sku: "HK" }],
    subRecipes: [],
    stations: [],
  };
  const row = {
    recipe_name: "Heineken",
    menu_item: "menu",
    recipe_type: "direct_sale",
    yield_quantity: "1",
    yield_unit: "bottle",
    output_stock_item: "HK",
  };
  it("uses the same direct-sale header as manual entry without a second consumption component", () => {
    const group = prepareRecipeSheet([row], masters)[0]!;
    expect(group.errors).toEqual([]);
    expect(group.recipe).toMatchObject({
      recipeType: "direct_sale",
      menuItemId: "menu",
      outputStockItemId: "stock",
      components: [],
    });
  });
  it("refuses missing stock mapping or conflicting ingredient rows", () => {
    expect(
      prepareRecipeSheet([{ ...row, output_stock_item: "" }], masters)[0]!.errors.join(" "),
    ).toContain("requires output_stock_item");
    expect(
      prepareRecipeSheet(
        [{ ...row, ingredient: "HK", quantity: "1", unit: "bottle" }],
        masters,
      )[0]!.errors.join(" "),
    ).toContain("remove ingredient rows");
  });
  it("keeps identical drink names separate when their explicit menu IDs differ",()=>{
    const groups=prepareRecipeSheet([row,{...row,menu_item:"menu-2"}],{
      ...masters,menuItems:[{id:"menu",name:"Heineken"},{id:"menu-2",name:"Heineken"}],
    });
    expect(groups).toHaveLength(2);
    expect(groups.map(g=>g.recipe.menuItemId)).toEqual(["menu","menu-2"]);
    expect(groups.every(g=>g.errors.length===0)).toBe(true);
  });
  it("inherits only a visible valid menu station when the import leaves station blank",()=>{
    const withStation={...masters,menuItems:[{id:"menu",name:"Heineken",station_id:"bar"}],stations:[{id:"bar",name:"Main Bar"}]};
    expect(prepareRecipeSheet([row],withStation)[0]!.recipe.stationId).toBe("bar");
    expect(prepareRecipeSheet([row],{...withStation,stations:[]})[0]!.errors.join(" ")).toContain("Menu production station");
  });
});
