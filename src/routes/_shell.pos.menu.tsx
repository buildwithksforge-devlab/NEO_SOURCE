/**
 * Menu Management — reference implementation of the NEØ catalogue workspace.
 *
 * The page is composed around the objects being managed (menu items) rather
 * than around a filter bar and a wide table: one summary strip whose figures
 * are filters, a category rail, an image-led catalogue list, and an inspector
 * sheet for the selected item. Every capability of the previous surface is
 * preserved — menus, categories, modifiers, imports, station routing and its
 * source, publish/draft, availability, delivery flag, SKU, imagery, recipe
 * status and property scoping.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMemo, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { BookOpen } from "lucide-react";
import { PageHeader, StatusPill } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import {
  CatalogueGroup,
  CatalogueQueryBar,
  CatalogueRail,
  CatalogueRow,
  CatalogueWorkspace,
  type ActiveFilterChip,
} from "@/components/common/CatalogueWorkspace";
import {
  InspectorField,
  InspectorSection,
  InspectorSheet,
} from "@/components/common/InspectorSheet";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState, PosGuard, QueryState } from "@/components/pos/PosShared";
import { RecordDialog } from "./_shell.pos.floor";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { MenuImportDialog } from "@/components/pos/MenuImportDialog";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { MENU_AVAILABILITY, money, titleCase } from "@/lib/pos";
import { menusForBranch } from "@/lib/menu-scoping";
import { MenuCatalogueSection, MenuItemFormDialog } from "@/components/pos/MenuCatalogueManager";
import { MenuItemImage } from "@/components/pos/MenuImageField";
import { MenuConsumptionCard } from "@/components/pos/MenuConsumptionCard";

import {
  menuConsumptionReady,
  type MenuCatalogueRow,
  type MenuRecipeStatus,
  useAssignMenuStation,
  useMenuCatalogue,
  useMenuCategories,
  useMenuItems,
  useMenuStations,
  useMenus,
  useBranches,
  useModifierGroups,
  useSaveRecord,
} from "@/lib/pos-data";

/** Plain-language explanation of where an item's routing actually came from. */
const STATION_SOURCE: Record<string, string> = {
  rule: "From a routing rule",
  item: "Assigned on the item",
  category: "Inherited from category",
  menu: "Inherited from menu",
  default: "Outlet default station",
};

export const Route = createFileRoute("/_shell/pos/menu")({
  head: () => ({
    meta: [
      { title: "Menu Management — NEØ" },
      {
        name: "description",
        content:
          "Menus, categories, items, station routing, pricing and modifier groups for every outlet.",
      },
      { property: "og:title", content: "Menu Management — NEØ" },
      {
        property: "og:description",
        content:
          "Menus, categories, items, station routing, pricing and modifier groups for every outlet.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PosGuard action="menu.edit" path="/pos/menu">
      <MenuPage />
    </PosGuard>
  ),
});

type CatalogueRowData = ReturnType<typeof useMenuCatalogue>["data"] extends
  | (infer R)[]
  | undefined
  ? R
  : never;

/** Data-quality lenses surfaced by the summary strip. */
type Lens = "none" | "draft" | "routing" | "photo" | "recipe";

function MenuPage() {
  const { can } = useAuth();
  const menus = useMenus();
  const categories = useMenuCategories();
  const items = useMenuItems();
  const groups = useModifierGroups();
  const { branchId } = useActivePropertyFilter();
  // Inline routing changes may only offer stations of the item's own property.
  const stations = useMenuStations(branchId, null);
  const saveCategory = useSaveRecord("menu_categories");
  const saveItem = useSaveRecord("menu_items");
  const saveGroup = useSaveRecord("modifier_groups");
  const saveOption = useSaveRecord("modifier_options");

  const [editingItem, setEditingItem] =
    useState<Parameters<typeof MenuItemFormDialog>[0]["item"]>(null);
  const [catDialog, setCatDialog] = useState(false);
  const [itemDialog, setItemDialog] = useState(false);
  const [groupDialog, setGroupDialog] = useState(false);
  const [optionDialog, setOptionDialog] = useState(false);
  const [importDialog, setImportDialog] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [search, setSearch] = useState("");
  const [categoryRail, setCategoryRail] = useState("all");
  const [lens, setLens] = useState<Lens>("none");
  const [availFilter, setAvailFilter] = useState("all");
  const [publishFilter, setPublishFilter] = useState("all");
  const [importFilter, setImportFilter] = useState("all");
  const [menuFilter, setMenuFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [batchFilter, setBatchFilter] = useState("all");
  const [inspectId, setInspectId] = useState<string | null>(null);

  // Management reads the same canonical catalogue as the terminal, only with
  // drafts included, so published/draft counts can never disagree with it.
  const catalogue = useMenuCatalogue(true);
  const assignStation = useAssignMenuStation();
  const catalogueRows = (catalogue.data ?? []) as CatalogueRowData[];
  const branches = useBranches();
  const branchLabel = (id: string | null) =>
    id
      ? ((branches.data ?? []).find((b) => b.id === id)?.name ?? "Unknown property")
      : "Organisation-wide";
  // The menu list follows the property selector: one property shows only its own
  // menus, All Properties shows every menu clearly labelled with its property.
  const branchMenus = menusForBranch(
    (menus.data ?? []) as unknown as { id: string; name: string; branch_id: string | null }[],
    branchId,
  );
  // Item counts per menu drive the "safe to remove" decision in the catalogue.
  const itemCounts = new Map<string, number>();
  for (const row of catalogueRows) {
    if (!row.menu_id) continue;
    itemCounts.set(row.menu_id, (itemCounts.get(row.menu_id) ?? 0) + 1);
  }
  // Sales-channel flags live on the item record itself; the catalogue RPC only
  // reports routing and publication, so the delivery flag is read from source.
  const deliveryFlags = new Map(
    ((items.data ?? []) as Record<string, unknown>[]).map((r) => [
      String(r["id"]),
      Boolean(r["available_delivery"]),
    ]),
  );

  const publishedRows = catalogueRows.filter((r) => r.publish_status === "published");
  const draftCount = catalogueRows.filter((r) => r.publish_status === "draft").length;
  const routingGap = catalogueRows.filter((r) => r.station_missing).length;
  const photoGap = catalogueRows.filter((r) => !r.image_url).length;
  const recipeGap = catalogueRows.filter((r) => !menuConsumptionReady(r.recipe_status)).length;

  const catalogueCategories = [
    ...new Set(catalogueRows.map((r) => r.category_name ?? "Uncategorised")),
  ].sort();
  const catalogueMenus = [...new Set(catalogueRows.map((r) => r.menu_name ?? "Unassigned"))].sort();
  const catalogueSources = [...new Set(catalogueRows.map((r) => r.station_source))].sort();
  // One entry per import batch actually represented in the catalogue.
  const catalogueBatches = [
    ...new Map(
      catalogueRows
        .filter((r) => r.import_batch_id)
        .map((r) => [
          r.import_batch_id as string,
          `${r.import_file_name ?? "Unnamed file"} · ${(r.import_batch_id as string).slice(0, 8)}`,
        ]),
    ).entries(),
  ].sort((a, b) => a[1].localeCompare(b[1]));

  const term = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      catalogueRows.filter(
        (r) =>
          (publishFilter === "all" || r.publish_status === publishFilter) &&
          (importFilter === "all" || (importFilter === "imported" ? r.imported : !r.imported)) &&
          (menuFilter === "all" || (r.menu_name ?? "Unassigned") === menuFilter) &&
          (categoryRail === "all" || (r.category_name ?? "Uncategorised") === categoryRail) &&
          (availFilter === "all" || r.availability === availFilter) &&
          (sourceFilter === "all" || r.station_source === sourceFilter) &&
          (batchFilter === "all" || (r.import_batch_id ?? "none") === batchFilter) &&
          (lens === "none" ||
            (lens === "draft"
              ? r.publish_status === "draft"
              : lens === "routing"
                ? r.station_missing
                : lens === "photo"
                  ? !r.image_url
                  : !menuConsumptionReady(r.recipe_status))) &&
          (!term ||
            r.name.toLowerCase().includes(term) ||
            (r.sku ?? "").toLowerCase().includes(term) ||
            (r.import_file_name ?? "").toLowerCase().includes(term) ||
            (r.category_name ?? "").toLowerCase().includes(term)),
      ),
    [
      catalogueRows,
      publishFilter,
      importFilter,
      menuFilter,
      categoryRail,
      availFilter,
      sourceFilter,
      batchFilter,
      lens,
      term,
    ],
  );

  // The catalogue reads as the menu's own structure: items grouped by the
  // category they are sold under, in the order a waiter sees them.
  const grouped = useMemo(() => {
    const map = new Map<string, CatalogueRowData[]>();
    for (const row of filtered) {
      const key = row.category_name ?? "Uncategorised";
      const bucket = map.get(key);
      if (bucket) bucket.push(row);
      else map.set(key, [row]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const railItems = catalogueCategories.map((name) => ({
    id: name,
    label: name,
    count: catalogueRows.filter((r) => (r.category_name ?? "Uncategorised") === name).length,
  }));

  const manage = can("pos", "menu.edit");
  const canAssignStation = can("pos", "menu.edit");

  type MenuRow = {
    id: string;
    name: string;
    base_price: number;
    publish_status?: string | null;
    menu_categories?: { name: string } | null;
  };
  const allItems = (items.data ?? []) as unknown as MenuRow[];
  const draftItems = allItems.filter((i) => i.publish_status === "draft");

  const publishDrafts = async (ids: string[]) => {
    if (!ids.length) return;
    setPublishing(true);
    try {
      const { error } = await guardedRpc(supabase, "publish_menu_items", { _ids: ids });
      if (error) throw error;
      toast.success(`Published ${ids.length} item${ids.length === 1 ? "" : "s"}`);
      await items.refetch();
      await catalogue.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not publish");
    } finally {
      setPublishing(false);
    }
  };

  const toggleLens = (next: Lens) => setLens((prev) => (prev === next ? "none" : next));

  const leadFigure: SummaryFigure = {
    id: "sellable",
    label: "Sellable now",
    value: catalogue.isLoading ? "…" : publishedRows.length,
    hint: `${catalogueRows.length} items in the catalogue`,
  };
  const figures: SummaryFigure[] = [
    {
      id: "draft",
      label: "Drafts",
      value: catalogue.isLoading ? "…" : draftCount,
      hint: "Not sold on the terminal",
      tone: draftCount ? "warning" : "default",
      onSelect: () => toggleLens("draft"),
      active: lens === "draft",
    },
    {
      id: "routing",
      label: "Missing routing",
      value: catalogue.isLoading ? "…" : routingGap,
      hint: "No production station",
      tone: routingGap ? "warning" : "success",
      onSelect: () => toggleLens("routing"),
      active: lens === "routing",
    },
    {
      id: "photo",
      label: "Missing photo",
      value: catalogue.isLoading ? "…" : photoGap,
      tone: photoGap ? "info" : "success",
      onSelect: () => toggleLens("photo"),
      active: lens === "photo",
    },
    {
      id: "recipe",
      label: "Consumption not configured",
      value: catalogue.isLoading ? "…" : recipeGap,
      hint: "No consumption posting",
      tone: recipeGap ? "info" : "success",
      onSelect: () => toggleLens("recipe"),
      active: lens === "recipe",
    },
  ];

  const activeFilters: ActiveFilterChip[] = [];
  if (menuFilter !== "all")
    activeFilters.push({ id: "menu", label: menuFilter, onClear: () => setMenuFilter("all") });
  if (publishFilter !== "all")
    activeFilters.push({
      id: "publish",
      label: titleCase(publishFilter),
      onClear: () => setPublishFilter("all"),
    });
  if (availFilter !== "all")
    activeFilters.push({
      id: "avail",
      label: titleCase(availFilter),
      onClear: () => setAvailFilter("all"),
    });
  if (importFilter !== "all")
    activeFilters.push({
      id: "origin",
      label: importFilter === "imported" ? "Imported" : "Created here",
      onClear: () => setImportFilter("all"),
    });
  if (sourceFilter !== "all")
    activeFilters.push({
      id: "source",
      label: STATION_SOURCE[sourceFilter] ?? sourceFilter,
      onClear: () => setSourceFilter("all"),
    });
  if (batchFilter !== "all")
    activeFilters.push({
      id: "batch",
      label: batchFilter === "none" ? "No import batch" : "Import batch",
      onClear: () => setBatchFilter("all"),
    });
  if (lens !== "none")
    activeFilters.push({
      id: "lens",
      label:
        lens === "draft"
          ? "Drafts only"
          : lens === "routing"
            ? "Missing routing"
            : lens === "photo"
              ? "Missing photo"
              : "Consumption not configured",
      onClear: () => setLens("none"),
    });

  const clearAll = () => {
    setMenuFilter("all");
    setPublishFilter("all");
    setAvailFilter("all");
    setImportFilter("all");
    setSourceFilter("all");
    setBatchFilter("all");
    setLens("none");
  };

  const inspected = filtered.find((r) => r.id === inspectId) ?? null;

  const recipeTone = (status: MenuRecipeStatus) =>
    menuConsumptionReady(status) ? "success" : status === "incomplete" ? "warning" : "default";

  /** Direct-from-stock and no-stock items are complete configurations. */
  const recipeLabel = (row: MenuCatalogueRow) =>
    row.recipe_status === "direct-stock"
      ? "Direct from stock"
      : row.recipe_status === "no-stock"
        ? "No stock consumption"
        : row.recipe_status === "linked"
          ? "Recipe linked"
          : row.recipe_status === "incomplete"
            ? "Recipe incomplete"
            : "No recipe";


  return (
    <div>
      <PageHeader
        eyebrow="Restaurant & POS"
        title="Menu Management"
        description="Define what each outlet sells, where each item is produced, and how it is priced and taxed."
        icon={BookOpen}
        actions={
          manage ? (
            <>
              <Button variant="ghost" asChild>
                <Link to="/admin/menu-imports">Import history</Link>
              </Button>
              <Button variant="outline" onClick={() => setImportDialog(true)}>
                Import menu file
              </Button>
              <Button
                onClick={() => {
                  setEditingItem(null);
                  setItemDialog(true);
                }}
              >
                New item
              </Button>
            </>
          ) : null
        }
      />

      <SummaryStrip
        lead={leadFigure}
        figures={figures}
        actions={
          manage && draftItems.length > 0 ? (
            <>
              <span className="text-sm text-muted-foreground">
                {draftItems.length} imported draft{draftItems.length === 1 ? "" : "s"} awaiting
                review — they are not sold on the terminal until published.
              </span>
              <Button
                size="sm"
                disabled={publishing}
                onClick={() => void publishDrafts(draftItems.map((d) => d.id))}
              >
                {publishing ? "Publishing…" : "Publish all drafts"}
              </Button>
            </>
          ) : null
        }
      />

      <Tabs defaultValue="items" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="items">Items</TabsTrigger>
          <TabsTrigger value="menus">Menus &amp; categories</TabsTrigger>
          <TabsTrigger value="modifiers">Modifiers</TabsTrigger>
        </TabsList>

        <TabsContent value="items" className="mt-0">
          <CatalogueWorkspace
            rail={
              <CatalogueRail
                title="Categories"
                items={railItems}
                value={categoryRail}
                onChange={setCategoryRail}
                allLabel="All items"
                allCount={catalogueRows.length}
                footer={
                  manage ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => setCatDialog(true)}
                    >
                      New category
                    </Button>
                  ) : null
                }
              />
            }
          >
            <CatalogueQueryBar
              search={search}
              onSearch={setSearch}
              placeholder="Search item, SKU or category"
              activeFilters={activeFilters}
              onClearAll={activeFilters.length ? clearAll : undefined}
              filters={
                <>
                  <div className="space-y-1.5">
                    <Label>Menu</Label>
                    <Select value={menuFilter} onValueChange={setMenuFilter}>
                      <SelectTrigger aria-label="Filter by menu">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All menus</SelectItem>
                        {catalogueMenus.map((m) => (
                          <SelectItem key={m} value={m}>
                            {m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Publication</Label>
                    <Select value={publishFilter} onValueChange={setPublishFilter}>
                      <SelectTrigger aria-label="Filter by publish status">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Published &amp; draft</SelectItem>
                        <SelectItem value="published">Published only</SelectItem>
                        <SelectItem value="draft">Drafts only</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Availability</Label>
                    <Select value={availFilter} onValueChange={setAvailFilter}>
                      <SelectTrigger aria-label="Filter by availability">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Any availability</SelectItem>
                        {MENU_AVAILABILITY.map((a) => (
                          <SelectItem key={a} value={a}>
                            {titleCase(a)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Origin</Label>
                    <Select value={importFilter} onValueChange={setImportFilter}>
                      <SelectTrigger aria-label="Filter by origin">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Any origin</SelectItem>
                        <SelectItem value="imported">Imported</SelectItem>
                        <SelectItem value="manual">Created here</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Routing source</Label>
                    <Select value={sourceFilter} onValueChange={setSourceFilter}>
                      <SelectTrigger aria-label="Filter by routing source">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Any routing source</SelectItem>
                        {catalogueSources.map((srcKey) => (
                          <SelectItem key={srcKey} value={srcKey}>
                            {STATION_SOURCE[srcKey] ?? srcKey}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Import batch</Label>
                    <Select value={batchFilter} onValueChange={setBatchFilter}>
                      <SelectTrigger aria-label="Filter by import batch">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Any import batch</SelectItem>
                        <SelectItem value="none">Created here (no batch)</SelectItem>
                        {catalogueBatches.map(([id, label]) => (
                          <SelectItem key={id} value={id}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              }
            />

            <QueryState
              isLoading={catalogue.isLoading}
              error={catalogue.error}
              isEmpty={catalogueRows.length === 0}
              empty={
                <EmptyState
                  icon={BookOpen}
                  title="No active menu items"
                  description="Create a menu, then categories, then the items your outlets actually sell — or publish an imported draft above."
                />
              }
            >
              {filtered.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No items match the current filters.
                </p>
              ) : (
                <div className="min-w-0">
                  {grouped.map(([groupName, rows]) => (
                    <CatalogueGroup key={groupName} label={groupName} count={rows.length}>
                      {rows.map((i) => (
                        <CatalogueRow
                          key={i.id}
                          selected={inspectId === i.id}
                          accent={
                            i.publish_status !== "published" || i.station_missing
                              ? "warning"
                              : i.availability !== "available"
                                ? "info"
                                : !menuConsumptionReady(i.recipe_status)
                                  ? "accent"
                                  : "success"
                          }
                          onOpen={() => setInspectId(i.id)}
                          media={<MenuItemImage path={i.image_url} name={i.name} size={44} />}

                          title={i.name}
                          subtitle={
                            [
                              i.sku,
                              i.menu_name,
                              !branchId ? (i.branch_name ?? "Organisation-wide") : null,
                            ]
                              .filter(Boolean)
                              .join(" · ") || undefined
                          }
                          chips={
                            <>
                              {i.publish_status !== "published" ? (
                                <StatusPill tone="warning">
                                  {titleCase(i.publish_status)}
                                </StatusPill>
                              ) : null}
                              {i.station_missing ? (
                                <StatusPill tone="warning">Not routed</StatusPill>
                              ) : (
                                <StatusPill tone="default">
                                  {i.station_name ?? "Station"} ·{" "}
                                  {STATION_SOURCE[i.station_source] ?? i.station_source}
                                </StatusPill>
                              )}
                              {i.availability !== "available" ? (
                                <StatusPill tone="info">{titleCase(i.availability)}</StatusPill>
                              ) : null}
                              {i.recipe_status !== "linked" ? (
                                <StatusPill tone={recipeTone(i.recipe_status)}>
                                  {recipeLabel(i)}
                                </StatusPill>
                              ) : null}
                              {!i.image_url ? (
                                <StatusPill tone="info">Photo missing</StatusPill>
                              ) : null}
                              {i.imported ? <StatusPill tone="info">Imported</StatusPill> : null}
                            </>
                          }
                          trailing={money(i.base_price)}
                          trailingLabel="Menu price"

                        />
                      ))}
                    </CatalogueGroup>
                  ))}
                </div>
              )}
            </QueryState>
          </CatalogueWorkspace>
        </TabsContent>

        <TabsContent value="menus" className="mt-0">
          <MenuCatalogueSection itemCounts={itemCounts} />
          <div className="surface-panel mt-6 rounded-2xl p-4 sm:p-5">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-2 border-b border-outline-subtle pb-2">
              <div className="min-w-0">
                <h2 className="text-base font-semibold tracking-tight">Categories by menu</h2>
                <p className="text-sm text-muted-foreground">
                  Structure shown to waiters on the terminal.
                </p>
              </div>
              {manage ? (
                <Button variant="outline" size="sm" onClick={() => setCatDialog(true)}>
                  New category
                </Button>
              ) : null}
            </div>
            {branchMenus.length === 0 ? (
              <EmptyState
                title="No menus"
                description="A menu groups categories for an outlet or service period."
              />
            ) : (
              <ul className="divide-y divide-outline-subtle text-sm">
                {branchMenus.map((m) => (
                  <li key={m.id} className="py-2.5">
                    <p className="font-medium">
                      {m.name}
                      {!branchId ? (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {branchLabel(m.branch_id)}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {(categories.data ?? [])
                        .filter((c) => c.menu_id === m.id)
                        .map((c) => c.name)
                        .join(", ") || "No categories yet"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </TabsContent>

        <TabsContent value="modifiers" className="mt-0">
          <div className="surface-panel rounded-2xl p-4 sm:p-5">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-2 border-b border-outline-subtle pb-2">
              <div className="min-w-0">
                <h2 className="text-base font-semibold tracking-tight">Modifier groups</h2>
                <p className="text-sm text-muted-foreground">
                  Options and extras attached to items.
                </p>
              </div>
              {manage ? (
                <div data-action-cluster className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => setGroupDialog(true)}>
                    New group
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setOptionDialog(true)}>
                    New option
                  </Button>
                </div>
              ) : null}
            </div>
            {(groups.data ?? []).length === 0 ? (
              <EmptyState
                title="No modifier groups"
                description="Create groups such as Milk choice, Doneness or Extras."
              />
            ) : (
              <ul className="divide-y divide-outline-subtle text-sm">
                {(groups.data ?? []).map((g) => (
                  <li key={g.id} className="py-2.5">
                    <p className="font-medium">{g.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {(g.modifier_options ?? [])
                        .map((o) => `${o.name} (${money(o.extra_charge)})`)
                        .join(", ") || "No options yet"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* Inspector: the item's full record without leaving the catalogue. */}
      <InspectorSheet
        open={Boolean(inspected)}
        onOpenChange={(open) => {
          if (!open) setInspectId(null);
        }}
        title={inspected?.name ?? ""}
        subtitle={
          inspected
            ? [inspected.category_name, inspected.menu_name].filter(Boolean).join(" · ")
            : undefined
        }
        media={
          inspected ? (
            <MenuItemImage path={inspected.image_url} name={inspected.name} size={64} />
          ) : null
        }
        chips={
          inspected ? (
            <>
              <StatusPill tone={inspected.publish_status === "published" ? "success" : "warning"}>
                {titleCase(inspected.publish_status)}
              </StatusPill>
              <StatusPill tone="default">{titleCase(inspected.availability)}</StatusPill>
              <StatusPill tone={recipeTone(inspected.recipe_status)}>
                {recipeLabel(inspected)}
              </StatusPill>
              {inspected.recipe_status === "direct-stock" && inspected.direct_stock_item_name ? (
                <StatusPill tone="default">
                  {inspected.direct_stock_item_name} · 1 sale ={" "}
                  {Number(inspected.direct_stock_quantity ?? 1)}{" "}
                  {inspected.direct_stock_unit ?? "unit"}
                </StatusPill>
              ) : null}
            </>
          ) : null
        }
        footer={
          inspected && manage ? (
            <>
              {inspected.publish_status === "draft" ? (
                <Button
                  variant="outline"
                  disabled={publishing}
                  onClick={() => void publishDrafts([inspected.id])}
                >
                  Publish
                </Button>
              ) : null}
              <Button
                onClick={() => {
                  setEditingItem({
                    id: inspected.id,
                    name: inspected.name,
                    branch_id: inspected.branch_id,
                    category_id: inspected.category_id,
                    department_id: inspected.department_id,
                    station_id: inspected.assigned_station_id,
                    base_price: inspected.base_price,
                    tax_rate: inspected.tax_rate,
                    availability: inspected.availability,
                    sku: inspected.sku,
                    image_url: inspected.image_url,
                    currency: inspected.currency,
                  });
                  setItemDialog(true);
                }}
              >
                Edit item
              </Button>
            </>
          ) : null
        }
        tabs={
          inspected
            ? [
                {
                  value: "overview",
                  label: "Overview",
                  content: (
                    <>
                      <InspectorSection title="Pricing">
                        <InspectorField label="Price">{money(inspected.base_price)}</InspectorField>
                        <InspectorField label="Tax rate">{inspected.tax_rate ?? 0}%</InspectorField>
                        <InspectorField label="Currency">
                          {inspected.currency ?? "—"}
                        </InspectorField>
                      </InspectorSection>
                      <InspectorSection title="Identity">
                        <InspectorField label="SKU">{inspected.sku ?? "Not set"}</InspectorField>
                        <InspectorField label="Property">
                          {inspected.branch_name ?? "Organisation-wide"}
                        </InspectorField>
                        <InspectorField label="Photo">
                          {inspected.image_url ? "Attached" : "Missing"}
                        </InspectorField>
                      </InspectorSection>
                      <InspectorSection title="Stock consumption">
                        <MenuConsumptionCard item={inspected} manage={manage} />
                      </InspectorSection>
                      <InspectorSection title="Sales channels">

                        {manage ? (
                          <label className="flex items-center gap-2 text-sm">
                            <Switch
                              checked={deliveryFlags.get(inspected.id) ?? false}
                              aria-label={`Sell ${inspected.name} on delivery`}
                              onCheckedChange={(v) =>
                                saveItem.mutate({
                                  id: inspected.id,
                                  values: { available_delivery: v },
                                })
                              }
                            />
                            Sell on delivery
                          </label>
                        ) : (
                          <InspectorField label="Delivery">
                            {deliveryFlags.get(inspected.id) ? "Enabled" : "Not sold on delivery"}
                          </InspectorField>
                        )}
                        {manage ? (
                          <div className="mt-3 space-y-1.5">
                            <Label>Availability</Label>
                            <Select
                              value={inspected.availability}
                              onValueChange={(v) =>
                                saveItem.mutate({ id: inspected.id, values: { availability: v } })
                              }
                            >
                              <SelectTrigger aria-label={`Availability for ${inspected.name}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {MENU_AVAILABILITY.map((a) => (
                                  <SelectItem key={a} value={a}>
                                    {titleCase(a)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        ) : null}
                      </InspectorSection>
                    </>
                  ),
                },
                {
                  value: "routing",
                  label: "Routing",
                  content: (
                    <InspectorSection title="Production station">
                      <InspectorField label="Effective station">
                        {inspected.station_missing
                          ? "Not routed — the terminal cannot send this item"
                          : (inspected.station_name ?? "Station")}
                      </InspectorField>
                      <InspectorField label="Source">
                        {STATION_SOURCE[inspected.station_source] ?? inspected.station_source}
                      </InspectorField>
                      <InspectorField label="Prep time">
                        {inspected.prep_minutes ? `${inspected.prep_minutes} min` : "Not set"}
                      </InspectorField>
                      {canAssignStation ? (
                        <div className="mt-3 space-y-1.5">
                          <Label>Assign station</Label>
                          <Select
                            value={inspected.assigned_station_id ?? "none"}
                            onValueChange={(v) =>
                              assignStation.mutate({
                                itemId: inspected.id,
                                stationId: v === "none" ? null : v,
                              })
                            }
                          >
                            <SelectTrigger
                              aria-label={`Production station for ${inspected.name}`}
                            >
                              <SelectValue placeholder="Assign station" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">Inherit from category</SelectItem>
                              {(stations.data ?? [])
                                .filter(
                                  (st) =>
                                    !inspected.branch_id ||
                                    !st.branch_id ||
                                    st.branch_id === inspected.branch_id,
                                )
                                .map((st) => (
                                  <SelectItem key={st.id} value={st.id}>
                                    {st.name}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ) : null}
                    </InspectorSection>
                  ),
                },
                {
                  value: "origin",
                  label: "Origin",
                  content: (
                    <InspectorSection title="Where this item came from">
                      {inspected.imported ? (
                        <>
                          <InspectorField label="Source">Imported</InspectorField>
                          <InspectorField label="File">
                            {inspected.import_file_name ?? "Unnamed file"}
                          </InspectorField>
                          <InspectorField label="Batch status">
                            {inspected.import_batch_status
                              ? titleCase(inspected.import_batch_status)
                              : "—"}
                          </InspectorField>
                          <InspectorField label="Batch">
                            <span className="font-mono text-xs">
                              {inspected.import_batch_id?.slice(0, 8) ?? "—"}
                            </span>
                          </InspectorField>
                        </>
                      ) : (
                        <InspectorField label="Source">Created here</InspectorField>
                      )}
                    </InspectorSection>
                  ),
                },
              ]
            : []
        }
      />

      <MenuImportDialog open={importDialog} onOpenChange={setImportDialog} />

      <RecordDialog
        open={catDialog}
        onOpenChange={setCatDialog}
        title="New category"
        fields={[{ name: "name", label: "Category name", required: true }]}
        selects={[
          {
            name: "menu_id",
            label: "Menu",
            options: branchMenus.map((m) => ({
              value: m.id,
              label: branchId ? m.name : `${m.name} · ${branchLabel(m.branch_id)}`,
            })),
          },
        ]}
        onSubmit={(values) => saveCategory.mutate({ values })}
      />
      {/* Property → department → station is chosen, and enforced, in one place. */}
      <MenuItemFormDialog open={itemDialog} onOpenChange={setItemDialog} item={editingItem} />

      <RecordDialog
        open={groupDialog}
        onOpenChange={setGroupDialog}
        title="New modifier group"
        fields={[
          { name: "name", label: "Group name", required: true },
          { name: "min_select", label: "Minimum selections", type: "number" },
          { name: "max_select", label: "Maximum selections", type: "number" },
        ]}
        onSubmit={(values) =>
          saveGroup.mutate({
            values: {
              name: values["name"],
              min_select: Number(values["min_select"] ?? 0),
              max_select: Number(values["max_select"] ?? 1) || 1,
            },
          })
        }
      />
      <RecordDialog
        open={optionDialog}
        onOpenChange={setOptionDialog}
        title="New modifier option"
        fields={[
          { name: "name", label: "Option name", required: true },
          { name: "extra_charge", label: "Extra charge", type: "number" },
        ]}
        selects={[
          {
            name: "group_id",
            label: "Group",
            options: (groups.data ?? []).map((g) => ({ value: g.id, label: g.name })),
          },
        ]}
        onSubmit={(values) =>
          saveOption.mutate({
            values: { ...values, extra_charge: Number(values["extra_charge"] ?? 0) },
          })
        }
      />
    </div>
  );
}
