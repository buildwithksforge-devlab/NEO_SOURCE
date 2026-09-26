/**
 * Staff board.
 *
 * One read-only surface for the three things finance and operations chase
 * daily: what each store is holding, what each banquet still owes, and which
 * deliveries have nobody carrying them. Every figure is read from the same
 * ledgers the working screens use — nothing here is estimated, and nothing
 * here changes a record.
 */
import { useMemo } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Bike, Boxes, Scale, Trash2, Wallet, Wine } from "lucide-react";
import {
  PageHeader,
  SectionCard,
  StatCard,
  StatusPill,
  TableScroll,
} from "@/components/common/DataDisplay";
import { QueryState } from "@/components/common/StateSystem";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useDataScope } from "@/lib/data-scope";
import { useTenant } from "@/lib/tenant";
import { formatMoney } from "@/lib/events";
import { money, shortDateTime, titleCase } from "@/lib/delivery";
import { formatQuantity, num, type Row } from "@/lib/inventory";
import { useStockItems, useStockLocations } from "@/lib/inventory-data";
import { formatMl, useAllOpenContainers } from "@/lib/bottle-stock";
import { useEventPaymentLedger } from "@/lib/events-data";
import { useStaffDeliveryOrders } from "@/lib/delivery-data";
import { useMinibarPostings } from "@/lib/minibar";
import { useWasteRecords } from "@/lib/kitchen-data";
import { RiderBoardCard } from "@/components/delivery/RiderBoardCard";
import { StaffStatusCard } from "@/components/hr/StaffStatusCard";
import { BookingQueueCard, KitchenStatusCard } from "@/components/operations/ServiceFloorCard";

export const Route = createFileRoute("/_shell/staff-board")({
  head: () => ({
    meta: [
      { title: "Staff Board — NEØ Hospitality OS" },
      {
        name: "description",
        content:
          "Stock held per store, banquet balances still owed and deliveries waiting for a rider, on one read-only board.",
      },
      { property: "og:title", content: "Staff Board — NEØ Hospitality OS" },
      {
        property: "og:description",
        content: "Store balances, banquet money owed and pending deliveries in one place.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

const str = (v: unknown, fallback = "") => (v == null ? fallback : String(v));

/** Statuses where an order is cooked or cooking and nobody is carrying it. */
const WAITING = ["confirmed", "in-preparation", "ready-for-pickup"];

/** Delivery statuses read as an ordinary status tone on this board. */
function deliveryTone(status: string): "default" | "info" | "success" | "warning" | "destructive" {
  if (["delivered", "completed"].includes(status)) return "success";
  if (["cancelled", "returned", "failed"].includes(status)) return "destructive";
  if (["ready-for-pickup", "collected", "on-the-way"].includes(status)) return "info";
  return "warning";
}

function StaffBoardPage() {
  const { can } = useAuth();
  const { tenant } = useTenant();
  const symbol = tenant.regional.currencySymbol;
  const { branchId } = useActivePropertyFilter();
  const scope = useDataScope();

  const seesStock = can("stores", "overview.view");
  const seesBanquets = can("events", "billing.view");
  const seesDeliveries = can("delivery", "orders.view") || can("delivery", "overview.view");
  // Staff status reads attendance, roster and leave records, so it needs at
  // least attendance sight; leave figures still obey their own RLS.
  const seesStaff = can("hr-attendance", "view") || can("hr-employees", "view");
  // Kitchen status and the booking queue are read-only summaries of the same
  // tickets and reservations the working screens own.
  const seesKitchen = can("kitchen", "queue.view") || can("kitchen", "overview.view");
  const seesBookings = can("pms", "reservations.view") || can("pms", "front-office.view");

  const locations = useStockLocations();
  const items = useStockItems();
  const open = useAllOpenContainers();
  const ledger = useEventPaymentLedger();
  const orders = useStaffDeliveryOrders({ branchId });
  const minibar = useMinibarPostings();

  const seesMinibar = can("front-office", "folios.view");
  const minibarRows = (minibar.data ?? []) as Row[];
  const minibarTotal = minibarRows.reduce((t, p) => t + num(p["total_amount"]), 0);

  const seesWaste = can("kitchen", "waste.view");
  const waste = useWasteRecords();
  const wasteRows = (waste.data ?? []) as Row[];
  const wasteCost = wasteRows.reduce(
    (t, w) => t + (num(w["posted_cost"]) || num(w["estimated_cost"])),
    0,
  );
  const wastePosted = wasteRows.filter((w) => Boolean(w["posted_at"])).length;


  /* ---------------- Stock by store ---------------- */
  const stores = useMemo(() => {
    const byLocation = new Map<
      string,
      { id: string; name: string; lines: number; sealed: number; openMl: number; openBottles: number }
    >();
    for (const l of (locations.data ?? []) as Row[]) {
      byLocation.set(str(l["id"]), {
        id: str(l["id"]),
        name: str(l["name"], "Store"),
        lines: 0,
        sealed: 0,
        openMl: 0,
        openBottles: 0,
      });
    }
    for (const item of (items.data ?? []) as Row[]) {
      for (const level of (item["stock_levels"] ?? []) as Row[]) {
        const bucket = byLocation.get(str(level["location_id"]));
        if (!bucket) continue;
        const qty = num(level["quantity_on_hand"]);
        if (qty === 0) continue;
        bucket.lines += 1;
        bucket.sealed += qty;
      }
    }
    for (const row of open.data ?? []) {
      const bucket = byLocation.get(String(row.location_id));
      if (!bucket) continue;
      bucket.openMl += Number(row.open_volume_ml ?? 0);
      bucket.openBottles += Number(row.containers_open ?? 0);
    }
    return [...byLocation.values()]
      .filter((s) => s.lines > 0 || s.openMl > 0 || s.openBottles > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [locations.data, items.data, open.data]);

  const totalOpenMl = stores.reduce((t, s) => t + s.openMl, 0);

  /* ---------------- Banquet balances ---------------- */
  const banquets = useMemo(() => {
    const map = new Map<
      string,
      { id: string; reference: string; name: string; billed: number; received: number; status: string }
    >();
    for (const row of (ledger.data ?? []) as Row[]) {
      const booking = (row["event_bookings"] ?? {}) as Row;
      const id = str(row["booking_id"]);
      if (!id) continue;
      let bucket = map.get(id);
      if (!bucket) {
        bucket = {
          id,
          reference: str(booking["event_reference"], "—"),
          name: str(booking["event_name"], "—"),
          billed: num(booking["total_amount"]),
          received: 0,
          status: str(booking["payment_status"], "unpaid"),
        };
        map.set(id, bucket);
      }
      bucket.received += num(row["amount"]);
    }
    return [...map.values()].sort(
      (a, b) => b.billed - b.received - (a.billed - a.received),
    );
  }, [ledger.data]);

  const billedTotal = banquets.reduce((t, b) => t + b.billed, 0);
  const receivedTotal = banquets.reduce((t, b) => t + b.received, 0);
  const owedTotal = banquets.reduce((t, b) => t + Math.max(b.billed - b.received, 0), 0);

  /* ---------------- Pending deliveries ---------------- */
  const deliveryRows = (orders.data ?? []) as Row[];
  const waiting = useMemo(
    () => deliveryRows.filter((o) => WAITING.includes(str(o["order_status"])) && !o["rider_id"]),
    [deliveryRows],
  );
  const withRider = useMemo(
    () =>
      deliveryRows.filter(
        (o) =>
          Boolean(o["rider_id"]) &&
          !["delivered", "completed", "cancelled", "returned"].includes(str(o["order_status"])),
      ),
    [deliveryRows],
  );
  const pending = [...waiting, ...withRider];
  const pendingValue = pending.reduce((t, o) => t + num(o["total_amount"]), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Overview"
        title="Staff board"
        description={
          scope.isDepartmentScope
            ? "Your department's work only — read-only, in one place."
            : "Store balances, banquet money still owed and deliveries in flight — read-only, in one place."
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {seesBanquets ? (
        <StatCard
          label="Owed on banquets"
          value={formatMoney(symbol, owedTotal)}
          hint={`${banquets.length} events billed`}
          icon={Scale}
          tone={owedTotal > 0 ? "warning" : "default"}
          lead
        />
        ) : null}
        {seesBanquets ? (
        <StatCard
          label="Received on banquets"
          value={formatMoney(symbol, receivedTotal)}
          hint={`of ${formatMoney(symbol, billedTotal)} billed`}
          icon={Wallet}
        />
        ) : null}
        {seesDeliveries ? (
        <StatCard
          label="Deliveries in flight"
          value={String(pending.length)}
          hint={`${waiting.length} still without a rider`}
          icon={Bike}
          tone={waiting.length > 0 ? "warning" : "default"}
        />
        ) : null}
        {seesStock ? (
        <StatCard
          label="Stores holding stock"
          value={String(stores.length)}
          hint={totalOpenMl > 0 ? `${formatMl(totalOpenMl)} open across bottles` : "No open bottles"}
          icon={Boxes}
        />
        ) : null}
      </div>

      {seesStaff ? <StaffStatusCard /> : null}

      {seesKitchen ? <KitchenStatusCard /> : null}

      {seesBookings ? <BookingQueueCard /> : null}

      {seesStock ? (
      <SectionCard
        title="Stock by store"
        description="Sealed units and open millilitres are counted apart, the way a bar counts them."
        icon={Boxes}
      >
        {(
          <QueryState
            isLoading={locations.isLoading || items.isLoading || open.isLoading}
            error={locations.error ?? items.error ?? open.error}
            isEmpty={stores.length === 0}
            empty="No store is holding stock yet."
          >
            <TableScroll>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Store</TableHead>
                    <TableHead className="text-right">Items held</TableHead>
                    <TableHead className="text-right">Sealed units</TableHead>
                    <TableHead className="text-right">Open volume</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stores.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">
                        <Link to="/inventory/by-store" className="hover:underline">
                          {s.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{s.lines}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatQuantity(s.sealed)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {s.openMl > 0 || s.openBottles > 0 ? (
                          <span>
                            {formatMl(s.openMl)}
                            {s.openBottles > 0 ? ` · ${s.openBottles} open` : ""}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableScroll>
          </QueryState>
        )}
      </SectionCard>
      ) : null}

      {seesBanquets ? (
      <SectionCard
        title="Banquet balances"
        description="What each event was billed against the money recorded on it. Largest balance first."
        icon={Wine}
      >
        {(
          <QueryState
            isLoading={ledger.isLoading}
            error={ledger.error}
            isEmpty={banquets.length === 0}
            empty="No event has recorded money yet."
          >
            <TableScroll>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Event</TableHead>
                    <TableHead className="text-right">Billed</TableHead>
                    <TableHead className="text-right">Received</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {banquets.map((b) => {
                    const outstanding = b.billed - b.received;
                    return (
                      <TableRow key={b.id}>
                        <TableCell>
                          <Link
                            to="/events/bookings/$id"
                            params={{ id: b.id }}
                            className="font-medium hover:underline"
                          >
                            {b.name}
                          </Link>
                          <div className="text-xs text-muted-foreground">{b.reference}</div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMoney(symbol, b.billed)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMoney(symbol, b.received)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {outstanding > 0 ? (
                            <span className="font-medium text-warning">
                              {formatMoney(symbol, outstanding)}
                            </span>
                          ) : outstanding < 0 ? (
                            <span className="font-medium text-warning">
                              {formatMoney(symbol, Math.abs(outstanding))} over
                            </span>
                          ) : (
                            formatMoney(symbol, 0)
                          )}
                        </TableCell>
                        <TableCell>
                          <StatusPill tone={outstanding > 0 ? "warning" : "success"}>
                            {titleCase(b.status.replace(/-/g, " "))}
                          </StatusPill>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableScroll>
          </QueryState>
        )}
      </SectionCard>
      ) : null}

      {seesDeliveries ? (
      <SectionCard
        title="Pending deliveries"
        description="Orders cooked, cooking or already with a rider — everything not yet delivered."
        icon={Bike}
      >
        {(
          <QueryState
            isLoading={orders.isLoading}
            error={orders.error}
            isEmpty={pending.length === 0}
            empty="Nothing is pending delivery right now."
          >
            <>
              <p className="mb-3 text-sm text-muted-foreground">
                {waiting.length} waiting for a rider · {withRider.length} on the way ·{" "}
                {money(pendingValue)} in flight
              </p>
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Order</TableHead>
                      <TableHead>Placed</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Rider</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pending.map((o) => (
                      <TableRow key={str(o["id"])}>
                        <TableCell className="font-medium">
                          <Link to="/delivery/queue" className="hover:underline">
                            {str(o["order_number"], "Order")}
                          </Link>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                          {shortDateTime(str(o["created_at"]))}
                        </TableCell>
                        <TableCell>
                          <StatusPill tone={deliveryTone(str(o["order_status"]))}>
                            {titleCase(str(o["order_status"]).replace(/-/g, " "))}
                          </StatusPill>
                        </TableCell>
                        <TableCell className="text-sm">
                          {o["rider_id"] ? (
                            "Assigned"
                          ) : (
                            <span className="text-warning">Waiting for a rider</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(num(o["total_amount"]))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            </>
          </QueryState>
        )}
      </SectionCard>
      ) : null}

      {seesDeliveries ? <RiderBoardCard branchId={branchId} /> : null}

      {seesMinibar ? (
      <SectionCard
        title="Minibar charges"
        description="Each charge moved the same items out of the minibar store and onto a guest folio."
        icon={Wine}
      >
        {(
          <QueryState
            isLoading={minibar.isLoading}
            error={minibar.error}
            isEmpty={minibarRows.length === 0}
            empty="No minibar consumption has been posted yet."
          >
            <>
              <p className="mb-3 text-sm text-muted-foreground">
                {minibarRows.length} charge{minibarRows.length === 1 ? "" : "s"} ·{" "}
                {formatMoney(symbol, minibarTotal)} charged to folios
              </p>
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Reference</TableHead>
                      <TableHead>Posted</TableHead>
                      <TableHead>Items</TableHead>
                      <TableHead className="text-right">Charged</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {minibarRows.slice(0, 20).map((p) => {
                      const lines = (p["minibar_posting_lines"] ?? []) as Row[];
                      return (
                        <TableRow key={str(p["id"])}>
                          <TableCell className="font-medium">
                            <Link to="/pms/minibar" className="hover:underline">
                              {str(p["posting_number"], "—")}
                            </Link>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                            {shortDateTime(str(p["posted_at"]))}
                          </TableCell>
                          <TableCell className="text-sm">
                            {lines.length} line{lines.length === 1 ? "" : "s"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatMoney(symbol, num(p["total_amount"]))}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableScroll>
            </>
          </QueryState>
        )}
      </SectionCard>
      ) : null}

      {seesWaste ? (
      <SectionCard
        title="Kitchen waste"
        description="Discarded and spoiled items. Records marked as taken off stock have already reduced the store."
        icon={Trash2}
      >
        {(
          <QueryState
            isLoading={waste.isLoading}
            error={waste.error}
            isEmpty={wasteRows.length === 0}
            empty="No waste has been recorded yet."
          >
            <>
              <p className="mb-3 text-sm text-muted-foreground">
                {wasteRows.length} record{wasteRows.length === 1 ? "" : "s"} ·{" "}
                {formatMoney(symbol, wasteCost)} estimated cost ·{" "}
                {wastePosted} taken off stock
              </p>
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Record</TableHead>
                      <TableHead>Item</TableHead>
                      <TableHead>Quantity</TableHead>
                      <TableHead>Stock</TableHead>
                      <TableHead className="text-right">Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {wasteRows.slice(0, 20).map((w) => (
                      <TableRow key={str(w["id"])}>
                        <TableCell className="font-medium">
                          <Link to="/kitchen/waste" className="hover:underline">
                            {str(w["waste_number"], "—")}
                          </Link>
                        </TableCell>
                        <TableCell className="text-sm">
                          {str(w["ingredient_name"]) ||
                            str((w["menu_items"] as Row | undefined)?.["name"], "—")}
                        </TableCell>
                        <TableCell className="text-sm tabular-nums">
                          {formatQuantity(num(w["quantity"]))} {str(w["unit"])}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {w["posted_at"] ? "Reduced" : titleCase(str(w["status"], "pending"))}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatMoney(symbol, num(w["posted_cost"]) || num(w["estimated_cost"]))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            </>
          </QueryState>
        )}
      </SectionCard>
      ) : null}
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/staff-board">
      <StaffBoardPage />
    </OpsGuard>
  );
}
