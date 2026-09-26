/**
 * The Bar's view of the menu catalogue.
 *
 * This is a filtered lens on the single `menu_items` catalogue, not a separate
 * bar menu: an item appears here because its resolved production station is a
 * bar station of the selected property. Price, recipe and availability edits
 * open the canonical Menu Management surface so there is one owner of the data.
 */
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { GlassWater } from "lucide-react";
import {
  Atomic,
  PageHeader,
  RowActions,
  SectionCard,
  StatCard,
  StatusPill,
  TableScroll,
} from "@/components/common/DataDisplay";
import { BarGuard, EmptyState, QueryState } from "@/components/bar/BarShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MenuItemImage } from "@/components/pos/MenuImageField";
import { useAuth } from "@/lib/auth";
import { money, titleCase } from "@/lib/pos";
import { menuConsumptionReady, type MenuRecipeStatus } from "@/lib/pos-data";

import { useBarMenu, type BarMenuItem } from "@/lib/bar";

export const Route = createFileRoute("/_shell/bar/menu")({
  head: () => ({
    meta: [
      { title: "Bar Menu — NEØ" },
      {
        name: "description",
        content:
          "The bar-assigned slice of the shared menu catalogue: prices, recipes, photos and availability for every drink routed to a bar station.",
      },
      { property: "og:title", content: "Bar Menu — NEØ" },
      {
        property: "og:description",
        content:
          "Bar drinks list drawn from the single menu catalogue, with recipe and availability status.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <BarGuard action="menu.view">
      <BarMenuPage />
    </BarGuard>
  ),
});

const RECIPE_TONE: Record<string, "success" | "warning" | "destructive" | "default"> = {
  linked: "success",
  "direct-stock": "success",
  // Deliberately sold without touching stock — complete, not a gap.
  "no-stock": "default",
  incomplete: "warning",
  "not-linked": "destructive",
};

const RECIPE_LABEL: Record<string, string> = {
  linked: "Recipe linked",
  // Sold straight from a stock item — a complete configuration, not a gap.
  "direct-stock": "Direct from stock",
  "no-stock": "No stock consumption",
  incomplete: "Recipe empty",
  "not-linked": "No recipe",
};


function BarMenuPage() {
  const { can, isAdmin } = useAuth();
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [search, setSearch] = useState("");
  const menu = useBarMenu(includeDrafts);

  const mayEdit = isAdmin || can("pos", "menu", "manage");
  const items = (menu.data ?? []) as BarMenuItem[];
  const query = search.trim().toLowerCase();
  const rows = useMemo(
    () =>
      items.filter(
        (i) =>
          !query ||
          i.name.toLowerCase().includes(query) ||
          (i.sku ?? "").toLowerCase().includes(query) ||
          (i.category_name ?? "").toLowerCase().includes(query),
      ),
    [items, query],
  );

  const unavailable = items.filter((i) => i.availability !== "available").length;
  const missingRecipe = items.filter(
    (i) => !menuConsumptionReady(i.recipe_status as MenuRecipeStatus),
  ).length;


  const missingPhoto = items.filter((i) => !i.image_url).length;

  return (
    <div>
      <PageHeader
        eyebrow="Bar Department"
        title="Bar Menu"
        description="Everything the bar is responsible for pouring. These are the same catalogue records the restaurant and guest app read, filtered to bar stations."
        actions={
          mayEdit ? (
            <Button asChild>
              <Link to="/pos/menu">Open Menu Management</Link>
            </Button>
          ) : null
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Bar items" value={String(items.length)} hint="Routed to a bar station" />
        <StatCard
          label="Not sellable"
          value={String(unavailable)}
          hint="Sold out or disabled"
          tone={unavailable ? "warning" : "default"}
        />
        <StatCard
          label="Missing recipe"
          value={String(missingRecipe)}
          hint="Stock will not deplete on sale"
          tone={missingRecipe ? "warning" : "default"}
        />
        <StatCard
          label="Missing photo"
          value={String(missingPhoto)}
          hint="Shown in guest ordering"
        />
      </div>

      <SectionCard
        title="Drinks catalogue"
        description="Edits belong to Menu Management so pricing, recipes and tax stay consistent across every outlet."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Switch
                id="bar-menu-drafts"
                checked={includeDrafts}
                onCheckedChange={setIncludeDrafts}
              />
              <Label htmlFor="bar-menu-drafts" className="text-xs">
                Include drafts
              </Label>
            </div>
            <Input
              className="w-44 sm:w-56"
              placeholder="Search drinks"
              aria-label="Search bar menu"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        }
      >
        <QueryState
          isLoading={menu.isLoading}
          error={menu.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              icon={GlassWater}
              title="No bar items yet"
              description="An item appears here once it is published and routed to a bar station for this property. Assign the station in Menu Management or in kitchen routing."
            />
          }
        >
          <TableScroll>
            <Table className="neo-list-rows">
              <TableHeader>
                <TableRow>
                  <TableHead className="neo-sticky-col">Item</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Station</TableHead>
                  <TableHead>Availability</TableHead>
                  <TableHead>Recipe</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Tax</TableHead>
                  {mayEdit ? <TableHead className="text-right">Manage</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="neo-sticky-col">
                      <div className="flex items-center gap-3">
                        <MenuItemImage path={item.image_url} name={item.name} size={36} />
                        <div className="min-w-0">
                          <p className="neo-line-1 max-w-[14rem] font-medium" title={item.name}>
                            {item.name}
                          </p>
                          <p className="neo-line-1 text-xs text-muted-foreground">
                            {item.sku ?? "No SKU"}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="neo-line-1 max-w-[12rem]" title={item.category_name ?? "—"}>
                        {item.category_name ?? "—"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="neo-line-1 max-w-[12rem]" title={item.station_name ?? "—"}>
                        {item.station_name ?? "—"}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <StatusPill tone={item.availability === "available" ? "success" : "warning"}>
                        {titleCase(item.availability)}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <StatusPill tone={RECIPE_TONE[item.recipe_status] ?? "default"}>
                        {RECIPE_LABEL[item.recipe_status] ?? titleCase(item.recipe_status)}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="text-right">
                      <Atomic>{money(item.base_price, item.currency ?? "KES")}</Atomic>
                    </TableCell>
                    <TableCell className="text-right">
                      <Atomic>{item.tax_rate == null ? "—" : `${Number(item.tax_rate)}%`}</Atomic>
                    </TableCell>
                    {mayEdit ? (
                      <TableCell className="whitespace-nowrap text-right">
                        <RowActions>
                          <Button size="sm" variant="outline" asChild>
                            <Link to="/pos/menu">Edit</Link>
                          </Button>
                        </RowActions>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </SectionCard>
    </div>
  );
}
