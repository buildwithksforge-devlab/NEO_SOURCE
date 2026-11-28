/**
 * How one menu item consumes stock.
 *
 * The mode lives on the menu item itself, so every channel â€” restaurant,
 * delivery, pickup, room service, minibar, events, complimentary â€” sells by
 * menu item and the fulfilment engine decides what to deduct. A recipe is
 * never required merely to sell something.
 */
import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { useStockItems } from "@/lib/inventory-data";
import { useStationStores } from "@/lib/station-stock";
import { usePagePermitted } from "@/components/common/PermittedLink";
import {
  CONSUMPTION_MODES,
  consumptionModeLabel,
  useSaveRecord,
  type ConsumptionMode,
  type MenuCatalogueRow,
} from "@/lib/pos-data";

/** Order channels, matching the order types the engine sees. */
export const SALES_CHANNELS = [
  { value: "dine-in", label: "Restaurant POS" },
  { value: "bar", label: "Bar" },
  { value: "takeaway", label: "Pickup / takeaway" },
  { value: "delivery", label: "Delivery" },
  { value: "room-service", label: "Room service" },
  { value: "minibar", label: "Minibar" },
  { value: "events", label: "Events" },
  { value: "complimentary", label: "Complimentary" },
  { value: "coffee-station", label: "Coffee station" },
] as const;

type Row = Record<string, unknown>;

export function MenuConsumptionCard({
  item,
  manage,
}: {
  item: MenuCatalogueRow;
  manage: boolean;
}) {
  const save = useSaveRecord("menu_items");
  const items = useStockItems();
  const [search, setSearch] = useState("");
  const savedMode = (item.consumption_mode as ConsumptionMode) ?? "none";
  const [draft, setDraft] = useState<{
    mode: ConsumptionMode;
    stockId: string;
    quantity: string;
    unit: string;
  } | null>(null);
  const mode = draft?.mode ?? savedMode;
  const needsStock = mode === "direct_stock" || mode === "batch";
  const channels = item.consumption_channels ?? [];
  const { data: stores, isError: storesFailed, isLoading: storesLoading } = useStationStores(item.station_id);
  const permitted = usePagePermitted();

  const stockRows = (items.data ?? []) as Row[];

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const rows = stockRows.filter((r) => r["active"] !== false);
    if (!term) return rows.slice(0, 60);
    return rows
      .filter(
        (r) =>
          String(r["name"] ?? "").toLowerCase().includes(term) ||
          String(r["sku"] ?? "").toLowerCase().includes(term),
      )
      .slice(0, 60);
  }, [stockRows, search]);

  const savedMapping = {
    mode: savedMode,
    stockId: item.direct_stock_item_id ?? "",
    quantity: String(item.direct_stock_quantity ?? 1),
    unit: item.direct_stock_unit ?? "",
  };
  const mapping = draft ?? savedMapping;
  const selected = stockRows.find((r) => String(r["id"]) === mapping.stockId);
  const choices = selected && !filtered.some((row) => row["id"] === selected["id"]) ? [selected, ...filtered] : filtered;
  const quantity = Number(mapping.quantity);
  const valid = !needsStock || (selected !== undefined && selected["active"] !== false
    && Number.isFinite(quantity) && quantity > 0 && Boolean(mapping.unit.trim()));
  const write = (values: Record<string, unknown>) => save.mutate({ id: item.id, values });

  if (!manage) {
    return (
      <div className="space-y-1 text-sm">
        <p className="font-medium">{consumptionModeLabel(mode)}</p>
        {needsStock ? (
          <p className="text-muted-foreground">
            {item.direct_stock_item_name ?? "No stock item chosen"} Â· 1 sale ={" "}
            {Number(item.direct_stock_quantity ?? 1)} {item.direct_stock_unit ?? "unit"}
          </p>
        ) : null}
        <p className="text-muted-foreground">
          {channels.length ? `Deducts on: ${channels.join(", ")}` : "Deducts on every channel"}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>Inventory method</Label>
        <Select
          value={mode}
          onValueChange={(value) => setDraft({ ...mapping, mode: value as ConsumptionMode })}
        >
          <SelectTrigger aria-label={`Consumption mode for ${item.name}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONSUMPTION_MODES.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {CONSUMPTION_MODES.find((m) => m.value === mode)?.hint}
        </p>
      </div>

      {needsStock ? (
        <div className="space-y-3 rounded-lg border border-border/60 p-3">
          <div className="space-y-1.5">
            <Label>{mode === "batch" ? "Prepared batch stock item" : "Purchased stock item"}</Label>
            <Input
              value={search}
              placeholder="Search stock by name or code"
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search stock items"
            />
            <Select
              value={mapping.stockId}
              onValueChange={(stockId) => {
                const stock = stockRows.find((row) => String(row["id"]) === stockId);
                setDraft({ ...mapping, stockId, quantity: "1", unit: String(stock?.["base_unit"] ?? "unit") });
              }}
            >
              <SelectTrigger aria-label={`Stock item for ${item.name}`}>
                <SelectValue placeholder={mode === "batch" ? "Choose the prepared batch this sale uses" : "Choose the purchased stock this sale uses"} />
              </SelectTrigger>
              <SelectContent>
                {choices.map((r) => (
                  <SelectItem key={String(r["id"])} value={String(r["id"])}>
                    {String(r["name"])}
                    {r["sku"] ? ` Â· ${String(r["sku"])}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected ? (
              <p className="text-xs text-muted-foreground">
                Base unit {String(selected["base_unit"] ?? "unit")}
                {selected["container_volume_ml"]
                  ? ` Â· container ${Number(selected["container_volume_ml"])} ml`
                  : ""}
              </p>
            ) : (
              <p className="text-xs text-warning">
                Choose the stock item before saving this method.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Quantity per sale</Label>
              <Input
                type="number"
                min={0}
                step="0.001"
                value={mapping.quantity}
                onChange={(e) => setDraft({ ...mapping, quantity: e.target.value })}
                aria-label={`Quantity per sale for ${item.name}`}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Unit</Label>
              <Input
                value={mapping.unit}
                placeholder={String(selected?.["base_unit"] ?? "unit")}
                onChange={(e) => setDraft({ ...mapping, unit: e.target.value })}
                aria-label={`Unit for ${item.name}`}
              />
            </div>
          </div>

          {mode === "direct_stock" && selected?.["container_volume_ml"] ? (
            <p className="text-xs text-muted-foreground">For a sealed bottle or can, use one {String(selected["base_unit"] ?? "unit")} per sale. Use a volume unit only for a measured pour.</p>
          ) : null}
        </div>
      ) : null}

      {mode !== "none" ? (
        <div className="space-y-1 rounded-lg border border-border/60 p-3 text-sm">
          <p className="font-medium">Departmental stock</p>
          <p className="text-xs text-muted-foreground">Each sale uses the departmental store mapped to this item's station. Menu items cannot override that store.</p>
          {storesLoading ? <p>Checking the station’s store…</p> : storesFailed ? <p>Store mapping could not be loaded.</p>
            : stores?.length ? <p>{stores.map((store) => store.locationName).join(", ")}</p>
            : <p className="text-warning">Assign this item to a station with a departmental store before selling it.</p>}
          {permitted("/inventory/requisitions") ? <Link to="/inventory/requisitions" className="inline-flex min-h-11 items-center font-medium text-primary">Department requisitions</Link> : null}
        </div>
      ) : null}

      {draft ? <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!valid || save.isPending} onClick={() => save.mutate({
          id: item.id,
          values: {
            consumption_mode: mode,
            stock_item_id: needsStock ? mapping.stockId : null,
            stock_quantity_per_sale: needsStock ? quantity : 1,
            stock_unit: needsStock ? mapping.unit.trim() : null,
          },
        }, { onSuccess: () => setDraft(null) })}>Save stock mapping</Button>
        <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => setDraft(null)}>Cancel</Button>
      </div> : null}

      {savedMode !== "none" ? (
        <div className="space-y-2">
          <Label>Channels that deduct stock</Label>
          <p className="text-xs text-muted-foreground">
            Leave all unticked to deduct on every channel.
          </p>
          <div className="grid grid-cols-2 gap-2">
            {SALES_CHANNELS.map((c) => {
              const on = channels.includes(c.value);
              return (
                <label key={c.value} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={on}
                    aria-label={c.label}
                    onCheckedChange={(v) => {
                      const next = v
                        ? [...channels, c.value]
                        : channels.filter((x) => x !== c.value);
                      write({ consumption_channels: next.length ? next : null });
                    }}
                  />
                  {c.label}
                </label>
              );
            })}
          </div>
          {channels.length ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => write({ consumption_channels: null })}
            >
              Deduct on every channel
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
