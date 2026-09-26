/**
 * How one menu item consumes stock.
 *
 * The mode lives on the menu item itself, so every channel — restaurant,
 * delivery, pickup, room service, minibar, events, complimentary — sells by
 * menu item and the fulfilment engine decides what to deduct. A recipe is
 * never required merely to sell something.
 */
import { useMemo, useState } from "react";
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
import { useStockItems, useStockLocations } from "@/lib/inventory-data";
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
  const locations = useStockLocations();
  const [search, setSearch] = useState("");

  const mode: ConsumptionMode = (item.consumption_mode as ConsumptionMode) ?? "none";
  const needsStock = mode === "direct_stock" || mode === "batch";
  const channels = item.consumption_channels ?? [];

  const stockRows = (items.data ?? []) as Row[];
  const locationRows = (locations.data ?? []) as Row[];

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

  const selected = stockRows.find((r) => String(r["id"]) === String(item.direct_stock_item_id));
  const write = (values: Record<string, unknown>) => save.mutate({ id: item.id, values });

  if (!manage) {
    return (
      <div className="space-y-1 text-sm">
        <p className="font-medium">{consumptionModeLabel(mode)}</p>
        {needsStock ? (
          <p className="text-muted-foreground">
            {item.direct_stock_item_name ?? "No stock item chosen"} · 1 sale ={" "}
            {Number(item.direct_stock_quantity ?? 1)} {item.direct_stock_unit ?? "unit"}
            {item.issuing_location_name ? ` · from ${item.issuing_location_name}` : ""}
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
        <Label>How a sale consumes stock</Label>
        <Select
          value={mode}
          onValueChange={(v) => {
            const next: Record<string, unknown> = { consumption_mode: v };
            if (v !== "direct_stock" && v !== "batch") {
              next["stock_item_id"] = null;
              next["issuing_location_id"] = null;
            }
            write(next);
          }}
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
            <Label>Stock item</Label>
            <Input
              value={search}
              placeholder="Search stock by name or code"
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search stock items"
            />
            <Select
              value={item.direct_stock_item_id ?? ""}
              onValueChange={(v) =>
                write({
                  stock_item_id: v,
                  stock_unit:
                    item.direct_stock_unit ??
                    String(stockRows.find((r) => String(r["id"]) === v)?.["base_unit"] ?? "unit"),
                })
              }
            >
              <SelectTrigger aria-label={`Stock item for ${item.name}`}>
                <SelectValue placeholder="Choose the stock item this sale deducts" />
              </SelectTrigger>
              <SelectContent>
                {filtered.map((r) => (
                  <SelectItem key={String(r["id"])} value={String(r["id"])}>
                    {String(r["name"])}
                    {r["sku"] ? ` · ${String(r["sku"])}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected ? (
              <p className="text-xs text-muted-foreground">
                Base unit {String(selected["base_unit"] ?? "unit")}
                {selected["container_volume_ml"]
                  ? ` · container ${Number(selected["container_volume_ml"])} ml`
                  : ""}
              </p>
            ) : (
              <p className="text-xs text-warning">
                Choose a stock item, or sales of this item will deduct nothing.
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
                defaultValue={Number(item.direct_stock_quantity ?? 1)}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (n > 0 && n !== Number(item.direct_stock_quantity ?? 1)) {
                    write({ stock_quantity_per_sale: n });
                  }
                }}
                aria-label={`Quantity per sale for ${item.name}`}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Unit</Label>
              <Input
                defaultValue={item.direct_stock_unit ?? ""}
                placeholder={String(selected?.["base_unit"] ?? "unit")}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (item.direct_stock_unit ?? "")) write({ stock_unit: v || null });
                }}
                aria-label={`Unit for ${item.name}`}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Issuing store</Label>
            <Select
              value={item.issuing_location_id ?? "auto"}
              onValueChange={(v) => write({ issuing_location_id: v === "auto" ? null : v })}
            >
              <SelectTrigger aria-label={`Issuing store for ${item.name}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Use the station&apos;s store</SelectItem>
                {locationRows.map((l) => (
                  <SelectItem key={String(l["id"])} value={String(l["id"])}>
                    {String(l["name"])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : null}

      {mode !== "none" ? (
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
