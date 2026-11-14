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

export type RecipeSheetMaster = Record<string, unknown>;
export type RecipeSheetGroup = {
  key: string;
  rowNumbers: number[];
  errors: string[];
  recipe: {
    name: string;
    recipeCode: string | null;
    recipeType: "menu_item" | "sub_recipe";
    menuItemId: string | null;
    stationId: string | null;
    outputStockItemId: string | null;
    yieldQuantity: number;
    yieldUnit: string;
    components: {
      componentType: RecipeComponentType;
      stockItemId: string | null;
      subRecipeId: string | null;
      name: string;
      quantity: number;
      unit: string;
      wasteAllowance: number;
    }[];
    imported: true;
  };
};

/** One ingredient per source row; one validated atomic save per dish/batch. */
export function prepareRecipeSheet(
  rows: readonly Record<string, string>[],
  masters: {
    menuItems: readonly RecipeSheetMaster[];
    stockItems: readonly RecipeSheetMaster[];
    subRecipes: readonly RecipeSheetMaster[];
    stations: readonly RecipeSheetMaster[];
  },
): RecipeSheetGroup[] {
  const norm = (v: unknown) =>
    String(v ?? "")
      .trim()
      .toLocaleLowerCase();
  const field = (row: Record<string, string>, ...keys: string[]) => {
    const headers = new Map(
      Object.entries(row).map(([k, v]) => [k.toLowerCase().replace(/[^a-z0-9]/g, ""), v.trim()]),
    );
    return keys.map((k) => headers.get(k.replace(/[^a-z0-9]/g, ""))).find(Boolean) ?? "";
  };
  const groups = new Map<string, RecipeSheetGroup>();
  const headers = new Map<string, Record<string, string>>();
  let unassignedRows = false;
  const resolve = (
    raw: string,
    source: readonly RecipeSheetMaster[],
    columns: string[],
    label: string,
    errors: string[],
  ): string | null => {
    if (!raw) {
      errors.push(`${label} is required.`);
      return null;
    }
    const matches = source.filter((r) => columns.some((c) => norm(r[c]) === norm(raw)));
    if (matches.length !== 1) {
      errors.push(
        `${label} “${raw}” ${matches.length ? "is ambiguous; use its code or ID" : "does not match an existing in-scope record"}.`,
      );
      return null;
    }
    return String(matches[0]!['id']);
  };
  rows.forEach((row, index) => {
    const values = {
      code: field(row, "recipe_code"),
      name: field(row, "recipe_name", "dish_name", "dish"),
      menu: field(row, "menu_item", "menu_item_name"),
      type: field(row, "recipe_type"),
      yield: field(row, "yield_quantity"),
      yieldUnit: field(row, "yield_unit"),
      station: field(row, "station"),
      output: field(row, "output_stock_item"),
    };
    let key = values.code
      ? `code:${norm(values.code)}`
      : norm(values.name || values.menu) || `missing-identity-row-${index + 2}`;
    const compatible = [...headers.entries()].filter(
      ([, h]) =>
        (!values.code || !h['code'] || norm(values.code) === norm(h['code'])) &&
        ((values.code && h['code'] && norm(values.code) === norm(h['code'])) ||
          (values.name && h['name'] && norm(values.name) === norm(h['name'])) ||
          (values.menu && h['menu'] && norm(values.menu) === norm(h['menu']))),
    );
    if (!groups.has(key) && compatible.length === 1) key = compatible[0]![0];
    if (!values.code && compatible.length > 1) {
      compatible.forEach(([k]) =>
        groups
          .get(k)!
          .errors.push(`Row ${index + 2}: recipe identity is ambiguous; supply the recipe code.`),
      );
      key = `ambiguous-row-${index + 2}`;
    }
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        rowNumbers: [],
        errors: [],
        recipe: {
          name: "",
          recipeCode: null,
          recipeType: "menu_item",
          menuItemId: null,
          stationId: null,
          outputStockItemId: null,
          yieldQuantity: NaN,
          yieldUnit: "",
          components: [],
          imported: true,
        },
      };
      groups.set(key, group);
      headers.set(key, {});
    }
    const head = headers.get(key)!;
    for (const [name, value] of Object.entries(values)) {
      if (value && head[name] && norm(head[name]) !== norm(value))
        group.errors.push(`Row ${index + 2}: conflicting ${name} within this recipe.`);
      if (value && !head[name]) head[name] = value;
    }
    group.rowNumbers.push(index + 2);
    const at = `Row ${index + 2}`;
    if (!values.code && !values.name && !values.menu) {
      unassignedRows = true;
      group.errors.push(`${at}: repeat the dish name or recipe code on every ingredient row.`);
    }
    const ingredient = field(
      row,
      "ingredient",
      "ingredient_name",
      "stock_item",
      "stock_sku",
      "sub_recipe",
    );
    const rawType = field(row, "component_type") || "stock_item";
    const componentType = rawType === "sub_recipe" ? "sub_recipe" : "stock_item";
    if (!["stock_item", "sub_recipe"].includes(rawType))
      group.errors.push(`${at}: component_type must be stock_item or sub_recipe.`);
    const quantity = Number(field(row, "quantity", "ingredient_quantity"));
    const unit = field(row, "unit", "ingredient_unit");
    const wasteRaw = field(row, "waste_allowance");
    const waste = wasteRaw ? Number(wasteRaw) : 0;
    if (!Number.isFinite(quantity) || quantity <= 0)
      group.errors.push(`${at}: ingredient quantity must be positive and finite.`);
    if (!unit) group.errors.push(`${at}: ingredient unit is required.`);
    const whole = wholeUnitIssue(quantity, unit);
    if (whole) group.errors.push(`${at}: ${whole}`);
    if (!Number.isFinite(waste) || waste < 0)
      group.errors.push(`${at}: waste allowance must be finite and nonnegative.`);
    const componentErrors: string[] = [];
    const componentId = resolve(
      ingredient,
      componentType === "stock_item" ? masters.stockItems : masters.subRecipes,
      componentType === "stock_item" ? ["id", "sku", "name"] : ["id", "recipe_code", "name"],
      `${at} component`,
      componentErrors,
    );
    group.errors.push(...componentErrors);
    if (
      componentId &&
      group.recipe.components.some(
        (c) =>
          c.componentType === componentType &&
          (c.stockItemId === componentId || c.subRecipeId === componentId),
      )
    )
      group.errors.push(`${at}: duplicate component; review and combine quantities explicitly.`);
    group.recipe.components.push({
      componentType,
      stockItemId: componentType === "stock_item" ? componentId : null,
      subRecipeId: componentType === "sub_recipe" ? componentId : null,
      name: ingredient,
      quantity,
      unit,
      wasteAllowance: waste,
    });
  });
  for (const group of groups.values()) {
    if (unassignedRows)
      group.errors.push(
        "Resolve unassigned ingredient rows before saving any dish from this sheet.",
      );
    const h = headers.get(group.key)!;
    const r = group.recipe;
    r.name = h['name'] || h['menu'] || h['code'] || "";
    r.recipeCode = h['code'] || null;
    if (h['type'] && !["menu_item", "sub_recipe"].includes(h['type']))
      group.errors.push(
        "recipe_type must be menu_item or sub_recipe; use the direct-sale editor for packaged goods.",
      );
    r.recipeType = h['type'] === "sub_recipe" ? "sub_recipe" : "menu_item";
    r.yieldQuantity = Number(h['yield']);
    r.yieldUnit = h['yieldUnit'] || "";
    if (!Number.isFinite(r.yieldQuantity) || r.yieldQuantity <= 0)
      group.errors.push("Recipe yield must be supplied as a positive finite number.");
    if (!r.yieldUnit) group.errors.push("Recipe yield unit is required.");
    if (r.recipeType === "menu_item")
      r.menuItemId = resolve(
        h['menu'] || h['name'] || "",
        masters.menuItems,
        ["id", "sku", "name"],
        "Menu item",
        group.errors,
      );
    else if (h['menu'])
      group.errors.push("A prepared batch/sub-recipe must not attach to a menu item.");
    if (h['station'])
      r.stationId = resolve(
        h['station'],
        masters.stations,
        ["id", "code", "name"],
        "Production station",
        group.errors,
      );
    if (h['output'])
      r.outputStockItemId = resolve(
        h['output'],
        masters.stockItems,
        ["id", "sku", "name"],
        "Output stock item",
        group.errors,
      );
    group.errors = [...new Set(group.errors)];
  }
  return [...groups.values()];
}

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
    | "bad-quantity"
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
  if (!Number.isFinite(qty))
    throw new RecipeEngineError("bad-quantity", "Recipe quantity must be finite");
  const f = norm(from);
  const t = norm(to);
  if (!f || !t)
    throw new RecipeEngineError("missing-conversion", "Both source and stock units are required");
  if (f === t) return qty;
  const a = UNIT_BASE[f];
  const b = UNIT_BASE[t];
  if (!a || !b || a.base !== b.base || b.factor === 0) {
    throw new RecipeEngineError("missing-conversion", `No unit conversion from ${from} to ${to}`);
  }
  const result = (qty * a.factor) / b.factor;
  if (!Number.isFinite(result))
    throw new RecipeEngineError("bad-quantity", "Converted recipe quantity is too large");
  return result;
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
  if (!Number.isFinite(batches) || batches < 0)
    throw new RecipeEngineError("bad-quantity", "Recipe batches must be finite and non-negative");
  if (path.includes(recipeId)) {
    throw new RecipeEngineError("cycle", `Recipe cycle detected at ${recipeId}`);
  }
  if (path.length > 10) throw new RecipeEngineError("too-deep", "Recipe nesting too deep");

  const recipe = recipes.get(recipeId);
  if (!recipe) throw new RecipeEngineError("missing-recipe", `Recipe ${recipeId} not found`);
  if (recipe.status !== "active") {
    throw new RecipeEngineError(
      "inactive-recipe",
      `Recipe ${recipe.name ?? recipeId} is not active`,
    );
  }
  if (!Number.isFinite(recipe.yield_quantity) || !(recipe.yield_quantity > 0)) {
    throw new RecipeEngineError(
      "bad-yield",
      `Recipe ${recipe.name ?? recipeId} has no usable yield quantity`,
    );
  }

  const out: ExpandedComponent[] = [];
  for (const ing of recipe.ingredients) {
    const quantity = Number(ing.quantity);
    const allowance = Number(ing.waste_allowance ?? 0);
    if (
      ing.quantity == null ||
      !Number.isFinite(quantity) ||
      quantity < 0 ||
      !Number.isFinite(allowance) ||
      allowance < 0
    ) {
      throw new RecipeEngineError(
        "bad-quantity",
        "Ingredient quantity and waste allowance must be finite and non-negative",
      );
    }
    if (!["stock_item", "sub_recipe"].includes(ing.component_type)) {
      throw new RecipeEngineError("unresolved-ingredient", "Unsupported recipe component type");
    }
    const use = Number(ing.quantity ?? 0) * batches;
    const waste = use * (Number(ing.waste_allowance ?? 0) / 100);
    if (!Number.isFinite(use) || !Number.isFinite(waste))
      throw new RecipeEngineError("bad-quantity", "Expanded recipe quantity is too large");
    if (!use && !waste) continue;
    if (ing.component_type === "sub_recipe") {
      const subId = ing.sub_recipe_id ?? "";
      const sub = recipes.get(subId);
      if (!sub)
        throw new RecipeEngineError("missing-recipe", `Sub-recipe ${subId || "(unset)"} not found`);
      if (!Number.isFinite(sub.yield_quantity) || !(sub.yield_quantity > 0)) {
        throw new RecipeEngineError(
          "bad-yield",
          `Sub-recipe ${sub.name ?? subId} has no usable yield quantity`,
        );
      }
      const needed = convertStrict(use + waste, ing.unit || sub.yield_unit, sub.yield_unit);
      out.push(
        ...expandRecipeToStock(recipes, subId, needed / sub.yield_quantity, [...path, recipeId]),
      );
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
  "pc",
  "pcs",
  "piece",
  "pieces",
  "each",
  "unit",
  "units",
  "bottle",
  "bottles",
  "can",
  "cans",
  "carton",
  "cartons",
  "crate",
  "crates",
  "ream",
  "reams",
  "roll",
  "rolls",
  "bag",
  "bags",
  "tin",
  "tins",
  "jar",
  "jars",
  "set",
  "sets",
  "pack",
  "packs",
  "box",
  "boxes",
  "sachet",
  "sachets",
  "tray",
  "trays",
  "bun",
  "buns",
  "loaf",
  "loaves",
  "dozen",
  "dozens",
  "tot",
  "tots",
  "glass",
  "glasses",
  "plate",
  "plates",
  "bar",
  "bars",
  "tube",
  "tubes",
  "pair",
  "pairs",
  "egg",
  "eggs",
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
  if (!Number.isFinite(quantity) || quantity < 0)
    return "Enter a finite, non-negative ingredient quantity.";
  if (!isDiscreteUnit(unit)) return null;
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
    if (c.quantity < 0)
      throw new RecipeEngineError("bad-quantity", "Consumption components cannot be negative");
    const base = baseUnitOf(c.stockItemId);
    const qty = convertStrict(c.quantity, c.unit, base);
    const key = `${c.kind}|${c.stockItemId}`;
    const total = (totals.get(key) ?? 0) + qty;
    if (!Number.isFinite(total))
      throw new RecipeEngineError("bad-quantity", "Aggregated recipe quantity is too large");
    totals.set(key, total);
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
  if (!Number.isFinite(recipe.yield_quantity) || !(recipe.yield_quantity > 0)) {
    throw new RecipeEngineError(
      "bad-yield",
      `Recipe ${recipe.name ?? recipeId} has no usable yield quantity`,
    );
  }
  if (!Number.isFinite(soldQuantity) || soldQuantity < 0)
    throw new RecipeEngineError("bad-quantity", "Sold quantity must be finite and non-negative");
  const batches = soldQuantity / recipe.yield_quantity;
  return aggregateComponents(expandRecipeToStock(recipes, recipeId, batches), baseUnitOf);
}

/** Per-yield-unit usage shown in the editor preview (no stock is touched). */
export function perUnitPreview(
  recipe: RecipeRecord,
): { label: string; quantity: number; unit: string }[] {
  if (!(recipe.yield_quantity > 0)) return [];
  return recipe.ingredients.map((ing) => ({
    label: ing.ingredient_name ?? "Component",
    quantity:
      (Number(ing.quantity ?? 0) * (1 + Number(ing.waste_allowance ?? 0) / 100)) /
      recipe.yield_quantity,
    unit: ing.unit,
  }));
}

export const RECIPE_UNITS = ["g", "kg", "ml", "L", "piece", "portion"] as const;
