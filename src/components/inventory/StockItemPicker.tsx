import { useState } from "react";
import { Input } from "@/components/ui/input";

type StockItem = Record<string, unknown>;

export function StockItemPicker({
  id,
  items,
  value,
  onChange,
}: {
  id: string;
  items: StockItem[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();

  const visibleItems = items.filter((item) =>
    `${String(item["name"] ?? "")} ${String(item["sku"] ?? "")}`
      .toLowerCase()
      .includes(query),
  );

  const selectedItem = items.find(
    (item) => String(item["id"]) === value,
  );

  const label = (item: StockItem) =>
    `${String(item["name"] ?? "")}${
      item["sku"] ? ` · ${String(item["sku"])}` : ""
    }`;

  return (
    <div className="space-y-2">
      <Input
        aria-label="Search stock items"
        placeholder="Search by name or SKU"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <select
        id={id}
        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Select a stock item</option>
        {selectedItem &&
        !visibleItems.some((item) => String(item["id"]) === value) ? (
          <option value={value}>{label(selectedItem)}</option>
        ) : null}
        {visibleItems.map((item) => (
          <option key={String(item["id"])} value={String(item["id"])}>
            {label(item)}
          </option>
        ))}
      </select>
    </div>
  );
}