/**
 * Staff-assisted (phone) delivery order.
 * The order is created through `neo_delivery_staff_place_order`, so it joins
 * exactly the same conveyor as a guest order: the served zone decides the fee
 * and ETA, the kitchen receives the tickets, and dispatch assigns a rider.
 * Prices, fees and totals are decided by the database, never by this screen.
 */
import { useEffect, useMemo, useState } from "react";
import { PhoneCall, Plus, Trash2 } from "lucide-react";
import { SectionCard } from "@/components/common/DataDisplay";
import { EmptyState } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import { money } from "@/lib/delivery";
import {
  useDeliverySettings,
  useDeliveryZones,
  useOnlineMenu,
  useStaffPlaceDeliveryOrder,
} from "@/lib/delivery-data";

type Row = Record<string, unknown>;
type Line = { menuItemId: string; quantity: string; note: string };

const emptyLine: Line = { menuItemId: "", quantity: "1", note: "" };

export function PhoneOrderCard({ branchId }: { branchId?: string | null }) {
  const { can } = useAuth();
  const mayCreate = can("delivery", "orders.create-assisted");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [fulfilment, setFulfilment] = useState<"delivery" | "pickup">("delivery");
  const [zoneId, setZoneId] = useState("");
  const [addressLine, setAddressLine] = useState("");
  const [city, setCity] = useState("");
  const [county, setCounty] = useState("");
  const [building, setBuilding] = useState("");
  const [landmark, setLandmark] = useState("");
  const [instructions, setInstructions] = useState("");
  const [payment, setPayment] = useState("cash");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([{ ...emptyLine }]);

  const zones = useDeliveryZones(branchId);
  const settings = useDeliverySettings(branchId);
  const menu = useOnlineMenu(branchId);
  const place = useStaffPlaceDeliveryOrder();

  const menuItems = (menu.data ?? []) as Row[];
  const zoneRows = ((zones.data ?? []) as Row[]).filter((z) => z["active"] !== false);
  const methods = ((settings.data?.["allowed_payment_methods"] as string[] | undefined) ?? ["cash"]).filter(
    Boolean,
  );

  const zone = zoneRows.find((z) => z["id"] === zoneId) ?? null;

  const itemsTotal = useMemo(
    () =>
      lines.reduce((sum, line) => {
        const item = menuItems.find((m) => m["id"] === line.menuItemId);
        const price = Number(item?.["base_price"] ?? 0);
        const qty = Number(line.quantity || 0);
        return sum + (Number.isFinite(price * qty) ? price * qty : 0);
      }, 0),
    [lines, menuItems],
  );

  const indicativeFee = fulfilment === "delivery" ? Number(zone?.["base_fee"] ?? 0) : 0;

  /**
   * The menu list is reloaded whenever the selected property resolves or
   * changes. An item chosen from the previous list can disappear, which made
   * the chosen dish silently fall back to the placeholder. Clear those lines
   * explicitly so the taker can see what happened instead of guessing.
   */
  const menuReady = Boolean(branchId) && !menu.isLoading && menuItems.length > 0;
  // Remember what was picked so the trigger keeps showing the item's name even
  // while the menu list is being refreshed behind the dialog, and so a chosen
  // item never falls back to the placeholder.
  const [picked, setPicked] = useState<Record<string, string>>({});
  useEffect(() => {
    if (menuItems.length === 0) return;
    setPicked((prev) => {
      const next = { ...prev };
      for (const m of menuItems) next[String(m["id"])] = String(m["name"] ?? "Menu item");
      return next;
    });
  }, [menuItems]);

  /**
   * A chosen line is NEVER cleared automatically. The menu list is reloaded
   * whenever the property resolves, the window regains focus or the cache is
   * invalidated, and any momentary gap in that list used to wipe the taker's
   * choice straight back to the placeholder — which is exactly what happened
   * to drinks that consume stock directly, such as House Soda. How an item
   * consumes stock has no bearing here: the line only ever stores the menu
   * item id. If an item really has left the menu we say so and block sending,
   * rather than silently erasing what the taker chose.
   */
  const menuSettled = Boolean(branchId) && menu.isSuccess && !menu.isFetching;
  const unavailableLines =
    menuSettled && menuItems.length > 0
      ? lines.some((l) => l.menuItemId && !menuItems.some((m) => String(m["id"]) === l.menuItemId))
      : false;

  function reset() {
    setName("");
    setPhone("");
    setFulfilment("delivery");
    setZoneId("");
    setAddressLine("");
    setCity("");
    setCounty("");
    setBuilding("");
    setLandmark("");
    setInstructions("");
    setPayment(methods[0] ?? "cash");
    setNotes("");
    setLines([{ ...emptyLine }]);
  }

  async function submit() {
    if (!branchId) return;
    const items = lines
      .filter((l) => l.menuItemId && Number(l.quantity) > 0)
      .map((l) => ({
        menu_item_id: l.menuItemId,
        quantity: Number(l.quantity),
        special_instructions: l.note.trim() || undefined,
      }));
    await place.mutateAsync({
      branchId,
      contactName: name.trim(),
      contactPhone: phone.trim(),
      fulfilment,
      zoneId: fulfilment === "delivery" ? zoneId || null : null,
      address:
        fulfilment === "delivery"
          ? {
              address_line: addressLine.trim(),
              city: city.trim(),
              county: county.trim(),
              building: building.trim(),
              landmark: landmark.trim(),
              delivery_instructions: instructions.trim(),
              label: "Phone order",
            }
          : {},
      items,
      paymentMethod: payment,
      notes: notes.trim() || null,
    });
    setOpen(false);
    reset();
  }

  const canSubmit =
    Boolean(branchId) &&
    name.trim().length > 1 &&
    phone.trim().length > 5 &&
    lines.some((l) => l.menuItemId && Number(l.quantity) > 0) &&
    !unavailableLines &&
    (fulfilment === "pickup" || (zoneId && addressLine.trim().length > 3 && city.trim().length > 1)) &&
    !place.isPending;

  if (!mayCreate) return null;

  return (
    <SectionCard
      icon={PhoneCall}
      title="Phone order"
      description="Take a delivery or pickup order over the phone. It uses the same zones, fees, ETA, kitchen routing and rider dispatch as an order placed by the customer."
      actions={
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" disabled={!branchId}>
              New phone order
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Phone order</DialogTitle>
            </DialogHeader>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Customer name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Caller's name" />
              </div>
              <div className="space-y-1.5">
                <Label>Phone number</Label>
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07…" />
              </div>
              <div className="space-y-1.5">
                <Label>Fulfilment</Label>
                <Select value={fulfilment} onValueChange={(v) => setFulfilment(v as "delivery" | "pickup")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="delivery">Delivery</SelectItem>
                    <SelectItem value="pickup">Pickup</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Payment</Label>
                <Select value={payment} onValueChange={setPayment}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose tender" />
                  </SelectTrigger>
                  <SelectContent>
                    {methods.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m === "cash" ? "Cash on delivery" : m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {fulfilment === "delivery" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Delivery zone</Label>
                  <Select value={zoneId} onValueChange={setZoneId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a served zone" />
                    </SelectTrigger>
                    <SelectContent>
                      {zoneRows.map((z) => (
                        <SelectItem key={String(z["id"])} value={String(z["id"])}>
                          {String(z["name"])} — {money(Number(z["base_fee"] ?? 0))}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Address</Label>
                  <Input
                    value={addressLine}
                    onChange={(e) => setAddressLine(e.target.value)}
                    placeholder="Street / estate"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Town or city</Label>
                  <Input
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    placeholder="Town or city"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>County (optional)</Label>
                  <Input
                    value={county}
                    onChange={(e) => setCounty(e.target.value)}
                    placeholder="County"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Building / house</Label>
                  <Input value={building} onChange={(e) => setBuilding(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Landmark</Label>
                  <Input value={landmark} onChange={(e) => setLandmark(e.target.value)} />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>Directions for the rider</Label>
                  <Input value={instructions} onChange={(e) => setInstructions(e.target.value)} />
                </div>
              </div>
            ) : null}

            <div className="space-y-3">
              <Label>Items</Label>
              {!branchId ? (
                <p className="text-sm text-muted-foreground">Select a property to load its delivery menu.</p>
              ) : menu.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading the delivery menu…</p>
              ) : menuItems.length === 0 ? (
                <EmptyState
                  title="No delivery menu published"
                  description="Publish menu items for delivery at this property before taking phone orders."
                />
              ) : null}
              {unavailableLines ? (
                <p className="text-sm text-amber-600">
                  One of the chosen items is no longer on this property's delivery menu. Your choice has been
                  kept so you can see it — swap it for an item on the current list before sending the order.
                </p>
              ) : null}
              {lines.map((line, index) => (
                <div key={index} className="grid gap-2 sm:grid-cols-[1fr_5rem_1fr_auto]">
                  <Select
                    value={line.menuItemId}
                    onValueChange={(v) =>
                      setLines((prev) => prev.map((l, i) => (i === index ? { ...l, menuItemId: v } : l)))
                    }
                    disabled={!menuReady}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={menuReady ? "Menu item" : "Loading menu…"}>
                        {line.menuItemId ? (picked[line.menuItemId] ?? "Menu item") : undefined}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {menuItems.map((m) => (
                        <SelectItem key={String(m["id"])} value={String(m["id"])}>
                          {String(m["name"])} — {money(Number(m["base_price"] ?? 0))}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    inputMode="decimal"
                    value={line.quantity}
                    onChange={(e) =>
                      setLines((prev) =>
                        prev.map((l, i) => (i === index ? { ...l, quantity: e.target.value } : l)),
                      )
                    }
                  />
                  <Input
                    value={line.note}
                    placeholder="Note (optional)"
                    onChange={(e) =>
                      setLines((prev) => prev.map((l, i) => (i === index ? { ...l, note: e.target.value } : l)))
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove item"
                    onClick={() => setLines((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={() => setLines((prev) => [...prev, { ...emptyLine }])}>
                <Plus className="mr-1 h-4 w-4" /> Add item
              </Button>
            </div>

            <div className="space-y-1.5">
              <Label>Order notes</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            </div>

            <p className="text-sm text-muted-foreground">
              Items {money(itemsTotal)}
              {fulfilment === "delivery" ? ` · zone fee ${money(indicativeFee)}` : ""} · the final total, tax and
              ETA are confirmed by the system when the order is created.
            </p>

            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button disabled={!canSubmit} onClick={() => void submit()}>
                {place.isPending ? "Creating…" : "Create order"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      }
    >
      <p className="text-sm text-muted-foreground">
        {branchId
          ? "Cash orders are confirmed and sent to the kitchen straight away. Other tenders stay awaiting payment until the payment is confirmed."
          : "Select a property to take a phone order."}
      </p>
    </SectionCard>
  );
}
