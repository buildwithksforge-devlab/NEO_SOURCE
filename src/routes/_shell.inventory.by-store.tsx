/**
 * Stock by store.
 *
 * One store at a time: what is sealed on the shelf, and what is left in the
 * bottles already open. The two balances are deliberately never added
 * together — a sealed 750 ml bottle and 420 ml poured out of another one are
 * different things, and a bar count reconciles them separately.
 *
 * Read-only. Every figure comes from the stock ledger and the open-container
 * ledger; nothing here changes a balance.
 */
import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Boxes, Search, Wine } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { OpsGuard } from "@/components/operations/OpsShared";
import { QueryState } from "@/components/common/StateSystem";
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
import { formatQuantity, num, type Row } from "@/lib/inventory";
import { useStockItems, useStockLocations } from "@/lib/inventory-data";
import { formatMl, useAllOpenContainers } from "@/lib/bottle-stock";

export const Route = createFileRoute("/_shell/inventory/by-store")({
  head: () => ({
    meta: [
      { title: "Stock by Store — NEØ" },
      {
        name: "description",
        content:
          "Sealed containers and open millilitres held in each store, so a bar or beverage store balance can be read on its own.",
      },
      { property: "og:title", content: "Stock by Store — NEØ" },
      {
        property: "og:description",
        content: "Sealed and open balances per store, counted separately as a bar count does.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard path="/inventory/by-store">
      <StockByStorePage />
    </OpsGuard>
  ),
});

const str = (v: unknown, fallback = "") => (v == null ? fallback : String(v));

type StoreLine = {
  itemId: string;
  name: string;
  sku: string;
  unit: string;
  sealed: number;
  containerType: string | null;
  containerVolumeMl: number | null;
  tracking: string | null;
  openMl: number;
  containersOpen: number;
  lastOpenedAt: string | null;
};

function StockByStorePage() {
  const locations = useStockLocations();
  const items = useStockItems();
  const open = useAllOpenContainers();

  const [locationId, setLocationId] = useState("");
  const [search, setSearch] = useState("");

  const locationRows = (locations.data ?? []) as Row[];
  const activeLocation = locationId || (locationRows[0] ? str(locationRows[0]["id"]) : "");

  const lines = useMemo<StoreLine[]>(() => {
    if (!activeLocation) return [];
    const openByItem = new Map<string, { ml: number; containers: number; at: string | null }>();
    for (const row of open.data ?? []) {
      if (String(row.location_id) !== activeLocation) continue;
      const prev = openByItem.get(String(row.stock_item_id));
      openByItem.set(String(row.stock_item_id), {
        ml: (prev?.ml ?? 0) + Number(row.open_volume_ml ?? 0),
        containers: (prev?.containers ?? 0) + Number(row.containers_open ?? 0),
        at: prev?.at ?? row.last_opened_at,
      });
    }

    const rows: StoreLine[] = [];
    for (const item of (items.data ?? []) as Row[]) {
      const levels = (item["stock_levels"] ?? []) as Row[];
      const sealed = levels
        .filter((level) => str(level["location_id"]) === activeLocation)
        .reduce((total, level) => total + num(level["quantity_on_hand"]), 0);
      const openRow = openByItem.get(str(item["id"]));
      // A line earns its place if the store holds it sealed, or holds an open
      // container of it — including one poured down to zero.
      if (sealed === 0 && !openRow) continue;
      rows.push({
        itemId: str(item["id"]),
        name: str(item["name"], "Unnamed item"),
        sku: str(item["sku"]),
        unit: str(item["base_unit"], "unit"),
        sealed,
        containerType: item["container_type"] == null ? null : str(item["container_type"]),
        containerVolumeMl: item["container_volume_ml"] == null ? null : num(item["container_volume_ml"]),
        tracking: item["tracking_method"] == null ? null : str(item["tracking_method"]),
        openMl: openRow?.ml ?? 0,
        containersOpen: openRow?.containers ?? 0,
        lastOpenedAt: openRow?.at ?? null,
      });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }, [activeLocation, items.data, open.data]);

  const term = search.trim().toLowerCase();
  const visible = term
    ? lines.filter((l) => l.name.toLowerCase().includes(term) || l.sku.toLowerCase().includes(term))
    : lines;

  const pourable = lines.filter((l) => l.openMl > 0 || l.containersOpen > 0);
  const totalOpenMl = pourable.reduce((t, l) => t + l.openMl, 0);
  const storeName =
    locationRows.find((l) => str(l["id"]) === activeLocation)?.["name"] ?? "Store";

  const loading = locations.isLoading || items.isLoading || open.isLoading;
  const error = locations.error ?? items.error ?? open.error;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Stock by Store"
        description="Sealed containers and open millilitres held in one store. The two are reported apart, the way a bar counts them."
      />

      <SectionCard
        title="Choose a store"
        description="Balances are shown for the selected store only, never rolled up across stores."
        icon={Boxes}
        accent
      >
        <div className="grid gap-3 sm:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <Select value={activeLocation} onValueChange={setLocationId}>
            <SelectTrigger aria-label="Store">
              <SelectValue placeholder="Select a store" />
            </SelectTrigger>
            <SelectContent>
              {locationRows.map((l) => (
                <SelectItem key={str(l["id"])} value={str(l["id"])}>
                  {str(l["name"], "Store")}
                  {l["code"] ? ` · ${str(l["code"])}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search this store by item name or code"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search items in this store"
            />
          </div>
        </div>
      </SectionCard>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Items held here" value={String(lines.length)} icon={Boxes} lead />
        <StatCard label="Bottles open" value={String(pourable.length)} icon={Wine} />
        <StatCard label="Open volume" value={formatMl(totalOpenMl)} hint="Across every open container in this store" />
      </div>

      <SectionCard
        title={`${str(storeName, "Store")} — sealed and open`}
        description="Sealed is what is unopened on the shelf. Open is what remains in containers already broached."
      >
        <QueryState
          isLoading={loading}
          error={error}
          isEmpty={visible.length === 0}
          empty={
            activeLocation
              ? "Nothing is recorded against this store yet."
              : "Select a store to see its balances."
          }
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Container</TableHead>
                  <TableHead className="text-right">Sealed</TableHead>
                  <TableHead className="text-right">Open volume</TableHead>
                  <TableHead>Tracking</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((line) => (
                  <TableRow key={line.itemId}>
                    <TableCell>
                      <div className="font-medium">{line.name}</div>
                      {line.sku ? (
                        <div className="text-xs text-muted-foreground">{line.sku}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {line.containerType ? line.containerType : "—"}
                      {line.containerVolumeMl ? ` · ${formatMl(line.containerVolumeMl)}` : ""}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatQuantity(line.sealed)} {line.unit}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {line.containersOpen > 0 || line.openMl > 0 ? (
                        <span>
                          {formatMl(line.openMl)}
                          {line.containersOpen > 1 ? ` · ${line.containersOpen} open` : ""}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={line.tracking === "both" ? "info" : "default"}>
                        {line.tracking === "both"
                          ? "Sealed + open"
                          : line.tracking === "volume"
                            ? "Volume"
                            : "Whole units"}
                      </StatusPill>
                    </TableCell>
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
