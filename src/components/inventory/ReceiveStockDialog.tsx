import { useMemo, useState } from "react";
import { FormDialog } from "@/components/common/FormDialog";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useApplyMovement, useStockItems, useStockLocations } from "@/lib/inventory-data";

type Row = Record<string, unknown>;

/**
 * Direct / opening stock intake.
 *
 * "I bought 10 kg of rice — where do I record it?" lands here. It posts through
 * the same canonical `inventory_apply_movement` ledger routine that purchase-
 * order receiving uses, so on-hand quantity, weighted average cost, batches and
 * the movement audit trail all stay in one place. This is not a second ledger
 * and it never performs a UI-only adjustment.
 */
export function ReceiveStockDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const items = useStockItems();
  const locations = useStockLocations();
  const apply = useApplyMovement();

  const [item, setItem] = useState("");
  const [itemSearch, setItemSearch] = useState("");
  const [location, setLocation] = useState("");
  const [mode, setMode] = useState<"receipt" | "opening">("receipt");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [reference, setReference] = useState("");
  const [batchNumber, setBatchNumber] = useState("");
  const [expiry, setExpiry] = useState("");

  const itemRows = (items.data ?? []) as Row[];
  const visibleItems = itemRows.filter((r) =>
    `${String(r["name"] ?? "")} ${String(r["sku"] ?? "")}`
      .toLowerCase()
      .includes(itemSearch.trim().toLowerCase()),
  );
  const locationRows = (locations.data ?? []) as Row[];

  const selected = useMemo(
    () => itemRows.find((r) => String(r["id"]) === item),
    [itemRows, item],
  );

  const unitOptions = useMemo(() => {
    const base = selected ? String(selected["base_unit"] ?? "") : "";
    const purchase = selected ? String(selected["purchase_unit"] ?? "") : "";
    return [...new Set([base, purchase].filter(Boolean))];
  }, [selected]);

  const effectiveUnit = unit || unitOptions[0] || "";
  const qty = Number(quantity);
  const canSubmit =
    Boolean(item) && Boolean(location) && Boolean(effectiveUnit) && Number.isFinite(qty) && qty > 0;

  const reset = () => {
    setItem("");
    setItemSearch("");
    setLocation("");
    setMode("receipt");
    setQuantity("");
    setUnit("");
    setUnitCost("");
    setReference("");
    setBatchNumber("");
    setExpiry("");
  };

  const submit = () => {
    apply.mutate(
      {
        item,
        location,
        quantity: qty,
        unit: effectiveUnit,
        movementType: mode === "opening" ? "opening" : "receipt",
        unitCost: unitCost.trim() === "" ? null : Number(unitCost),
        reason: reference.trim() === "" ? null : reference.trim(),
        referenceType: mode === "opening" ? "opening-balance" : "direct-receipt",
        batchNumber: batchNumber.trim() === "" ? null : batchNumber.trim(),
        expiry: expiry === "" ? null : expiry,
      },
      {
        onSuccess: () => {
          reset();
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
      title="Receive stock"
      description="Record purchased stock or an opening balance directly into a store. Use Goods Receiving instead when the delivery is against a purchase order."
      submitLabel="Post to stock ledger"
      busyLabel="Posting…"
      canSubmit={canSubmit}
      busy={apply.isPending}
      onSubmit={submit}
      size="md"
      footerNote="Posts a movement against the store's on-hand balance and weighted average cost."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="receive-item">Stock item</Label>
          <Input
            aria-label="Search stock items"
            value={itemSearch}
            onChange={(e) => setItemSearch(e.target.value)}
            placeholder="Search by item name or SKU"
          />
          <select
            id="receive-item"
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={item}
            onChange={(e) => {
              setItem(e.target.value);
              setUnit("");
            }}
            disabled={items.isLoading || Boolean(items.error)}
          >
            <option value="">{items.isLoading ? "Loading items…" : "Select an item"}</option>
            {item && !visibleItems.some((r) => String(r["id"]) === item) && selected ? (
              <option value={item}>
                {String(selected["name"])}{selected["sku"] ? ` · ${String(selected["sku"])}` : ""}
              </option>
            ) : null}
            {visibleItems.map((r) => (
              <option key={String(r["id"])} value={String(r["id"])}>
                {String(r["name"])}{r["sku"] ? ` · ${String(r["sku"])}` : ""}
              </option>
            ))}
          </select>
          {items.error ? <p className="text-xs text-destructive">Could not load stock items.</p> : null}
          <p className="text-xs text-muted-foreground">
            Item not listed? Create it first under Inventory → Items.
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="receive-store">Store</Label>
          <Select value={location} onValueChange={setLocation}>
            <SelectTrigger id="receive-store">
              <SelectValue placeholder="Select a store" />
            </SelectTrigger>
            <SelectContent>
              {locationRows.map((r) => (
                <SelectItem key={String(r["id"])} value={String(r["id"])}>
                  {String(r["name"])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="receive-mode">Intake type</Label>
          <Select value={mode} onValueChange={(v) => setMode(v as "receipt" | "opening")}>
            <SelectTrigger id="receive-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="receipt">Direct purchase receipt</SelectItem>
              <SelectItem value="opening">Opening balance</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="receive-qty">Quantity</Label>
          <Input
            id="receive-qty"
            inputMode="decimal"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="10"
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="receive-unit">Unit</Label>
          {unitOptions.length > 1 ? (
            <Select value={effectiveUnit} onValueChange={setUnit}>
              <SelectTrigger id="receive-unit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {unitOptions.map((u) => (
                  <SelectItem key={u} value={u}>
                    {u}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              id="receive-unit"
              value={effectiveUnit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="kg"
            />
          )}
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="receive-cost">Unit cost</Label>
          <Input
            id="receive-cost"
            inputMode="decimal"
            value={unitCost}
            onChange={(e) => setUnitCost(e.target.value)}
            placeholder="Leave blank to keep the current average cost"
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="receive-batch">Batch number</Label>
          <Input
            id="receive-batch"
            value={batchNumber}
            onChange={(e) => setBatchNumber(e.target.value)}
            placeholder="Optional"
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="receive-expiry">Expiry date</Label>
          <NeoDatePicker id="receive-expiry" value={expiry} onChange={setExpiry} />
        </div>

        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="receive-ref">Supplier / reference</Label>
          <Textarea
            id="receive-ref"
            rows={2}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="Supplier name, invoice or delivery note reference"
          />
        </div>
      </div>
    </FormDialog>
  );
}
