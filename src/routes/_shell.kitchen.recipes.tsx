import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { KitchenGuard, QueryState } from "@/components/kitchen/KitchenShared";
import { RecordDialog } from "@/components/kitchen/RecordDialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { useAuth } from "@/lib/auth";
import { titleCase, type Row } from "@/lib/kitchen";
import {
  useApproveRecipe,
  useKitchenMenuItems,
  useKitchenStations,
  useMenuCategories,
} from "@/lib/kitchen-data";
import { useStockItems } from "@/lib/inventory-data";
import {
  RECIPE_UNITS,
  RecipeEngineError,
  expandRecipeToStock,
  perUnitPreview,
} from "@/lib/recipe-engine";
import {
  IngredientRows,
  emptyIngredientRow,
  rowsAreValid,
  type IngredientDraft,
} from "@/components/kitchen/IngredientRows";
import {
  directStockMapping,
  useCreateMenuItemForRecipe,
  recipeMap,
  toRecipeRecord,
  useRecipeCatalogue,
  useRemoveRecipeComponent,
  useSaveRecipeComponents,
  useSaveRecipeMaster,
  useSetRecipeStation,
} from "@/lib/recipe-master";
// Recipes read the same canonical station → store projection Kitchen Settings
// and the consumption resolver use, so a recipe can never show a store the
// till would not actually deduct from.
import { STATION_STATE_LABEL, useStationStoreConsole } from "@/lib/station-store-routing";

export const Route = createFileRoute("/_shell/kitchen/recipes")({
  head: () => ({
    meta: [
      { title: "Recipes & standards — NEØ" },
      {
        name: "description",
        content:
          "Menu-item recipes and batch sub-recipes with yields, components and per-unit consumption.",
      },
      { property: "og:title", content: "Recipes & standards — NEØ" },
      {
        property: "og:description",
        content:
          "Menu-item recipes and batch sub-recipes with yields, components and per-unit consumption.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <KitchenGuard action="recipes.view">
      <Page />
    </KitchenGuard>
  ),
});

function Page() {
  const { can } = useAuth();
  const catalogue = useRecipeCatalogue();
  const menuItems = useKitchenMenuItems();
  const menuCategories = useMenuCategories();
  const createMenuItem = useCreateMenuItemForRecipe();
  const stations = useKitchenStations();
  const stockItems = useStockItems();
  const saveRecipe = useSaveRecipeMaster();
  const saveComponents = useSaveRecipeComponents();
  const removeComponent = useRemoveRecipeComponent();
  const approve = useApproveRecipe();
  const stationStores = useStationStoreConsole();
  const setRecipeStation = useSetRecipeStation();

  const rows = (catalogue.data ?? []) as Row[];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newRecipeRows, setNewRecipeRows] = useState<IngredientDraft[]>(() => [emptyIngredientRow()]);
  const [addRows, setAddRows] = useState<IngredientDraft[]>(() => [emptyIngredientRow()]);

  const canCreate = can("kitchen", "recipes.create");
  const canApprove = can("kitchen", "recipes.approve");

  const recipes = useMemo(() => recipeMap(rows), [rows]);
  const selectedRow = rows.find((r) => String(r["id"]) === selectedId) ?? null;
  const selected = selectedRow ? toRecipeRecord(selectedRow) : null;
  // A direct-sale product has no ingredient rows by design: one sale takes one
  // container. Show that mapping instead of an empty component table.
  const directMapping = directStockMapping(selectedRow);
  // Where this recipe's sale would actually deduct from, read from the one
  // canonical mapping rather than restated here.
  const selectedStation = selectedRow
    ? ((stationStores.data ?? []).find(
        (s) => s.stationId === String(selectedRow["station_id"] ?? ""),
      ) ?? null)
    : null;

  const subRecipeOptions = rows
    .filter((r) => String(r["recipe_type"] ?? "menu_item") === "sub_recipe")
    .map((r) => ({
      value: String(r["id"]),
      label: `${String(r["name"] ?? "Sub-recipe")} · yield ${r["yield_quantity"] ?? "—"} ${String(r["yield_unit"] ?? "")}`,
    }));

  const stockOptions = (stockItems.data ?? []).map((s) => ({
    value: String(s["id"]),
    label: `${String(s["name"])} (${String(s["base_unit"] ?? "")})`,
  }));

  const labelFor = (row: IngredientDraft) =>
    row.componentType === "sub_recipe"
      ? (subRecipeOptions.find((o) => o.value === row.subRecipeId)?.label ?? "Sub-recipe")
      : (stockOptions.find((o) => o.value === row.stockItemId)?.label ?? "Stock item");

  const isBlank = (row: IngredientDraft) =>
    !row.stockItemId && !row.subRecipeId && !row.quantity;

  const toComponentInput = (row: IngredientDraft) => ({
    componentType: row.componentType,
    stockItemId: row.componentType === "stock_item" ? row.stockItemId : null,
    subRecipeId: row.componentType === "sub_recipe" ? row.subRecipeId : null,
    name: labelFor(row),
    quantity: Number(row.quantity),
    unit: row.unit,
    wasteAllowance: Number(row.wasteAllowance || 0),
  });

  const recipeFields = [
    { name: "name", label: "Recipe name", required: true, placeholder: "As printed on the kitchen card" },
    { name: "recipe_code", label: "Recipe code", placeholder: "e.g. BEV-CAP-01" },
    {
      name: "recipe_type",
      label: "Recipe type",
      type: "select" as const,
      required: true,
      options: [
        { value: "menu_item", label: "Menu item recipe" },
        { value: "sub_recipe", label: "Batch / prepared sub-recipe" },
        { value: "direct_sale", label: "Direct-sale product (sold from stock)" },
      ],
    },
    {
      name: "menu_item_id",
      label: "Menu item (leave empty to create one below)",
      type: "select" as const,
      options: (menuItems.data ?? []).map((m) => ({
        value: String(m["id"]),
        label: String(m["name"]),
      })),
    },
    {
      name: "new_menu_item_category",
      label: "New menu item — menu category",
      type: "select" as const,
      options: (menuCategories.data ?? []).map((c) => ({
        value: String(c["id"]),
        label: String(c["name"]),
      })),
    },
    {
      name: "new_menu_item_price",
      label: "New menu item — selling price",
      type: "number" as const,
    },

    {
      name: "output_stock_item_id",
      label: "Stock item produced or sold (batch and direct-sale only)",
      type: "select" as const,
      options: (stockItems.data ?? []).map((s) => ({
        value: String(s["id"]),
        label: `${String(s["name"])} (${String(s["base_unit"] ?? "")})`,
      })),
    },
    {
      name: "station_id",
      label: "Preparing station",
      type: "select" as const,
      options: (stations.data ?? []).map((s) => ({
        value: String(s["id"]),
        label: String(s["name"]),
      })),
    },
    { name: "yield_quantity", label: "Yield quantity", type: "number" as const, required: true },
    { name: "yield_unit", label: "Yield unit (portion, g, kg, ml, L, piece)", required: true },
    { name: "prep_target_minutes", label: "Preparation time (minutes)", type: "number" as const },
    { name: "preparation_steps", label: "Preparation notes", type: "textarea" as const },
  ];

  const preview = selected ? perUnitPreview(selected) : [];
  let expansionNote: string | null = null;
  if (selected && selected.status === "active") {
    try {
      expandRecipeToStock(recipes, selected.id, 1);
    } catch (e) {
      expansionNote =
        e instanceof RecipeEngineError ? e.message : "This recipe cannot be expanded to stock yet.";
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Kitchen"
        title="Recipes & standards"
        description="Menu-item recipes and batch sub-recipes, with yields, components and the per-unit consumption used by the inventory ledger."
        actions={
          canCreate ? (
            <RecordDialog
              title="New recipe"
              description="A menu-item recipe is sold directly. A batch sub-recipe (e.g. Pizza Sauce, yield 12 L) is consumed by other recipes."
              submitLabel="Save draft recipe"
              pending={saveRecipe.isPending}
              fields={recipeFields}
              extra={
                <IngredientRows
                  rows={newRecipeRows}
                  onChange={setNewRecipeRows}
                  stockOptions={stockOptions}
                  subRecipeOptions={subRecipeOptions}
                />
              }
              extraInvalid={!rowsAreValid(newRecipeRows.filter((r) => !isBlank(r))) && newRecipeRows.some((r) => !isBlank(r))}
              onOpenChange={(open) => {
                if (!open) setNewRecipeRows([emptyIngredientRow()]);
              }}
              contentClassName="sm:max-w-3xl"
              onSubmit={async (values) => {
                const recipeType =
                  String(values["recipe_type"] ?? "menu_item") === "sub_recipe"
                    ? ("sub_recipe" as const)
                    : String(values["recipe_type"]) === "direct_sale"
                      ? ("direct_sale" as const)
                      : ("menu_item" as const);
                const stationId = (values["station_id"] as string) ?? null;
                // Menu item first, recipe second, binding last: when no existing
                // item is chosen, create it here from the price and category
                // entered on this form, then carry its id into the recipe.
                let menuItemId = (values["menu_item_id"] as string) ?? null;
                if (recipeType !== "sub_recipe" && !menuItemId) {
                  menuItemId = await createMenuItem.mutateAsync({
                    name: String(values["name"] ?? ""),
                    categoryId: String(values["new_menu_item_category"] ?? ""),
                    price: Number(values["new_menu_item_price"] ?? 0),
                    stationId,
                  });
                }
                const recipeId = await saveRecipe.mutateAsync({
                  name: String(values["name"] ?? ""),
                  recipeCode: (values["recipe_code"] as string) ?? null,
                  recipeType,
                  outputStockItemId: (values["output_stock_item_id"] as string) ?? null,
                  menuItemId,
                  stationId,
                  yieldQuantity: Number(values["yield_quantity"] ?? 0),
                  yieldUnit: String(values["yield_unit"] ?? ""),
                  prepTargetMinutes: values["prep_target_minutes"]
                    ? Number(values["prep_target_minutes"])
                    : null,
                  preparationSteps: (values["preparation_steps"] as string) ?? null,
                  status: "draft",
                });
                const sheet = newRecipeRows.filter((r) => !isBlank(r));
                if (recipeId && sheet.length > 0) {
                  await saveComponents.mutateAsync({
                    recipeId,
                    rows: sheet.map(toComponentInput),
                  });
                }
                setNewRecipeRows([emptyIngredientRow()]);
                setSelectedId(recipeId ?? null);
              }}
              trigger={
                <Button>
                  <Plus className="mr-2 size-4" /> New recipe
                </Button>
              }
            />
          ) : null
        }
      />

      <SectionCard
        title="Station consumption stores"
        description="The same mapping Kitchen Settings holds and the till deducts against. A station without a store cannot post consumption, so the gap is shown here rather than discovered at the till."
      >
        <QueryState
          isLoading={stationStores.isLoading}
          error={stationStores.error}
          isEmpty={(stationStores.data ?? []).length === 0}
          empty={<p className="py-6 text-sm text-muted-foreground">No active stations configured yet.</p>}
        >
          <ul className="divide-y divide-border">
            {(stationStores.data ?? []).map((s) => (
              <li
                key={s.stationId}
                className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium">{s.stationName}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.recipesActive} active recipe{s.recipesActive === 1 ? "" : "s"}
                    {s.locationName ? ` · consumes from ${s.locationName}` : " · no consumption store set"}
                  </p>
                </div>
                <StatusPill tone={s.state === "ready" ? "success" : "warning"}>
                  {STATION_STATE_LABEL[s.state]}
                </StatusPill>
              </li>
            ))}
          </ul>
        </QueryState>
      </SectionCard>


      <SectionCard
        title="Recipes"
        description="Records captured by your kitchen team. Nothing here is simulated."
      >
        <QueryState
          isLoading={catalogue.isLoading}
          error={catalogue.error}
          isEmpty={rows.length === 0}
          empty={<p className="py-6 text-sm text-muted-foreground">No recipes recorded yet.</p>}
        >
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={String(r["id"])} className="flex items-start justify-between gap-3 py-3 text-sm">
                <button
                  type="button"
                  className="text-left"
                  onClick={() => setSelectedId(String(r["id"]))}
                  aria-label={`Open ${String(r["name"] ?? "recipe")}`}
                >
                  <p className="font-medium">
                    {String(r["name"] ?? (r["menu_items"] as Row | null)?.["name"] ?? "Recipe")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {String(r["recipe_type"] ?? "menu_item") === "direct_sale"
                      ? `Direct stock · ${directStockMapping(r)?.stockItemName ?? "stock item not set"} · ${r["yield_quantity"] ?? 1} ${String(r["yield_unit"] ?? "container")} per sale`
                      : `${String(r["recipe_type"] ?? "menu_item") === "sub_recipe" ? "Batch sub-recipe" : "Menu item recipe"} · yield ${r["yield_quantity"] ?? "—"} ${String(r["yield_unit"] ?? "")} · ${
                          (r["operational_stations"] as Row | null)?.["name"] ?? "Unassigned station"
                        }`}
                  </p>
                </button>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {canCreate ? (
                    <Select
                      value={(r["station_id"] as string | null) ?? ""}
                      onValueChange={(v) =>
                        setRecipeStation.mutate({ recipeId: String(r["id"]), stationId: v })
                      }
                    >
                      <SelectTrigger
                        className="h-8 w-48"
                        aria-label={`Preparing station for ${String(r["name"] ?? "recipe")}`}
                      >
                        <SelectValue placeholder="Set preparing station" />
                      </SelectTrigger>
                      <SelectContent>
                        {(stations.data ?? []).map((s) => (
                          <SelectItem key={String(s["id"])} value={String(s["id"])}>
                            {String(s["name"])}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                  <StatusPill tone={String(r["status"]) === "active" ? "success" : "default"}>
                    {titleCase(String(r["status"] ?? "draft"))}
                  </StatusPill>

                  {canApprove && String(r["status"] ?? "draft") === "draft" ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={approve.isPending}
                      onClick={() =>
                        approve.mutate({
                          recipeId: String(r["id"]),
                          menuItemId: String(r["menu_item_id"] ?? ""),
                        })
                      }
                    >
                      Approve
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </QueryState>
      </SectionCard>

      {selected ? (
        <SectionCard
          title={
            directMapping
              ? `${selected.name ?? "Recipe"} — sold straight from stock`
              : `${selected.name ?? "Recipe"} — yield ${selected.yield_quantity} ${selected.yield_unit}`
          }
          description={
            directMapping
              ? "A finished packaged product. It needs no ingredients: each sale takes one container off the store below."
              : "Components are recorded for the full recipe yield. Per-unit usage below is what a single sale consumes."
          }
          actions={
            canCreate ? (
              <RecordDialog
                title="Add ingredients"
                description="Add one row per stock item or prepared sub-recipe consumed by this recipe's full yield."
                submitLabel="Add ingredients"
                pending={saveComponents.isPending}
                fields={[]}
                contentClassName="sm:max-w-3xl"
                extra={
                  <IngredientRows
                    rows={addRows}
                    onChange={setAddRows}
                    stockOptions={stockOptions}
                    subRecipeOptions={subRecipeOptions}
                  />
                }
                extraInvalid={!rowsAreValid(addRows.filter((r) => !isBlank(r)))}
                onOpenChange={(open) => {
                  if (!open) setAddRows([emptyIngredientRow()]);
                }}
                onSubmit={async () => {
                  const sheet = addRows.filter((r) => !isBlank(r));
                  await saveComponents.mutateAsync({
                    recipeId: selected.id,
                    rows: sheet.map(toComponentInput),
                  });
                  setAddRows([emptyIngredientRow()]);
                }}
                trigger={
                  <Button size="sm" variant="secondary">
                    <Plus className="mr-2 size-4" /> Add ingredients
                  </Button>
                }
              />
            ) : null
          }
        >
          {expansionNote ? (
            <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
              {expansionNote}
            </p>
          ) : null}
          <p className="mb-3 rounded-md border border-border bg-muted/30 p-3 text-sm">
            {selectedStation ? (
              selectedStation.locationName ? (
                <>
                  Consumption resolves{" "}
                  <span className="font-medium">{selectedStation.stationName}</span> →{" "}
                  <span className="font-medium">{selectedStation.locationName}</span>
                  {selectedStation.state === "ready" ? "" : ` · ${STATION_STATE_LABEL[selectedStation.state]}`}
                </>
              ) : (
                <>
                  <span className="font-medium">{selectedStation.stationName}</span> has no consumption
                  store set, so a sale of this recipe cannot post stock. Set it in Kitchen Settings.
                </>
              )
            ) : (
              <>No preparing station set, so consumption cannot be resolved for this recipe.</>
            )}
          </p>
          {directMapping ? (
            <dl className="grid gap-3 rounded-md border border-border bg-muted/30 p-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs uppercase text-muted-foreground">Direct stock item</dt>
                <dd className="font-medium">
                  {directMapping.stockItemName}
                  {directMapping.sku ? ` · ${directMapping.sku}` : ""}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-muted-foreground">Consumption</dt>
                <dd className="font-medium">
                  {`${directMapping.perSale} ${directMapping.containerType ?? directMapping.unit}${directMapping.perSale === 1 ? "" : "s"} per sale`}
                  {directMapping.containerVolumeMl
                    ? ` · ${directMapping.containerVolumeMl} ml container`
                    : ""}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-muted-foreground">Store</dt>
                <dd className="font-medium">
                  {directMapping.storeName ?? "Resolved from the selling station's store"}
                </dd>
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-3">
                Container sizes are edited on the stock item itself, so a 300 ml and a 500 ml soda can be
                held as separate items with their own sizes.
              </p>
            </dl>
          ) : selected.ingredients.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">No components recorded yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4">Component</th>
                  <th className="py-2 pr-4">Type</th>
                  <th className="py-2 pr-4">Qty for full yield</th>
                  <th className="py-2 pr-4">Unit</th>
                  <th className="py-2 pr-4">Per unit sold</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {selected.ingredients.map((ing, idx) => (
                  <tr key={ing.id} className="border-t border-border">
                    <td className="py-2 pr-4">{ing.ingredient_name ?? "Component"}</td>
                    <td className="py-2 pr-4">
                      {ing.component_type === "sub_recipe" ? "Sub-recipe" : "Stock item"}
                    </td>
                    <td className="py-2 pr-4">{ing.quantity}</td>
                    <td className="py-2 pr-4">{ing.unit}</td>
                    <td className="py-2 pr-4">
                      {preview[idx] ? `${Number(preview[idx].quantity.toFixed(4))} ${preview[idx].unit}` : "—"}
                    </td>
                    <td className="py-2 text-right">
                      {canCreate ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Remove ${ing.ingredient_name ?? "component"}`}
                          onClick={() => removeComponent.mutate(ing.id)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SectionCard>
      ) : null}
    </div>
  );
}
