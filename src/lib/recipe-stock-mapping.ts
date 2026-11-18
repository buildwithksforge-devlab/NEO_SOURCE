type Row = Record<string, unknown>;
const unit = (value: unknown) => String(value ?? "").trim().toLowerCase();

/** Seed a reviewed version from the menu's visible, owned current stock binding.
 * Previous approved recipe data remains immutable until normal approval switches versions. */
export function directSaleDraftMapping(row: Row) {
  if (row["recipe_type"] !== "direct_sale") return null;
  const menu = row["menu_items"] as Row | null;
  const stock = menu?.["mapped_stock_item"] as Row | null;
  const quantity = Number(menu?.["stock_quantity_per_sale"]);
  if (!row["organization_id"] || !menu?.["id"] || menu["id"] !== row["menu_item_id"] ||
      menu["organization_id"] !== row["organization_id"] ||
      (menu["branch_id"] ?? null) !== (row["branch_id"] ?? null) ||
      menu["consumption_mode"] !== "direct_stock" || !stock?.["id"] ||
      stock["id"] !== menu["stock_item_id"] || stock["organization_id"] !== row["organization_id"] ||
      (stock["branch_id"] != null && stock["branch_id"] !== row["branch_id"]) ||
      !Number.isFinite(quantity) || quantity <= 0 || !unit(menu["stock_unit"])) return null;
  return {name:String(menu["name"] ?? row["name"] ?? "Recipe"),
    stockItemId:String(stock["id"]),quantity,unit:String(menu["stock_unit"])};
}

/** A visible stock name is not proof that an approved sale uses that mapping. */
export function recipeStockMappingIssue(row: Row | null | undefined): string | null {
  if (!row || row["recipe_type"] !== "direct_sale") return null;
  const stock = row["output_stock_item"] as Row | null;
  if (!stock?.["id"] || stock["id"] !== row["output_stock_item_id"])
    return "The linked stock item is unavailable in this workspace. Choose stock owned by this hotel.";
  if (!row["organization_id"] || stock["organization_id"] !== row["organization_id"])
    return "The linked stock item belongs to another organisation. Choose stock owned by this hotel.";
  if (stock["branch_id"] != null && stock["branch_id"] !== row["branch_id"])
    return "The linked stock item belongs to another property.";
  const quantity = Number(row["yield_quantity"]);
  if (!Number.isFinite(quantity) || quantity <= 0 || !unit(row["yield_unit"]))
    return "Set a positive quantity and unit for each sale.";
  const menu = row["menu_items"] as Row | null;
  if (!menu?.["id"] || menu["id"] !== row["menu_item_id"] ||
      menu["organization_id"] !== row["organization_id"] ||
      (menu["branch_id"] ?? null) !== (row["branch_id"] ?? null))
    return "The linked menu item is unavailable in this property.";
  if (row["status"] === "active") {
    if (menu["consumption_mode"] !== "direct_stock" || menu["stock_item_id"] !== stock["id"])
      return "The approved recipe and menu point to different stock mappings. Review a corrected draft before approval.";
    if (Number(menu["stock_quantity_per_sale"]) !== quantity || unit(menu["stock_unit"]) !== unit(row["yield_unit"]))
      return "The menu quantity or unit differs from the approved recipe. Review a corrected draft before approval.";
  }
  return null;
}
