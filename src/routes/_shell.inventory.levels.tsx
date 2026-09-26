/**
 * Stock levels by item group and category, plus the master inventory view.
 *
 * Everything here is read-only: it reports what the catalogue and the stock
 * ledger already hold. The master list is the owner-supplied reference sheet,
 * used only to say which supplied items exist in the catalogue and which do
 * not — it never creates or renames anything.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, Boxes, PackageX, Search, TrendingDown } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { OpsGuard } from "@/components/operations/OpsShared";
import { QueryState } from "@/components/pms/PmsShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatQuantity, healthLabel, healthTone, num, stockHealth, type Row } from "@/lib/inventory";
import {
  useBranchThresholds,
  useRaiseReorderRequest,
  useSaveStockThresholds,
  useStockItems,
  useStockLocations,
} from "@/lib/inventory-data";
import { ReorderRulesImport } from "@/components/inventory/ReorderRulesImport";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter, useWriteBranchId } from "@/lib/branch-filter";
import { MASTER_INVENTORY, MASTER_ITEM_KEYS, masterKey } from "@/lib/inventory-master-list";
import { useItemGroups, useStockCategories } from "@/lib/stock-hierarchy";


export const Route = createFileRoute("/_shell/inventory/levels")({
  head: () => ({
    meta: [
      { title: "Stock Levels & Master List — NEØ" },
      {
        name: "description",
        content:
          "Stock on hand by item group and category, reorder alerts, and the full item group → category → stock item master list.",
      },
      { property: "og:title", content: "Stock Levels & Master List — NEØ" },
      {
        property: "og:description",
        content:
          "Track which items are running low by group and category, and see what is mapped and what is missing.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard path="/inventory/levels">
      <StockLevelsPage />
    </OpsGuard>
  ),
});

type ItemView = {
  id: string;
  name: string;
  sku: string;
  unit: string;
  onHand: number;
  min: number;
  reorder: number;
  par: number;
  active: boolean;
  categoryId: string | null;
  categoryName: string;
  groupId: string | null;
  groupName: string;
  onMasterList: boolean;
  /** The catalogue row itself, so a reorder alert can raise a purchase request. */
  raw: Row;
};

/**
 * On-hand for one item. With a property selected in the header only that
 * property's stores count, so the balance matches the branch Procurement
 * dashboard and the weekly report rather than an organisation-wide total.
 */
function onHandOf(item: Row, allowedLocations: Set<string> | null): number {
  const levels = (item["stock_levels"] ?? []) as Row[];
  return levels.reduce((total, level) => {
    const location = level["location_id"] == null ? null : String(level["location_id"]);
    if (allowedLocations && (location === null || !allowedLocations.has(location))) return total;
    return total + num(level["quantity_on_hand"]);
  }, 0);
}

function StockLevelsPage() {
  const items = useStockItems();
  const groups = useItemGroups();
  const categories = useStockCategories();

  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [scope, setScope] = useState<"all" | "master" | "missing" | "extra">("all");
  const [tab, setTab] = useState("dashboard");
  const [bulkBusy, setBulkBusy] = useState(false);
  /** Unsaved reorder point / par level typed against a stock item id. */
  const [rules, setRules] = useState<Record<string, { reorder: string; par: string }>>({});

  // Replenishment always goes through the canonical purchase request: this
  // page raises a DRAFT only, and Procurement still sources and approves.
  const { can } = useAuth();
  const writeBranchId = useWriteBranchId();
  const raiseRequest = useRaiseReorderRequest();
  const mayRequest = can("procurement", "requests", "create") && Boolean(writeBranchId);
  const saveThresholds = useSaveStockThresholds();
  const mayEditLevels = can("inventory", "items", "edit");

  // Each property keeps its own reorder point and par level; the catalogue
  // figure stays the fallback where a property has not set its own. Reading
  // the override here is what makes this page and the branch Procurement
  // dashboard show the same alerts.
  const branchThresholds = useBranchThresholds();
  const { branchId: activeBranchId } = useActivePropertyFilter();
  const locations = useStockLocations();
  // The stores query is already scoped to the header selection, so with one
  // property chosen this is exactly that property's stores.
  const allowedLocations = useMemo(
    () =>
      activeBranchId
        ? new Set((locations.data ?? []).map((l) => String((l as Row)["id"])))
        : null,
    [activeBranchId, locations.data],
  );

  const views = useMemo<ItemView[]>(() => {
    const categoryById = new Map((categories.data ?? []).map((c) => [c.id, c]));
    const groupById = new Map((groups.data ?? []).map((g) => [g.id, g]));
    const overrides = branchThresholds.data;
    return ((items.data ?? []) as Row[]).map((row) => {
      const categoryId = (row["category_id"] as string | null) ?? null;
      const category = categoryId ? categoryById.get(categoryId) : undefined;
      const group = category?.groupId ? groupById.get(category.groupId) : undefined;
      const min = num(row["min_level"]);
      const id = String(row["id"]);
      const override = overrides?.get(id);
      return {
        id,
        name: String(row["name"] ?? "Unnamed"),
        sku: String(row["sku"] ?? ""),
        unit: String(row["base_unit"] ?? ""),
        onHand: onHandOf(row, allowedLocations),
        min,
        reorder: override?.reorder ?? (num(row["reorder_point"]) || min),
        par: override?.par ?? (num(row["par_level"]) || num(row["max_level"])),
        active: row["active"] !== false,
        categoryId,
        categoryName: category?.name ?? "Not categorised",
        groupId: category?.groupId ?? null,
        groupName: group?.name ?? "No item group",
        onMasterList: MASTER_ITEM_KEYS.has(masterKey(String(row["name"] ?? ""))),
        raw: row,
      };
    });
  }, [items.data, categories.data, groups.data, branchThresholds.data, allowedLocations]);


  const live = views.filter((v) => v.active);
  const out = live.filter((v) => v.onHand <= 0);
  const belowReorder = live.filter((v) => v.onHand > 0 && v.reorder > 0 && v.onHand <= v.reorder);

  /** Group totals for the dashboard: one row per item group. */
  const groupRows = useMemo(() => {
    const map = new Map<
      string,
      { name: string; categories: Set<string>; items: number; low: number; out: number }
    >();
    for (const v of live) {
      const key = v.groupId ?? "__none__";
      const entry = map.get(key) ?? {
        name: v.groupName,
        categories: new Set<string>(),
        items: 0,
        low: 0,
        out: 0,
      };
      entry.categories.add(v.categoryName);
      entry.items += 1;
      if (v.onHand <= 0) entry.out += 1;
      else if (v.reorder > 0 && v.onHand <= v.reorder) entry.low += 1;
      map.set(key, entry);
    }
    return [...map.values()].sort((a, b) => b.out + b.low - (a.out + a.low) || a.name.localeCompare(b.name));
  }, [live]);

  /** Category totals inside whichever group is selected on the dashboard. */
  const categoryRows = useMemo(() => {
    const map = new Map<string, { group: string; name: string; items: number; low: number; out: number }>();
    for (const v of live) {
      const entry = map.get(v.categoryId ?? `none-${v.groupName}`) ?? {
        group: v.groupName,
        name: v.categoryName,
        items: 0,
        low: 0,
        out: 0,
      };
      entry.items += 1;
      if (v.onHand <= 0) entry.out += 1;
      else if (v.reorder > 0 && v.onHand <= v.reorder) entry.low += 1;
      map.set(v.categoryId ?? `none-${v.groupName}`, entry);
    }
    return [...map.values()]
      .filter((r) => r.low + r.out > 0)
      .sort((a, b) => b.out + b.low - (a.out + a.low) || a.name.localeCompare(b.name));
  }, [live]);

  const alerts = [...out, ...belowReorder].sort((a, b) => a.onHand - b.onHand || a.name.localeCompare(b.name));

  /** Buy back up to par where a par level is set, otherwise to the reorder point. */
  function orderQuantity(v: ItemView): number {
    const target = v.par > 0 ? v.par : v.reorder;
    return Math.max(Math.round((target - v.onHand + Number.EPSILON) * 1000) / 1000, 0);
  }

  function requestPayload(v: ItemView) {
    return {
      item: { ...v.raw, on_hand: v.onHand, min_level: v.min, par_level: v.par } as Row,
      quantity: orderQuantity(v),
      justification: `On hand ${v.onHand} against a reorder point of ${v.reorder}${v.par > 0 ? ` and a par level of ${v.par}` : ""}.`,
    };
  }

  /**
   * Raises one draft request per alerted item. The database refuses a second
   * open request for the same item at the same property, so a repeat run
   * leaves the earlier request alone instead of duplicating it.
   */
  async function raiseAll() {
    setBulkBusy(true);
    let raised = 0;
    let skipped = 0;
    let refused = 0;
    let lastRefusal = "";
    try {
      for (const v of alerts) {
        if (orderQuantity(v) <= 0) {
          skipped += 1;
          continue;
        }
        try {
          await raiseRequest.mutateAsync(requestPayload(v));
          raised += 1;
        } catch (e) {
          // Already-open requests and refusals are counted, never hidden.
          refused += 1;
          lastRefusal = e instanceof Error ? e.message : String(e);
        }
      }
    } finally {
      setBulkBusy(false);
    }

    if (raised === 0 && refused === 0 && skipped === 0) {
      toast.info("Nothing to request — no item is below its reorder point.");
    } else if (raised === 0) {
      toast.warning(
        `No new request was raised. ${refused} item${refused === 1 ? "" : "s"} already had an open request or were refused${skipped ? `, ${skipped} had no shortfall quantity` : ""}.${lastRefusal ? ` Last reason: ${lastRefusal}` : ""}`,
      );
    } else {
      toast.success(
        `Raised ${raised} request${raised === 1 ? "" : "s"}.${refused ? ` ${refused} skipped (already open or refused).` : ""}${skipped ? ` ${skipped} had no shortfall quantity.` : ""}`,
      );
    }
  }


  /** Master-list rows: catalogue items plus supplied items that are absent. */
  const masterRows = useMemo(() => {
    const present = new Set(views.map((v) => masterKey(v.name)));
    const rows: Array<{
      key: string;
      group: string;
      category: string;
      item: string;
      unit: string;
      onHand: number | null;
      status: "mapped" | "missing" | "extra";
    }> = views.map((v) => ({
      key: v.id,
      group: v.groupName,
      category: v.categoryName,
      item: v.name,
      unit: v.unit,
      onHand: v.onHand,
      status: v.onMasterList ? "mapped" : "extra",
    }));
    for (const group of MASTER_INVENTORY) {
      for (const item of group.items) {
        if (present.has(masterKey(item))) continue;
        rows.push({
          key: `missing-${group.group}-${item}`,
          group: group.group,
          category: "—",
          item,
          unit: "",
          onHand: null,
          status: "missing",
        });
      }
    }
    return rows.sort(
      (a, b) => a.group.localeCompare(b.group) || a.category.localeCompare(b.category) || a.item.localeCompare(b.item),
    );
  }, [views]);

  const term = search.trim().toLowerCase();
  const filteredMaster = masterRows.filter((r) => {
    if (scope === "master" && r.status === "extra") return false;
    if (scope === "missing" && r.status !== "missing") return false;
    if (scope === "extra" && r.status !== "extra") return false;
    if (groupFilter !== "all" && r.group !== groupFilter) return false;
    if (!term) return true;
    return `${r.group} ${r.category} ${r.item}`.toLowerCase().includes(term);
  });

  /** Catalogue items shown in the reorder-rules editor, under the same filters. */
  const editableItems = views.filter((v) => {
    if (groupFilter !== "all" && v.groupName !== groupFilter) return false;
    if (!term) return true;
    return `${v.groupName} ${v.categoryName} ${v.name}`.toLowerCase().includes(term);
  });

  const missingCount = masterRows.filter((r) => r.status === "missing").length;
  const groupNames = [...new Set(masterRows.map((r) => r.group))].sort((a, b) => a.localeCompare(b));
  const loading = items.isLoading || groups.isLoading || categories.isLoading;
  const error = items.error ?? groups.error ?? categories.error;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Inventory & Stores"
        title="Stock levels & master list"
        description="What is on hand by item group and category, which items have fallen to or below their reorder point, and how the catalogue compares with your master inventory list."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Items tracked" value={String(live.length)} icon={Boxes} lead />
        <StatCard
          label="At or below reorder point"
          value={String(belowReorder.length)}
          hint="Still in stock, but due for replenishment"
          icon={TrendingDown}
          tone={belowReorder.length > 0 ? "warning" : "success"}
        />
        <StatCard
          label="Out of stock"
          value={String(out.length)}
          icon={PackageX}
          tone={out.length > 0 ? "destructive" : "success"}
        />
        <StatCard
          label="Master items not in catalogue"
          value={String(missingCount)}
          hint="From your supplied master list"
          icon={AlertTriangle}
          tone={missingCount > 0 ? "warning" : "success"}
        />
      </div>

      <QueryState
        isLoading={loading}
        error={error}
        isEmpty={!loading && views.length === 0}
        empty="No stock items in the catalogue yet."
        skeleton="table"
      >

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="dashboard">Stock levels</TabsTrigger>
            <TabsTrigger value="master">Master inventory</TabsTrigger>
            <TabsTrigger value="rules">Reorder rules</TabsTrigger>
          </TabsList>

          <TabsContent value="rules" className="space-y-6">
            <ReorderRulesImport
              canEdit={mayEditLevels}
              scopeLabel={activeBranchId ? "the property selected in the header" : "every property"}
              targets={views.map((v) => ({
                id: v.id,
                name: v.name,
                sku: v.sku,
                unit: v.unit,
                reorder: v.reorder,
                par: v.par,
              }))}
            />

            <SectionCard
              title="Reorder points and par levels"
              description="Set the quantity at which an item counts as low, and the quantity to buy back up to. Alerts and replenishment requests both follow these figures."
            >
              {!mayEditLevels ? (
                <p className="py-6 text-sm text-muted-foreground">
                  You can see these figures but not change them. Ask an inventory manager to adjust
                  them.
                </p>
              ) : null}
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <div className="relative min-w-[200px] flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search item, category or group"
                    className="pl-9"
                    aria-label="Search stock items"
                  />
                </div>
                <Select value={groupFilter} onValueChange={setGroupFilter}>
                  <SelectTrigger className="w-full sm:w-[200px]" aria-label="Filter by item group">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All item groups</SelectItem>
                    {groupNames.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="max-h-[32rem] overflow-auto rounded-xl border border-border">
                <Table>
                  <TableHeader className="sticky top-0 bg-card">
                    <TableRow>
                      <TableHead>Stock item</TableHead>
                      <TableHead>Item group / category</TableHead>
                      <TableHead className="text-right">On hand</TableHead>
                      <TableHead className="text-right">Reorder point</TableHead>
                      <TableHead className="text-right">Par level</TableHead>
                      <TableHead className="text-right">Save</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {editableItems.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                          Nothing matches this filter.
                        </TableCell>
                      </TableRow>
                    ) : (
                      editableItems.map((v) => {
                        const draft = rules[v.id];
                        const reorder = draft?.reorder ?? String(v.reorder);
                        const par = draft?.par ?? String(v.par);
                        const changed =
                          Number(reorder) !== v.reorder || Number(par) !== v.par;
                        return (
                          <TableRow key={v.id}>
                            <TableCell className="font-medium">
                              {v.name}
                              <span className="ml-1 text-xs text-muted-foreground">{v.unit}</span>
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {`${v.groupName} · ${v.categoryName}`}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatQuantity(v.onHand, v.unit)}
                            </TableCell>
                            <TableCell className="text-right">
                              <Input
                                type="number"
                                min={0}
                                step="0.01"
                                className="ml-auto w-24 text-right"
                                value={reorder}
                                disabled={!mayEditLevels}
                                aria-label={`Reorder point for ${v.name}`}
                                onChange={(e) =>
                                  setRules((r) => ({
                                    ...r,
                                    [v.id]: { reorder: e.target.value, par },
                                  }))
                                }
                              />
                            </TableCell>
                            <TableCell className="text-right">
                              <Input
                                type="number"
                                min={0}
                                step="0.01"
                                className="ml-auto w-24 text-right"
                                value={par}
                                disabled={!mayEditLevels}
                                aria-label={`Par level for ${v.name}`}
                                onChange={(e) =>
                                  setRules((r) => ({
                                    ...r,
                                    [v.id]: { reorder, par: e.target.value },
                                  }))
                                }
                              />
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={!mayEditLevels || !changed || saveThresholds.isPending}
                                onClick={() =>
                                  saveThresholds.mutate(
                                    {
                                      id: v.id,
                                      reorderPoint: Number(reorder) || 0,
                                      parLevel: Number(par) || 0,
                                    },
                                    {
                                      onSuccess: () =>
                                        setRules((r) => {
                                          const next = { ...r };
                                          delete next[v.id];
                                          return next;
                                        }),
                                    },
                                  )
                                }
                              >
                                Save
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </SectionCard>
          </TabsContent>

          <TabsContent value="dashboard" className="space-y-6">
            <SectionCard
              title="By item group"
              description="Every group with the number of items sitting at or below their reorder point."
              accent
            >
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item group</TableHead>
                      <TableHead className="text-right">Categories</TableHead>
                      <TableHead className="text-right">Items</TableHead>
                      <TableHead className="text-right">Low</TableHead>
                      <TableHead className="text-right">Out</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {groupRows.map((row) => (
                      <TableRow key={row.name}>
                        <TableCell className="font-medium">{row.name}</TableCell>
                        <TableCell className="text-right">{row.categories.size}</TableCell>
                        <TableCell className="text-right">{row.items}</TableCell>
                        <TableCell className="text-right">
                          {row.low > 0 ? (
                            <StatusPill tone="warning">{row.low}</StatusPill>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {row.out > 0 ? (
                            <StatusPill tone="destructive">{row.out}</StatusPill>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </SectionCard>

            <SectionCard
              title="Categories needing attention"
              description="Only categories that currently hold a low or out-of-stock item."
            >
              {categoryRows.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No category is below its reorder point.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Category</TableHead>
                        <TableHead>Item group</TableHead>
                        <TableHead className="text-right">Items</TableHead>
                        <TableHead className="text-right">Low</TableHead>
                        <TableHead className="text-right">Out</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {categoryRows.map((row) => (
                        <TableRow key={`${row.group}-${row.name}`}>
                          <TableCell className="font-medium">{row.name}</TableCell>
                          <TableCell className="text-muted-foreground">{row.group}</TableCell>
                          <TableCell className="text-right">{row.items}</TableCell>
                          <TableCell className="text-right">{row.low}</TableCell>
                          <TableCell className="text-right">{row.out}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </SectionCard>

            <SectionCard
              title="Reorder alerts"
              description="Items out of stock or at their reorder point, lowest first. Raising a request creates a draft for Procurement — nothing is ordered here."
              actions={
                mayRequest && alerts.length > 0 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={bulkBusy || raiseRequest.isPending}
                    onClick={() => void raiseAll()}
                  >
                    {bulkBusy ? "Raising requests…" : `Raise requests for all ${alerts.length}`}
                  </Button>
                ) : null
              }
            >
              {alerts.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Nothing is running low right now.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead>Item group</TableHead>
                        <TableHead className="text-right">On hand</TableHead>
                        <TableHead className="text-right">Reorder at</TableHead>
                        <TableHead className="text-right">Par</TableHead>
                        <TableHead>Status</TableHead>
                        {mayRequest ? <TableHead className="text-right">Replenish</TableHead> : null}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {alerts.map((v) => {
                        const health = stockHealth(v.onHand, v.reorder, v.par || null);
                        return (
                          <TableRow key={v.id}>
                            <TableCell className="font-medium">{v.name}</TableCell>
                            <TableCell className="text-muted-foreground">{v.categoryName}</TableCell>
                            <TableCell className="text-muted-foreground">{v.groupName}</TableCell>
                            <TableCell className="text-right">{formatQuantity(v.onHand, v.unit)}</TableCell>
                            <TableCell className="text-right">{formatQuantity(v.reorder, v.unit)}</TableCell>
                            <TableCell className="text-right">
                              {v.par > 0 ? formatQuantity(v.par, v.unit) : "—"}
                            </TableCell>
                            <TableCell>
                              <StatusPill tone={healthTone(health)}>{healthLabel(health)}</StatusPill>
                            </TableCell>
                            {mayRequest ? (
                              <TableCell className="text-right">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={bulkBusy || raiseRequest.isPending || orderQuantity(v) <= 0}
                                  onClick={() => raiseRequest.mutate(requestPayload(v))}
                                >
                                  {`Request ${formatQuantity(orderQuantity(v), v.unit)}`}
                                </Button>
                              </TableCell>
                            ) : null}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </SectionCard>
          </TabsContent>

          <TabsContent value="master">
            <SectionCard
              title="Master inventory"
              description="Every item group, category and stock item in one table, with your supplied master list checked against the catalogue."
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setTab("dashboard")}>
                    Stock levels & reorder alerts
                    {alerts.length > 0 ? ` (${alerts.length})` : ""}
                  </Button>
                  <Button variant="ghost" size="sm" asChild>
                    <Link to="/procurement/requests">Purchase requests</Link>
                  </Button>
                  <Button variant="ghost" size="sm" asChild>
                    <Link to="/procurement/orders">Purchase orders</Link>
                  </Button>
                </div>
              }
            >
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <div className="relative min-w-[200px] flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search group, category or item"
                    className="pl-9"
                    aria-label="Search the master inventory"
                  />
                </div>
                <Select value={scope} onValueChange={(v) => setScope(v as typeof scope)}>
                  <SelectTrigger className="w-full sm:w-[220px]" aria-label="Filter by master list">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Everything</SelectItem>
                    <SelectItem value="master">My master list only</SelectItem>
                    <SelectItem value="missing">Missing from catalogue</SelectItem>
                    <SelectItem value="extra">Not on my master list</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={groupFilter} onValueChange={setGroupFilter}>
                  <SelectTrigger className="w-full sm:w-[200px]" aria-label="Filter by item group">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All item groups</SelectItem>
                    {groupNames.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <p className="mb-3 text-xs text-muted-foreground">
                Showing {filteredMaster.length} of {masterRows.length} rows.
              </p>

              <div className="max-h-[32rem] overflow-auto rounded-xl border border-border">
                <Table>
                  <TableHeader className="sticky top-0 bg-card">
                    <TableRow>
                      <TableHead>Item group</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Stock item</TableHead>
                      <TableHead className="text-right">On hand</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredMaster.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                          Nothing matches this filter.
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredMaster.map((row) => (
                        <TableRow key={row.key}>
                          <TableCell>{row.group}</TableCell>
                          <TableCell className="text-muted-foreground">{row.category}</TableCell>
                          <TableCell className="font-medium">{row.item}</TableCell>
                          <TableCell className="text-right">
                            {row.onHand === null ? "—" : formatQuantity(row.onHand, row.unit)}
                          </TableCell>
                          <TableCell>
                            {row.status === "mapped" ? (
                              <StatusPill tone="success">On master list</StatusPill>
                            ) : row.status === "missing" ? (
                              <StatusPill tone="warning">Not in catalogue</StatusPill>
                            ) : (
                              <StatusPill tone="default">Extra item</StatusPill>
                            )}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </SectionCard>
          </TabsContent>
        </Tabs>
      </QueryState>
    </div>
  );
}
