/**
 * Stock item catalogue — the operator-facing canonical master data screen for
 * the items Stores holds, issues and counts. Reorder thresholds (minimum,
 * reorder point, par level) are maintained here and drive the replenishment
 * recommendations shown on Inventory & Stores.
 */
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/DataDisplay";
import { ConfigCollection } from "@/components/config/ConfigCollection";
import { CatalogueHierarchy } from "@/components/inventory/CatalogueHierarchy";
import { ItemGroupsPanel } from "@/components/inventory/ItemGroupsPanel";

import { OpsGuard } from "@/components/operations/OpsShared";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/_shell/inventory/items")({
  head: () => ({
    meta: [
      { title: "Inventory & Stores Configuration — NEØ" },
      {
        name: "description",
        content:
          "Item groups, categories, stock items and the physical stores that hold them, in one configuration area.",
      },
      { property: "og:title", content: "Inventory & Stores Configuration — NEØ" },
      {
        property: "og:description",
        content:
          "Maintain the stock hierarchy — item groups, categories, stock items — and the stores that receive and issue them.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard path="/inventory/items">
      <StockItemsPage />
    </OpsGuard>
  ),
});

/**
 * Store types are NEØ operational classifications, not hotel master data: they
 * describe what a store is so every property reads the same vocabulary. The
 * behaviour a store actually carries lives in two flags the hotel controls —
 * `is_main` (where supplier deliveries land) and `is_mini_store` with the
 * department it serves (where requisition issues are transferred).
 */
export const STORE_TYPE_OPTIONS = [
  { value: "main", label: "Main store" },
  { value: "store", label: "General store" },
  { value: "mini", label: "Departmental mini-store" },
  { value: "food_dry", label: "Food / dry store" },
  { value: "beverage", label: "Beverage store" },
  { value: "bar", label: "Bar store" },
  { value: "kitchen", label: "Kitchen store" },
  { value: "cold_room", label: "Cold room" },
  { value: "chiller", label: "Chiller (chilled storage)" },
  { value: "freezer", label: "Freezer (frozen storage)" },
  { value: "cellar", label: "Cellar" },
  { value: "linen", label: "Linen store" },
];

export function storeTypeLabel(value: unknown): string {
  const key = String(value ?? "main");
  return STORE_TYPE_OPTIONS.find((option) => option.value === key)?.label ?? key;
}

function StockItemsPage() {
  const { can } = useAuth();
  // Stores master authority only. `procurement.suppliers.edit` deliberately
  // does not qualify — nav, route and this action gate all resolve through
  // `stores.items`, with Owner/System Admin covered by superuser parity.
  const canEdit = can("stores", "items", "edit") || can("administration", "workspace", "edit");
  const canStores =
    can("inventory", "stores", "edit") ||
    can("stores", "items", "edit") ||
    can("administration", "workspace", "edit");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Configuration Centre · Inventory & Stores"
        title="Inventory & Stores configuration"
        description="The stock hierarchy — item group, then category, then stock item — together with the physical stores that receive, hold and issue them. Consumable stock only: equipment and fixed items belong on the asset register, and suppliers are configured separately under Procurement."
      />

      <Tabs defaultValue="groups">
        <TabsList className="mb-4">
          <TabsTrigger value="groups">Item Groups</TabsTrigger>
          <TabsTrigger value="categories">Categories</TabsTrigger>
          <TabsTrigger value="items">Stock items</TabsTrigger>
          <TabsTrigger value="stores">Stores</TabsTrigger>
          <TabsTrigger value="hierarchy">Hierarchy &amp; stores</TabsTrigger>
        </TabsList>

        <TabsContent value="hierarchy">
          <CatalogueHierarchy />
        </TabsContent>

        <TabsContent value="groups">
          <ItemGroupsPanel canEdit={canEdit} />
        </TabsContent>

        <TabsContent value="categories">
          <ConfigCollection
            table="stock_categories"
            title="Categories"
            description="Groupings inside each item group. Every stock item belongs to one category."
            singular="Category"
            select="id, name, code, active"
            auditModule="inventory"
            canEdit={canEdit}
            statusField="active"
            propertyScoped={false}
            fields={[
              { name: "name", label: "Category name", type: "text", required: true },
              { name: "code", label: "Code", type: "text", placeholder: "FB" },
              { name: "active", label: "Active", type: "switch", defaultValue: true },
            ]}
          />
        </TabsContent>

        <TabsContent value="stores">
          <ConfigCollection
            table="stock_locations"
            title="Stores"
            description="Main stores and departmental mini-stores that hold and issue stock. The store type is a NEØ operational classification: it tells the system how the store behaves, while the name is yours."
            singular="Store"
            select="id, name, code, location_type, is_main, is_mini_store, active, branch_id, department_id, departments(name)"
            auditModule="inventory"
            canEdit={canStores}
            statusField="active"
            fields={[
              { name: "name", label: "Store name", type: "text", required: true },
              { name: "code", label: "Store code", type: "text", placeholder: "STR-MAIN" },
              {
                name: "location_type",
                label: "Store type",
                type: "select",
                defaultValue: "main",
                help: "A NEØ classification describing what the store is. How it behaves is set by the two switches below.",
                options: STORE_TYPE_OPTIONS,
              },
              {
                name: "is_main",
                label: "Main receiving store",
                type: "switch",
                defaultValue: false,
                help: "Supplier deliveries are received here by default. Only one store per property holds this; switching it on moves it off the previous one.",
              },
              {
                name: "is_mini_store",
                label: "Issues to a department",
                type: "switch",
                defaultValue: false,
                help: "On for a store a department holds and draws down. Stock issued against that department's requisitions is transferred into this store.",
              },
              {
                name: "department_id",
                label: "Department served",
                type: "select",
                required: true,
                placeholder: "Select department",
                showWhen: (form) => Boolean(form["is_mini_store"]),
                help: "Departments of the property in view. Switching 'Issues to a department' off clears this relationship.",
                lookup: { table: "departments", labelColumn: "name" },
              },
              { name: "active", label: "Active", type: "switch", defaultValue: true },
            ]}
            renderSummary={(row) => {
              const department = (row["departments"] as { name?: string } | null)?.name ?? null;
              return (
                <span>
                  {String(row["code"] ?? "No code")} · {storeTypeLabel(row["location_type"])}
                  {row["is_main"] ? " · receiving store" : ""}
                  {row["is_mini_store"] ? ` · issues to ${department ?? "no department set"}` : ""}
                </span>
              );
            }}
          />
        </TabsContent>

        <TabsContent value="items">

          <ConfigCollection
            table="stock_items"
            title="Stock items"
            description="Every item Stores receives, holds, issues and counts."
            singular="Stock item"
            select="id, name, sku, barcode, category_id, base_unit, purchase_unit, purchase_to_base, container_type, container_volume_ml, tracking_method, may_open_for_pours, default_pour_ml, is_divisible, min_level, reorder_point, par_level, max_level, reorder_quantity, shelf_life_days, track_batches, track_expiry, preferred_supplier_id, default_location_id, active, branch_id"
            auditModule="inventory"
            canEdit={canEdit}
            statusField="active"
            fields={[
              { name: "name", label: "Item name", type: "text", required: true },
              { name: "sku", label: "SKU / code", type: "text", placeholder: "FB-BEEF-001" },
              { name: "barcode", label: "Barcode", type: "text" },
              {
                name: "item_group_id",
                label: "Item Group",
                type: "select",
                virtual: true,
                lookup: { table: "stock_item_groups", propertyScoped: false },
                help: "Choose the item group first, then its category.",
              },
              {
                name: "category_id",
                label: "Category",
                type: "select",
                dependsOn: "item_group_id",
                lookup: {
                  table: "stock_categories",
                  propertyScoped: false,
                  parentColumn: "group_id",
                },
                help: "Only categories inside the chosen item group are listed.",
              },

              {
                name: "base_unit",
                label: "Base unit",
                type: "text",
                required: true,
                placeholder: "kg",
                help: "The unit stock is held and issued in.",
              },
              {
                name: "purchase_unit",
                label: "Purchase unit",
                type: "text",
                placeholder: "carton",
                help: "The unit suppliers sell in, when it differs.",
              },
              {
                name: "purchase_to_base",
                label: "Purchase → base conversion",
                type: "number",
                defaultValue: 1,
                help: "How many base units one purchase unit contains.",
              },
              { name: "min_level", label: "Minimum / safety stock", type: "number", defaultValue: 0 },
              {
                name: "reorder_point",
                label: "Reorder point",
                type: "number",
                defaultValue: 0,
                help: "At or below this level the item is flagged for replenishment.",
              },
              {
                name: "par_level",
                label: "Target / par level",
                type: "number",
                defaultValue: 0,
                help: "Replenishment suggestions buy back up to this level.",
              },
              { name: "shelf_life_days", label: "Shelf life (days)", type: "number", defaultValue: 0 },
              {
                name: "preferred_supplier_id",
                label: "Preferred supplier",
                type: "select",
                lookup: { table: "suppliers", propertyScoped: false },
              },
              {
                name: "default_location_id",
                label: "Default store",
                type: "select",
                lookup: { table: "stock_locations" },
                help: "Where this item normally lives. It takes precedence over the item group's fallback store, and the item can still hold stock in other stores through receiving, transfers and issues.",
              },
              {
                name: "container_type",
                label: "Container",
                type: "select",
                defaultValue: "other",
                options: [
                  { value: "bottle", label: "Bottle" },
                  { value: "can", label: "Can" },
                  { value: "carton", label: "Carton" },
                  { value: "keg", label: "Keg" },
                  { value: "other", label: "Other" },
                ],
                help: "How the item is physically held.",
              },
              {
                name: "container_volume_ml",
                label: "Container size (ml)",
                type: "number",
                nullable: true,
                // Only a measurable container has a volume. Onions held by the
                // kilo have none, and must not be forced to invent one.
                showWhen: (form) =>
                  String(form["container_type"] ?? "other") !== "other" ||
                  String(form["tracking_method"] ?? "whole") !== "whole" ||
                  Boolean(form["may_open_for_pours"]),
                help: "300 for a 300 ml bottle, 750 for a 0.75 litre bottle, 1000 for 1 litre. Needed before a tot can be poured from it.",
              },
              {
                name: "tracking_method",
                label: "Counted as",
                type: "select",
                defaultValue: "whole",
                options: [
                  { value: "whole", label: "Whole containers only" },
                  { value: "volume", label: "Volume only" },
                  { value: "both", label: "Sealed containers and open volume" },
                ],
                help: "Spirits served by the tot use sealed containers and open volume, so a part bottle is counted on its own.",
              },
              {
                name: "may_open_for_pours",
                label: "May be opened for pours",
                type: "switch",
                defaultValue: false,
                // Pouring only applies to a measurable container.
                showWhen: (form) => String(form["container_type"] ?? "other") !== "other",
                help: "On for spirits and wines served by the tot or glass. A sale then draws from the open bottle, and a new one is opened automatically when it runs short.",
              },
              {
                name: "default_pour_ml",
                label: "Default pour size (ml)",
                type: "number",
                nullable: true,
                showWhen: (form) => Boolean(form["may_open_for_pours"]),
                help: "The house measure for a single tot, for example 30.",
              },
              {
                name: "is_divisible",
                label: "Issued in part units",
                type: "switch",
                defaultValue: false,
                help: "On where part units may be issued to a department. Off for items only issued whole.",
              },
              { name: "track_batches", label: "Track batches", type: "switch", defaultValue: false },
              { name: "track_expiry", label: "Track expiry", type: "switch", defaultValue: false },
              { name: "active", label: "Active", type: "switch", defaultValue: true },
            ]}
            renderSummary={(row) => (
              <span>
                {String(row["sku"] ?? "No SKU")} · {String(row["base_unit"] ?? "unit")} · min{" "}
                {String(row["min_level"] ?? 0)} · reorder{" "}
                {String(row["reorder_point"] ?? row["min_level"] ?? 0)} · par{" "}
                {String(row["par_level"] ?? row["max_level"] ?? 0)}
              </span>
            )}
          />
        </TabsContent>



      </Tabs>

    </div>
  );
}
