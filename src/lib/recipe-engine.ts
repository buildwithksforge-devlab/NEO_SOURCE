/**
 * Deterministic recipe expansion.
 *
 * This module mirrors, in TypeScript, exactly what `public.recipe_expand_to_stock`
 * does in the database: it exists for the per-unit preview shown in the recipe
 * editor and for regression tests. It is NOT a second inventory engine — no
 * stock is ever moved here. All stock movement stays with the canonical
 * `inventory_apply_movement` ledger, called from
 * `inventory_consume_order_item_core`.
 *
 * Rules (identical on both sides):
 *   batches                    = quantity sold / recipe yield quantity
 *   component absolute qty     = ingredient quantity × batches × (1 + waste%/100)
 *   sub-recipe batches         = convert(qty, ingredient unit → sub yield unit) / sub yield qty
 *   sub-recipes resolve recursively to raw stock items (never double deducted)
 *   a cycle, an inactive recipe, a bad yield or a missing unit conversion is an
 *   error — never a silent or partial deduction.
 */

export type RecipeComponentType = "stock_item" | "sub_recipe";

export type RecipeIngredient = {
  id: string;
  component_type: RecipeComponentType;
  ingredient_name?: string | null;
  stock_item_id?: string | null;
  sub_recipe_id?: string | null;
  quantity: number;
  unit: string;
  waste_allowance?: number | null;
};

export type RecipeRecord = {
  id: string;
  name?: string | null;
  recipe_code?: string | null;
  recipe_type: "menu_item" | "sub_recipe";
  status: string;
  yield_quantity: number;
  yield_unit: string;
  ingredients: RecipeIngredient[];
};

/**
 * One deducted line. `kind` separates the quantity a sale actually uses from
 * the wastage allowance, so a whole-unit item never becomes 1.02 pc: the used
 * quantity stays whole and the wastage is its own whole entry.
 */
export type ExpandedComponent = {
  stockItemId: string;
  quantity: number;
  unit: string;
  kind: "use" | "waste";
};

export class RecipeEngineError extends Error {
  readonly code:
    | "cycle"
    | "missing-recipe"
    | "inactive-recipe"
    | "bad-yield"
    | "missing-conversion"
    | "unresolved-ingredient"
    | "too-deep";

  constructor(code: RecipeEngineError["code"], message: string) {
    super(message);
    this.name = "RecipeEngineError";
    this.code = code;
  }
}

/** Canonical unit factors, matching the seeded `uom_units` families. */
const UNIT_BASE: Record<string, { base: string; factor: number }> = {
  g: { base: "g", factor: 1 },
  gram: { base: "g", factor: 1 },
  grams: { base: "g", factor: 1 },
  kg: { base: "g", factor: 1000 },
  mg: { base: "g", factor: 0.001 },
  ml: { base: "ml", factor: 1 },
  l: { base: "ml", factor: 1000 },
  litre: { base: "ml", factor: 1000 },
  litres: { base: "ml", factor: 1000 },
  cl: { base: "ml", factor: 10 },
  piece: { base: "piece", factor: 1 },
  pieces: { base: "piece", factor: 1 },
  pc: { base: "piece", factor: 1 },
  pcs: { base: "piece", factor: 1 },
  unit: { base: "piece", factor: 1 },
  units: { base: "piece", factor: 1 },
  each: { base: "piece", factor: 1 },
  portion: { base: "portion", factor: 1 },
  portions: { base: "portion", factor: 1 },
};

/**
 * Units are typed by people, so the same unit arrives as "pc", "PCS(Piece)",
 * "Bottle " or "Piece(PC)". Everything is folded to one spelling before it is
 * compared, otherwise a stray capital or bracket silently skips whole-unit
 * rounding and the ledger shows 1.02 buns.
 */
const norm = (u: string | null | undefined): string => {
  const raw = (u ?? "").trim().toLowerCase();
  const outside = raw.replace(/\(.*?\)/g, "").trim();
  const inside = raw.match(/\(([^)]+)\)/)?.[1]?.trim() ?? "";
  const pick = outside || inside;
  return pick.replace(/[^a-z]/g, "");
};

/** Convert, or fail loudly. Never guesses across unit families. */
export function convertStrict(qty: number, from: string, to: string): number {
  const f = norm(from);
  const t = norm(to);
  if (!f || !t || f === t) return qty;
  const a = UNIT_BASE[f];
  const b = UNIT_BASE[t];
  if (!a || !b || a.base !== b.base || b.factor === 0) {
    throw new RecipeEngineError("missing-conversion", `No unit conversion from ${from} to ${to}`);
  }
  return (qty * a.factor) / b.factor;
}

export function canConvert(from: string, to: string): boolean {
  try {
    convertStrict(1, from, to);
    return true;
  } catch {
    return false;
  }
}

/**
 * Expand a recipe to raw stock components.
 * @param batches how many full recipe yields are being produced/sold.
 */
export function expandRecipeToStock(
  recipes: Map<string, RecipeRecord>,
  recipeId: string,
  batches: number,
  path: string[] = [],
): ExpandedComponent[] {
  if (path.includes(recipeId)) {
    throw new RecipeEngineError("cycle", `Recipe cycle detected at ${recipeId}`);
  }
  if (path.length > 10) throw new RecipeEngineError("too-deep", "Recipe nesting too deep");

  const recipe = recipes.get(recipeId);
  if (!recipe) throw new RecipeEngineError("missing-recipe", `Recipe ${recipeId} not found`);
  if (recipe.status !== "active") {
    throw new RecipeEngineError("inactive-recipe", `Recipe ${recipe.name ?? recipeId} is not active`);
  }
  if (!(recipe.yield_quantity > 0)) {
    throw new RecipeEngineError("bad-yield", `Recipe ${recipe.name ?? recipeId} has no usable yield quantity`);
  }

  const out: ExpandedComponent[] = [];
  for (const ing of recipe.ingredients) {
    const use = Number(ing.quantity ?? 0) * batches;
    const waste = use * (Number(ing.waste_allowance ?? 0) / 100);
    if (!use && !waste) continue;
    if (ing.component_type === "sub_recipe") {
      const subId = ing.sub_recipe_id ?? "";
      const sub = recipes.get(subId);
      if (!sub) throw new RecipeEngineError("missing-recipe", `Sub-recipe ${subId || "(unset)"} not found`);
      if (!(sub.yield_quantity > 0)) {
        throw new RecipeEngineError("bad-yield", `Sub-recipe ${sub.name ?? subId} has no usable yield quantity`);
      }
      const needed = convertStrict(use + waste, ing.unit || sub.yield_unit, sub.yield_unit);
      out.push(...expandRecipeToStock(recipes, subId, needed / sub.yield_quantity, [...path, recipeId]));
    } else {
      const itemId = ing.stock_item_id ?? "";
      if (!itemId) {
        throw new RecipeEngineError(
          "unresolved-ingredient",
          `Recipe ingredient "${ing.ingredient_name ?? "unnamed"}" does not resolve to a stock item`,
        );
      }
      if (use) out.push({ stockItemId: itemId, quantity: use, unit: ing.unit, kind: "use" });
      if (waste) out.push({ stockItemId: itemId, quantity: waste, unit: ing.unit, kind: "waste" });
    }
  }
  return out;
}

/**
 * Units counted as whole things. A bottle, a bun or a ream cannot be issued in
 * fractions, so a waste allowance must never produce 1.02 pc — mirrors
 * `public.inventory_round_for_unit`.
 */
const DISCRETE_UNITS = new Set([
  "pc", "pcs", "piece", "pieces", "each", "unit", "units",
  "bottle", "bottles", "can", "cans", "carton", "cartons", "crate", "crates",
  "ream", "reams", "roll", "rolls", "bag", "bags", "tin", "tins", "jar", "jars",
  "set", "sets", "pack", "packs", "box", "boxes", "sachet", "sachets", "tray", "trays",
  "bun", "buns", "loaf", "loaves", "dozen", "dozens", "tot", "tots",
  "glass", "glasses", "plate", "plates", "bar", "bars", "tube", "tubes", "pair", "pairs",
  "egg", "eggs",
]);

/** True when the unit counts whole things that can never be issued in fractions. */
export function isDiscreteUnit(unit: string | null | undefined): boolean {
  return DISCRETE_UNITS.has(norm(unit));
}

/**
 * The recipe editor rule: a whole-unit ingredient must carry a whole number.
 * Returns the sentence to show, or null when the row is acceptable.
 */
export function wholeUnitIssue(quantity: number, unit: string | null | undefined): string | null {
  if (!isDiscreteUnit(unit)) return null;
  if (!Number.isFinite(quantity)) return null;
  if (Number.isInteger(quantity)) return null;
  return `${unit} are counted whole — enter a whole number such as ${Math.max(1, Math.round(quantity))}.`;
}

/** Round a quantity the way the inventory ledger will store it. */
export function roundForUnit(qty: number, unit: string): number {
  return isDiscreteUnit(unit) ? Math.ceil(qty) : qty;
}

/**
 * Aggregate per stock item so a component reached twice is deducted once.
 * Used quantities and wastage stay apart, so each is rounded on its own and a
 * whole-unit item is never turned into a fraction by a wastage percentage.
 */
export function aggregateComponents(
  components: ExpandedComponent[],
  baseUnitOf: (stockItemId: string) => string,
): ExpandedComponent[] {
  const totals = new Map<string, number>();
  for (const c of components) {
    const base = baseUnitOf(c.stockItemId);
    const qty = convertStrict(c.quantity, c.unit, base);
    const key = `${c.kind}|${c.stockItemId}`;
    totals.set(key, (totals.get(key) ?? 0) + qty);
  }
  return [...totals.entries()]
    .map(([key, quantity]) => {
      const [kind, stockItemId] = key.split("|") as ["use" | "waste", string];
      return {
        stockItemId,
        quantity: roundForUnit(quantity, baseUnitOf(stockItemId)),
        unit: baseUnitOf(stockItemId),
        kind,
      };
    })
    .filter((c) => c.quantity > 0);
}

/** Consumption for selling `soldQuantity` units of a menu recipe. */
export function consumptionForSale(
  recipes: Map<string, RecipeRecord>,
  recipeId: string,
  soldQuantity: number,
  baseUnitOf: (stockItemId: string) => string,
): ExpandedComponent[] {
  const recipe = recipes.get(recipeId);
  if (!recipe) throw new RecipeEngineError("missing-recipe", `Recipe ${recipeId} not found`);
  if (!(recipe.yield_quantity > 0)) {
    throw new RecipeEngineError("bad-yield", `Recipe ${recipe.name ?? recipeId} has no usable yield quantity`);
  }
  const batches = soldQuantity / recipe.yield_quantity;
  return aggregateComponents(expandRecipeToStock(recipes, recipeId, batches), baseUnitOf);
}

/** Per-yield-unit usage shown in the editor preview (no stock is touched). */
export function perUnitPreview(recipe: RecipeRecord): { label: string; quantity: number; unit: string }[] {
  if (!(recipe.yield_quantity > 0)) return [];
  return recipe.ingredients.map((ing) => ({
    label: ing.ingredient_name ?? "Component",
    quantity: (Number(ing.quantity ?? 0) * (1 + Number(ing.waste_allowance ?? 0) / 100)) / recipe.yield_quantity,
    unit: ing.unit,
  }));
}

export const RECIPE_UNITS = ["g", "kg", "ml", "L", "piece", "portion"] as const;
