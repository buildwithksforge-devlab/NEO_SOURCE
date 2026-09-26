/**
 * Recipe master data: recipes (menu-item and batch/sub-recipe), their
 * components, and the link between a menu item and its recipe.
 *
 * Reads and writes go through the ordinary Supabase client so tenant/property
 * RLS applies unchanged. No stock is moved here — consumption stays with the
 * canonical ledger path (`inventory_consume_order_item_core`).
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter, useWriteBranchId } from "@/lib/branch-filter";
import { wholeUnitIssue } from "@/lib/recipe-engine";
import type { RecipeIngredient, RecipeRecord } from "@/lib/recipe-engine";

type Row = Record<string, unknown>;

const RECIPE_SELECT =
  "id, name, recipe_code, recipe_type, status, version, menu_item_id, station_id, output_stock_item_id, branch_id, yield_quantity, yield_unit, prep_target_minutes, preparation_steps, waste_allowance, menu_items(name), operational_stations(name), output_stock_item:stock_items!recipes_output_stock_item_id_fkey(id, name, sku, base_unit, container_type, container_volume_ml, stock_locations:stock_locations!stock_items_default_location_id_fkey(name)), recipe_ingredients!recipe_ingredients_recipe_id_fkey(id, component_type, ingredient_name, stock_item_id, sub_recipe_id, quantity, unit, waste_allowance)";

/**
 * A direct-sale mapping is a complete configuration with no ingredient rows:
 * one sale takes one container of a finished packaged product. Screens must
 * say so explicitly rather than reporting "no components", which reads broken.
 */
export type DirectStockMapping = {
  stockItemId: string;
  stockItemName: string;
  sku: string | null;
  unit: string;
  containerType: string | null;
  containerVolumeMl: number | null;
  perSale: number;
  storeName: string | null;
};

export function directStockMapping(row: Row | null | undefined): DirectStockMapping | null {
  if (!row) return null;
  if (String(row["recipe_type"] ?? "") !== "direct_sale") return null;
  const item = row["output_stock_item"] as Row | null;
  if (!item) return null;
  const location = item["stock_locations"] as Row | null;
  return {
    stockItemId: String(item["id"]),
    stockItemName: String(item["name"] ?? "Stock item"),
    sku: (item["sku"] as string | null) ?? null,
    unit: String(row["yield_unit"] ?? item["base_unit"] ?? "unit"),
    containerType: (item["container_type"] as string | null) ?? null,
    containerVolumeMl: item["container_volume_ml"] == null ? null : Number(item["container_volume_ml"]),
    perSale: Number(row["yield_quantity"] ?? 1) || 1,
    storeName: (location?.["name"] as string | null) ?? null,
  };
}

/** Every recipe in scope — menu-item recipes and batch/sub-recipes alike. */
export function useRecipeCatalogue() {
  const { organizationId } = useAuth();
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["kitchen", "recipe-catalogue", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        supabase.from("recipes").select(RECIPE_SELECT),
        "recipes",
      ).order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });
}

/** Shape a catalogue row for the deterministic engine. */
export function toRecipeRecord(row: Row): RecipeRecord {
  const ingredients = ((row["recipe_ingredients"] as Row[] | null) ?? []).map(
    (i): RecipeIngredient => ({
      id: String(i["id"]),
      component_type: (String(i["component_type"] ?? "stock_item") === "sub_recipe"
        ? "sub_recipe"
        : "stock_item"),
      ingredient_name: (i["ingredient_name"] as string | null) ?? null,
      stock_item_id: (i["stock_item_id"] as string | null) ?? null,
      sub_recipe_id: (i["sub_recipe_id"] as string | null) ?? null,
      quantity: Number(i["quantity"] ?? 0),
      unit: String(i["unit"] ?? ""),
      waste_allowance: Number(i["waste_allowance"] ?? 0),
    }),
  );
  return {
    id: String(row["id"]),
    name: (row["name"] as string | null) ?? null,
    recipe_code: (row["recipe_code"] as string | null) ?? null,
    recipe_type: String(row["recipe_type"] ?? "menu_item") === "sub_recipe" ? "sub_recipe" : "menu_item",
    status: String(row["status"] ?? "draft"),
    yield_quantity: Number(row["yield_quantity"] ?? 0),
    yield_unit: String(row["yield_unit"] ?? ""),
    ingredients,
  };
}

export function recipeMap(rows: Row[]): Map<string, RecipeRecord> {
  return new Map(rows.map((r) => [String(r["id"]), toRecipeRecord(r)]));
}

function useRecipeInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["kitchen", "recipe-catalogue"] });
    void qc.invalidateQueries({ queryKey: ["kitchen", "recipes"] });
    void qc.invalidateQueries({ queryKey: ["pos", "menu"] });
  };
}

export type RecipeSaveInput = {
  id?: string | null;
  name: string;
  recipeCode?: string | null;
  recipeType: "menu_item" | "sub_recipe" | "direct_sale";
  menuItemId?: string | null;
  stationId?: string | null;
  /**
   * The stock item this recipe *is*.
   *
   * For a batch sub-recipe it is the produced batch (Pizza Sauce 12 L), so a
   * sale of a dish that uses it deducts the batch once instead of re-deducting
   * the raw ingredients production already consumed. For a direct-sale product
   * it is the item sold straight off the shelf.
   */
  outputStockItemId?: string | null;
  yieldQuantity: number;
  yieldUnit: string;
  prepTargetMinutes?: number | null;
  preparationSteps?: string | null;
  status?: string;
};

export function useSaveRecipeMaster() {
  const { organizationId, user } = useAuth();
  const branchId = useWriteBranchId();
  const invalidate = useRecipeInvalidate();
  return useMutation({
    mutationFn: async (input: RecipeSaveInput) => {
      if (!input.name.trim()) throw new Error("A recipe name is required.");
      if (!(input.yieldQuantity > 0)) throw new Error("Yield quantity must be greater than zero.");
      if (!input.yieldUnit.trim()) throw new Error("A yield unit is required.");
      if (input.recipeType !== "sub_recipe" && !input.menuItemId) {
        throw new Error("A menu-item or direct-sale recipe must be linked to a menu item.");
      }
      if (input.recipeType === "direct_sale" && !input.outputStockItemId) {
        throw new Error("A direct-sale product must point at the stock item it sells.");
      }
      const payload = {
        organization_id: organizationId as string,
        branch_id: branchId,
        name: input.name.trim(),
        recipe_code: input.recipeCode?.trim() || null,
        recipe_type: input.recipeType,
        menu_item_id: input.recipeType === "sub_recipe" ? null : input.menuItemId,
        station_id: input.stationId ?? null,
        output_stock_item_id: input.outputStockItemId ?? null,
        yield_quantity: input.yieldQuantity,
        yield_unit: input.yieldUnit.trim(),
        prep_target_minutes: input.prepTargetMinutes ?? null,
        preparation_steps: input.preparationSteps ?? null,
        status: input.status ?? "draft",
        created_by: user?.id ?? null,
      };

      if (input.id) {
        const { error } = await supabase.from("recipes").update(payload as never).eq("id", input.id);
        if (error) throw new Error(error.message);
        if (input.menuItemId) {
          await bindMenuItemConsumption(input.menuItemId, input.recipeType, input.outputStockItemId);
        }
        return input.id;
      }
      const { data, error } = await supabase
        .from("recipes")
        .insert(payload as never)
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      if (input.menuItemId) {
        await bindMenuItemConsumption(input.menuItemId, input.recipeType, input.outputStockItemId);
      }
      return String((data as unknown as Row)["id"]);
    },
    onSuccess: () => {
      toast.success("Recipe saved.");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export type ComponentSaveInput = {
  recipeId: string;
  componentType: "stock_item" | "sub_recipe";
  stockItemId?: string | null;
  subRecipeId?: string | null;
  name: string;
  quantity: number;
  unit: string;
  wasteAllowance?: number;
};

export function useSaveRecipeComponent() {
  const { organizationId } = useAuth();
  const invalidate = useRecipeInvalidate();
  return useMutation({
    mutationFn: async (input: ComponentSaveInput) => {
      if (!(input.quantity > 0)) throw new Error("Component quantity must be greater than zero.");
      if (!input.unit.trim()) throw new Error("A component unit is required.");
      // Buns, bottles, cans and eggs are counted whole: a fraction here would
      // reach the ledger as -8.08 pc.
      const whole = wholeUnitIssue(input.quantity, input.unit);
      if (whole) throw new Error(whole);
      if (input.componentType === "stock_item" && !input.stockItemId) {
        throw new Error("Choose the stock item this component consumes.");
      }
      if (input.componentType === "sub_recipe" && !input.subRecipeId) {
        throw new Error("Choose the prepared sub-recipe this component consumes.");
      }
      if (input.componentType === "sub_recipe" && input.subRecipeId === input.recipeId) {
        throw new Error("A recipe cannot contain itself.");
      }
      const { error } = await supabase.from("recipe_ingredients").insert({
        organization_id: organizationId as string,
        recipe_id: input.recipeId,
        component_type: input.componentType,
        stock_item_id: input.componentType === "stock_item" ? input.stockItemId : null,
        sub_recipe_id: input.componentType === "sub_recipe" ? input.subRecipeId : null,
        ingredient_name: input.name,
        quantity: input.quantity,
        unit: input.unit.trim(),
        waste_allowance: input.wasteAllowance ?? 0,
      } as never);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Component added.");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRemoveRecipeComponent() {
  const invalidate = useRecipeInvalidate();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("recipe_ingredients").delete().eq("id", id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Component removed.");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Bind a menu item to the recipe that was just created, approved or attached.
 *
 * Creating a menu item first and a recipe second is the safe order, so the
 * last step must never be a manual one: as soon as a recipe names a menu item,
 * that item is switched to consume through the recipe (or through its stock
 * item for a direct-sale product). Without this a sale finds a recipe but a
 * menu item still marked "no stock consumption" and deducts nothing.
 */
export async function bindMenuItemConsumption(
  menuItemId: string,
  recipeType: "menu_item" | "direct_sale" | "sub_recipe",
  outputStockItemId?: string | null,
): Promise<void> {
  if (!menuItemId || recipeType === "sub_recipe") return;
  const patch: Record<string, unknown> =
    recipeType === "direct_sale"
      ? { consumption_mode: "direct_stock", ...(outputStockItemId ? { stock_item_id: outputStockItemId } : {}) }
      : { consumption_mode: "recipe" };
  const { error } = await supabase.from("menu_items").update(patch as never).eq("id", menuItemId);
  if (error) throw new Error(error.message);
}

/** Attach an existing menu-item recipe to a menu item from the menu form. */
export function useAttachRecipeToMenuItem() {
  const invalidate = useRecipeInvalidate();
  return useMutation({
    mutationFn: async ({ recipeId, menuItemId }: { recipeId: string; menuItemId: string }) => {
      const { error } = await supabase
        .from("recipes")
        .update({ menu_item_id: menuItemId, recipe_type: "menu_item" } as never)
        .eq("id", recipeId);
      if (error) throw new Error(error.message);
      await bindMenuItemConsumption(menuItemId, "menu_item");
    },
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Active menu-item recipes, labelled with their yield, for the menu form. */
export function useMenuRecipeOptions() {
  const catalogue = useRecipeCatalogue();
  const options = ((catalogue.data ?? []) as Row[])
    .filter((r) => String(r["recipe_type"] ?? "menu_item") === "menu_item" && String(r["status"]) === "active")
    .map((r) => ({
      value: String(r["id"]),
      menuItemId: (r["menu_item_id"] as string | null) ?? null,
      label: `${String(r["name"] ?? (r["menu_items"] as Row | null)?.["name"] ?? "Recipe")} · yield ${
        r["yield_quantity"] ?? "—"
      } ${String(r["yield_unit"] ?? "")}`,
    }));
  return { ...catalogue, options };
}

/**
 * Save a whole ingredient sheet in one action.
 *
 * The recipe card is captured as a table — "Add ingredient" appends a row —
 * so the write is a single insert of every row, validated first. A partial
 * sheet is rejected before anything is written: an incomplete recipe must stay
 * a draft that deducts nothing, never a half-saved one.
 */
export function useSaveRecipeComponents() {
  const { organizationId } = useAuth();
  const invalidate = useRecipeInvalidate();
  return useMutation({
    mutationFn: async ({
      recipeId,
      rows,
    }: {
      recipeId: string;
      rows: Omit<ComponentSaveInput, "recipeId">[];
    }) => {
      if (rows.length === 0) return 0;
      rows.forEach((row, index) => {
        const at = `Ingredient ${index + 1}`;
        if (!(row.quantity > 0)) throw new Error(`${at}: quantity must be greater than zero.`);
        if (!row.unit.trim()) throw new Error(`${at}: choose a unit.`);
        if (row.componentType === "stock_item" && !row.stockItemId) {
          throw new Error(`${at}: choose the stock item it consumes.`);
        }
        const whole = wholeUnitIssue(row.quantity, row.unit);
        if (whole) throw new Error(`${at}: ${whole}`);
        if (row.componentType === "sub_recipe" && !row.subRecipeId) {
          throw new Error(`${at}: choose the prepared sub-recipe it consumes.`);
        }
        if (row.componentType === "sub_recipe" && row.subRecipeId === recipeId) {
          throw new Error(`${at}: a recipe cannot contain itself.`);
        }
      });
      const { error } = await supabase.from("recipe_ingredients").insert(
        rows.map((row) => ({
          organization_id: organizationId as string,
          recipe_id: recipeId,
          component_type: row.componentType,
          stock_item_id: row.componentType === "stock_item" ? row.stockItemId : null,
          sub_recipe_id: row.componentType === "sub_recipe" ? row.subRecipeId : null,
          ingredient_name: row.name,
          quantity: row.quantity,
          unit: row.unit.trim(),
          waste_allowance: row.wasteAllowance ?? 0,
        })) as never,
      );
      if (error) throw new Error(error.message);
      return rows.length;
    },
    onSuccess: (count) => {
      if (count) toast.success(count === 1 ? "Ingredient added." : `${count} ingredients added.`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Station consumption-location readiness.
 *
 * A published recipe consumes stock from the store tied to its production
 * station. This read lists every active station in scope and whether that
 * store has been configured, so a gap is visible before a sale fails to post.
 */
export function useStationConsumptionReadiness() {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["kitchen", "station-location-readiness", organizationId, branchId ?? "all"],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_recipe_location_readiness", {
        _branch: branchId ?? null,
      } as never);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as Row[];
    },
  });
}

/** Tie a store/location to the production station that consumes from it. */
export function useSetStationConsumptionLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { locationId: string; stationId: string | null }) => {
      const { error } = await supabase
        .from("stock_locations")
        .update({ station_id: input.stationId } as never)
        .eq("id", input.locationId);
      if (error) throw new Error(error.message);
      return input.locationId;
    },
    onSuccess: () => {
      toast.success("Consumption store updated.");
      void qc.invalidateQueries({ queryKey: ["kitchen", "station-location-readiness"] });
      void qc.invalidateQueries({ queryKey: ["inventory"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Sets the station a recipe is prepared at.
 *
 * The sale of a dish deducts stock from the store bound to its station, so a
 * recipe with no station posts nothing. Existing recipes were captured before
 * stations were configured, so this is the one field the kitchen must be able
 * to correct in place without reopening the whole recipe.
 */
export function useSetRecipeStation() {
  const invalidate = useRecipeInvalidate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { recipeId: string; stationId: string | null }) => {
      const { error } = await supabase
        .from("recipes")
        .update({ station_id: input.stationId } as never)
        .eq("id", input.recipeId);
      if (error) throw new Error(error.message);
      return input.recipeId;
    },
    onSuccess: () => {
      toast.success("Preparing station updated.");
      invalidate();
      void qc.invalidateQueries({ queryKey: ["kitchen", "station-location-readiness"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Create the menu item a new recipe belongs to, in the same step as the recipe.
 *
 * The safe order is menu item first, recipe second, then the item switched to
 * consume through that recipe. Nothing is invented: the selling price and menu
 * category come from the person filling in the form. The item starts with no
 * stock consumption; saving the recipe binds it.
 */
export function useCreateMenuItemForRecipe() {
  const { organizationId, user } = useAuth();
  const branchId = useWriteBranchId();
  return useMutation({
    mutationFn: async (input: {
      name: string;
      categoryId: string;
      price: number;
      stationId?: string | null;
    }) => {
      if (!input.name.trim()) throw new Error("The menu item needs a name.");
      if (!input.categoryId) throw new Error("Choose the menu category this item sells under.");
      if (!(input.price > 0)) throw new Error("Enter the selling price for this menu item.");
      const { data, error } = await supabase
        .from("menu_items")
        .insert({
          organization_id: organizationId as string,
          branch_id: branchId,
          category_id: input.categoryId,
          name: input.name.trim(),
          base_price: input.price,
          station_id: input.stationId ?? null,
          consumption_mode: "none",
          created_by: user?.id ?? null,
        } as never)
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return String((data as unknown as Row)["id"]);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
