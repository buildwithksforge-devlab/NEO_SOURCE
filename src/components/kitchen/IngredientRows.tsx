import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RECIPE_UNITS, isDiscreteUnit, wholeUnitIssue } from "@/lib/recipe-engine";

export type IngredientDraft = {
  key: string;
  componentType: "stock_item" | "sub_recipe";
  stockItemId: string;
  subRecipeId: string;
  quantity: string;
  unit: string;
  wasteAllowance: string;
};

export type ComponentOption = { value: string; label: string };

let seq = 0;
export function emptyIngredientRow(): IngredientDraft {
  seq += 1;
  return {
    key: `row-${seq}`,
    componentType: "stock_item",
    stockItemId: "",
    subRecipeId: "",
    quantity: "",
    unit: "g",
    wasteAllowance: "",
  };
}

/** A row is complete when it names a component and carries a positive quantity in a unit. */
export function isRowComplete(row: IngredientDraft): boolean {
  const target = row.componentType === "sub_recipe" ? row.subRecipeId : row.stockItemId;
  return (
    Boolean(target) && Number(row.quantity) > 0 && Boolean(row.unit) && rowWholeUnitIssue(row) === null
  );
}

/**
 * Pieces, bottles, buns, cans and eggs are counted whole, so neither the
 * quantity nor the wastage may turn one bun into a fraction.
 */
export function rowWholeUnitIssue(row: IngredientDraft): string | null {
  if (!isDiscreteUnit(row.unit)) return null;
  const issue = wholeUnitIssue(Number(row.quantity), row.unit);
  if (issue) return issue;
  const waste = Number(row.wasteAllowance);
  if (waste > 0) {
    const wasted = (Number(row.quantity) * waste) / 100;
    if (wasted > 0 && !Number.isInteger(wasted)) {
      return `Wastage on a whole-unit item is recorded as its own whole ${row.unit}, so ${wasted.toFixed(2)} becomes ${Math.ceil(wasted)}.`;
    }
  }
  return null;
}

export function rowsAreValid(rows: IngredientDraft[]): boolean {
  return rows.length > 0 && rows.every(isRowComplete);
}

/**
 * The repeatable Ingredients & Components table.
 *
 * Every click of "Add ingredient" appends another row — a recipe is a sheet of
 * components, never a single ingredient field. Quantities are captured in the
 * recipe's own units; conversion to each stock item's base unit stays with the
 * canonical recipe engine.
 */
export function IngredientRows({
  rows,
  onChange,
  stockOptions,
  subRecipeOptions,
}: {
  rows: IngredientDraft[];
  onChange: (rows: IngredientDraft[]) => void;
  stockOptions: ComponentOption[];
  subRecipeOptions: ComponentOption[];
}) {
  const update = (key: string, patch: Partial<IngredientDraft>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <Label>Ingredients &amp; components</Label>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => onChange([...rows, emptyIngredientRow()])}
        >
          <Plus className="mr-2 size-4" /> Add ingredient
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          No ingredients yet. Add one row per component consumed by the full recipe yield.
        </p>
      ) : null}

      <div className="space-y-3">
        {rows.map((row, index) => (
          <div
            key={row.key}
            className="grid gap-3 rounded-lg border border-border bg-muted/30 p-3 sm:grid-cols-12"
          >
            <div className="space-y-1 sm:col-span-3">
              <Label className="text-xs" htmlFor={`ing-type-${row.key}`}>
                Type
              </Label>
              <Select
                value={row.componentType}
                onValueChange={(v) =>
                  update(row.key, {
                    componentType: v === "sub_recipe" ? "sub_recipe" : "stock_item",
                    stockItemId: "",
                    subRecipeId: "",
                  })
                }
              >
                <SelectTrigger id={`ing-type-${row.key}`} aria-label={`Ingredient ${index + 1} type`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stock_item">Stock item</SelectItem>
                  <SelectItem value="sub_recipe">Prepared sub-recipe</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1 sm:col-span-4">
              <Label className="text-xs" htmlFor={`ing-ref-${row.key}`}>
                {row.componentType === "sub_recipe" ? "Sub-recipe" : "Stock item"}
              </Label>
              <Select
                value={row.componentType === "sub_recipe" ? row.subRecipeId : row.stockItemId}
                onValueChange={(v) =>
                  update(
                    row.key,
                    row.componentType === "sub_recipe" ? { subRecipeId: v } : { stockItemId: v },
                  )
                }
              >
                <SelectTrigger id={`ing-ref-${row.key}`} aria-label={`Ingredient ${index + 1}`}>
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {(row.componentType === "sub_recipe" ? subRecipeOptions : stockOptions).map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs" htmlFor={`ing-qty-${row.key}`}>
                Quantity
              </Label>
              <Input
                id={`ing-qty-${row.key}`}
                type="number"
                inputMode="decimal"
                min="0"
                step={isDiscreteUnit(row.unit) ? "1" : "any"}
                value={row.quantity}
                aria-label={`Ingredient ${index + 1} quantity`}
                onChange={(e) => update(row.key, { quantity: e.target.value })}
              />
            </div>

            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs" htmlFor={`ing-unit-${row.key}`}>
                Unit
              </Label>
              <Select value={row.unit} onValueChange={(v) => update(row.key, { unit: v })}>
                <SelectTrigger id={`ing-unit-${row.key}`} aria-label={`Ingredient ${index + 1} unit`}>
                  <SelectValue placeholder="Unit" />
                </SelectTrigger>
                <SelectContent>
                  {RECIPE_UNITS.map((u) => (
                    <SelectItem key={u} value={u}>
                      {u}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-end justify-end sm:col-span-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Remove ingredient ${index + 1}`}
                onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>

            <div className="space-y-1 sm:col-span-3">
              <Label className="text-xs" htmlFor={`ing-waste-${row.key}`}>
                Wastage %
              </Label>
              <Input
                id={`ing-waste-${row.key}`}
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={row.wasteAllowance}
                aria-label={`Ingredient ${index + 1} wastage percentage`}
                onChange={(e) => update(row.key, { wasteAllowance: e.target.value })}
              />
            </div>

            {rowWholeUnitIssue(row) ? (
              <p className="text-xs text-destructive sm:col-span-12" role="alert">
                {rowWholeUnitIssue(row)}
              </p>
            ) : isDiscreteUnit(row.unit) ? (
              <p className="text-xs text-muted-foreground sm:col-span-12">
                Counted whole: any wastage is recorded as its own whole {row.unit} entry, never added as a
                fraction.
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
