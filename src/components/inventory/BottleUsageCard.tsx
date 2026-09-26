/**
 * Bottles and controlled usage.
 *
 * Two things staff need that a menu sale cannot cover: opening a bottle so it
 * can be poured, and recording drink that left the store without being sold
 * (breakage, spillage, comps, staff, expiry, events, transfers, manual issues,
 * count variances). Both call database functions — no balance is computed here.
 */

import { useMemo, useState } from "react";
import { SectionCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useStockItems, useStockLocations } from "@/lib/inventory-data";
import type { Row } from "@/lib/inventory";
import {
  USAGE_REASONS,
  formatMl,
  useContainerEvents,
  useOpenBottle,
  useOpenContainers,
  useRecordUsage,
} from "@/lib/bottle-stock";

const str = (v: unknown, fallback = "") => (v == null ? fallback : String(v));

export function BottleUsageCard() {
  const locations = useStockLocations();
  const items = useStockItems();
  const openContainers = useOpenContainers();
  const events = useContainerEvents(25);
  const openBottle = useOpenBottle();
  const recordUsage = useRecordUsage();

  const [locationId, setLocationId] = useState("");
  const [openItemId, setOpenItemId] = useState("");
  const [usageItemId, setUsageItemId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [reasonCode, setReasonCode] = useState("breakage");
  const [reason, setReason] = useState("");

  const locationRows = (locations.data ?? []) as Row[];
  const itemRows = (items.data ?? []) as Row[];

  const pourableItems = useMemo(
    () => itemRows.filter((i) => Boolean(i["may_open_for_pours"])),
    [itemRows],
  );

  const selectedUsageItem = itemRows.find((i) => String(i["id"]) === usageItemId);
  const usageReady =
    locationId !== "" && usageItemId !== "" && Number(quantity) > 0 && unit.trim() !== "" && reason.trim() !== "";

  const submitOpen = () => {
    if (!locationId || !openItemId) return;
    openBottle.mutate(
      { stockItemId: openItemId, locationId, reason: "Opened at the bar for pouring" },
      { onSuccess: () => setOpenItemId("") },
    );
  };

  const submitUsage = () => {
    if (!usageReady) return;
    recordUsage.mutate(
      {
        stockItemId: usageItemId,
        locationId,
        quantity: Number(quantity),
        unit: unit.trim(),
        reasonCode,
        reason: reason.trim(),
      },
      {
        onSuccess: () => {
          setQuantity("");
          setReason("");
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      <SectionCard
        title="Bottles and controlled usage"
        description="Open a bottle for pouring, or record drink that left the store without a sale. Every entry keeps its reason, the person, the store and the amount."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <Label>Store</Label>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a store" />
              </SelectTrigger>
              <SelectContent>
                {locationRows.map((l) => (
                  <SelectItem key={str(l["id"])} value={str(l["id"])}>
                    {str(l["name"])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <div className="space-y-4 rounded-lg border p-4">
            <div>
              <p className="font-medium">Open a bottle</p>
              <p className="text-sm text-muted-foreground">
                One sealed container moves into open millilitres so tots and cocktails can be poured from it.
              </p>
            </div>
            <div>
              <Label>Item</Label>
              <Select value={openItemId} onValueChange={setOpenItemId}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      pourableItems.length === 0 ? "No item is set to be opened for pours" : "Choose an item"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {pourableItems.map((i) => (
                    <SelectItem key={str(i["id"])} value={str(i["id"])}>
                      {str(i["name"])}
                      {i["container_volume_ml"] ? ` · ${formatMl(Number(i["container_volume_ml"]))}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {pourableItems.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  Turn on "May be opened for pours" and set a container size on the stock item first.
                </p>
              ) : null}
            </div>
            <Button
              onClick={submitOpen}
              disabled={!locationId || !openItemId || openBottle.isPending}
            >
              {openBottle.isPending ? "Opening…" : "Open bottle"}
            </Button>
          </div>

          <div className="space-y-4 rounded-lg border p-4">
            <div>
              <p className="font-medium">Record usage without a sale</p>
              <p className="text-sm text-muted-foreground">
                Breakage, spillage, comps, staff drinks, expiry, event usage, transfers and manual issues.
              </p>
            </div>
            <div>
              <Label>Item</Label>
              <Select value={usageItemId} onValueChange={setUsageItemId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose an item" />
                </SelectTrigger>
                <SelectContent>
                  {itemRows.map((i) => (
                    <SelectItem key={str(i["id"])} value={str(i["id"])}>
                      {str(i["name"])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="usage-qty">Amount</Label>
                <Input
                  id="usage-qty"
                  type="number"
                  min="0"
                  step="any"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="usage-unit">Unit</Label>
                <Input
                  id="usage-unit"
                  placeholder={str(selectedUsageItem?.["base_unit"], "bottle or ml")}
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                />
              </div>
            </div>
            {selectedUsageItem && String(selectedUsageItem["tracking_method"] ?? "whole") !== "whole" ? (
              <p className="text-sm text-muted-foreground">
                Enter millilitres to take it off the open bottle, or whole containers to take a sealed one.
              </p>
            ) : null}
            <div>
              <Label>Reason</Label>
              <Select value={reasonCode} onValueChange={setReasonCode}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {USAGE_REASONS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="usage-note">Explanation</Label>
              <Textarea
                id="usage-note"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="What happened, and any document number"
              />
            </div>
            <Button onClick={submitUsage} disabled={!usageReady || recordUsage.isPending}>
              {recordUsage.isPending ? "Recording…" : "Record usage"}
            </Button>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Open bottles"
        description="What is left in bottles already opened, counted separately from sealed stock."
      >
        {(openContainers.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No bottle is currently open.</p>
        ) : (
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Store</TableHead>
                  <TableHead>Open volume</TableHead>
                  <TableHead>Bottles open</TableHead>
                  <TableHead>Last opened</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(openContainers.data ?? []).map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">{row.stock_items?.name ?? "—"}</TableCell>
                    <TableCell>{row.stock_locations?.name ?? "—"}</TableCell>
                    <TableCell>{formatMl(row.open_volume_ml)}</TableCell>
                    <TableCell>{row.containers_open}</TableCell>
                    <TableCell>{(row.last_opened_at ?? "").slice(0, 16).replace("T", " ") || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        )}
      </SectionCard>

      <SectionCard title="Bottle history" description="Openings and pours as the database recorded them.">
        {(events.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
        ) : (
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead>Store</TableHead>
                  <TableHead>What happened</TableHead>
                  <TableHead>Change</TableHead>
                  <TableHead>Left open</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(events.data ?? []).map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>{e.created_at.slice(0, 16).replace("T", " ")}</TableCell>
                    <TableCell className="font-medium">{e.stock_items?.name ?? "—"}</TableCell>
                    <TableCell>{e.stock_locations?.name ?? "—"}</TableCell>
                    <TableCell>
                      <StatusPill tone={e.event_type === "open" ? "default" : "success"}>
                        {e.event_type === "open" ? "Bottle opened" : "Poured"}
                      </StatusPill>
                      {e.reason ? <span className="ml-2 text-sm text-muted-foreground">{e.reason}</span> : null}
                    </TableCell>
                    <TableCell>
                      {e.volume_delta_ml > 0 ? "+" : ""}
                      {formatMl(Math.abs(e.volume_delta_ml))}
                      {e.volume_delta_ml < 0 ? " used" : ""}
                    </TableCell>
                    <TableCell>{formatMl(e.open_volume_after_ml)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        )}
      </SectionCard>
    </div>
  );
}
