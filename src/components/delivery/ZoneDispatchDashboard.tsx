/**
 * Staff delivery dashboard.
 *
 * Three questions an operator asks at a glance: what is waiting and where,
 * who can carry it, and what proof came back for the ones already handed over.
 * Every figure is read from the live order, rider and proof records — nothing
 * here is estimated, and assignment still happens through the database-checked
 * dispatch dialog.
 */
import { useMemo, useState } from "react";
import { Bike, MapPin, ShieldCheck } from "lucide-react";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, QueryState } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import { AssignRiderDialog } from "@/components/delivery/AssignRiderDialog";
import { useAuth } from "@/lib/auth";
import { money, riderStatusTone, shortDateTime, titleCase } from "@/lib/delivery";
import {
  useDeliveryProofs,
  useDeliveryZones,
  useDispatchBoard,
  useStaffDeliveryOrders,
} from "@/lib/delivery-data";

type Row = Record<string, unknown>;

/** Orders that still need someone to carry them. */
const PENDING_STATUSES = new Set([
  "confirmed",
  "in-preparation",
  "ready-for-pickup",
  "rider-assigned",
]);

function tone(t: string) {
  return t === "neutral" ? "default" : (t as "success" | "warning" | "info" | "destructive");
}

export function ZoneDispatchDashboard({ branchId }: { branchId?: string | null | undefined }) {
  const { can } = useAuth();
  const mayAssign = can("delivery", "dispatch.assign");
  const orders = useStaffDeliveryOrders({ branchId: branchId ?? null, status: "all" });
  const zones = useDeliveryZones(branchId);
  const board = useDispatchBoard(branchId);
  const proofs = useDeliveryProofs(branchId);
  const [target, setTarget] = useState<{ id: string; number: string; riderId: string | null } | null>(
    null,
  );

  const zoneName = useMemo(() => {
    const map = new Map<string, string>();
    for (const z of (zones.data ?? []) as Row[]) map.set(String(z["id"]), String(z["name"] ?? "Zone"));
    return map;
  }, [zones.data]);

  const grouped = useMemo(() => {
    const buckets = new Map<string, { label: string; orders: Row[] }>();
    for (const o of (orders.data ?? []) as Row[]) {
      if (!PENDING_STATUSES.has(String(o["order_status"]))) continue;
      const id = String(o["zone_id"] ?? "");
      const label = id ? (zoneName.get(id) ?? "Zone no longer configured") : "No zone recorded";
      const bucket = buckets.get(id || "none") ?? { label, orders: [] };
      bucket.orders.push(o);
      buckets.set(id || "none", bucket);
    }
    return [...buckets.values()].sort((a, b) => b.orders.length - a.orders.length);
  }, [orders.data, zoneName]);

  const pendingCount = grouped.reduce((n, g) => n + g.orders.length, 0);
  const riders = board.data?.riders ?? [];

  const riderName = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of riders) map.set(r.rider_id, r.display_name ?? "Rider");
    return map;
  }, [riders]);

  const proofByOrder = useMemo(() => {
    const set = new Set<string>();
    for (const p of proofs.data ?? []) {
      if (p.delivery_order_id) set.add(String(p.delivery_order_id));
    }
    return set;
  }, [proofs.data]);

  const stageLanes = useMemo(() => {
    const all = (orders.data ?? []) as Row[];
    const inStage = (statuses: string[]) =>
      all.filter((o) => statuses.includes(String(o["order_status"])));
    return [
      {
        id: "assigned",
        label: "Awaiting pickup",
        tone: "warning" as const,
        emptyHint: "No rider is waiting on a kitchen handover.",
        orders: inStage(["rider-assigned", "awaiting-rider"]),
      },
      {
        id: "collected",
        label: "Picked up",
        tone: "info" as const,
        emptyHint: "Nothing has just left the kitchen.",
        orders: inStage(["collected"]),
      },
      {
        id: "en-route",
        label: "On the way",
        tone: "info" as const,
        emptyHint: "No rider is currently travelling.",
        orders: inStage(["out-for-delivery", "en-route", "arrived"]),
      },
      {
        id: "delivered",
        label: "Delivered",
        tone: "success" as const,
        emptyHint: "No handovers completed in this view.",
        orders: inStage(["delivered", "completed"]).slice(0, 8),
      },
    ];
  }, [orders.data]);

  return (
    <div className="space-y-4">
      <SectionCard
        title="Pending orders by zone"
        description="Live orders that have not been delivered yet, grouped by the delivery zone the order was placed against."
      >
        <QueryState
          isLoading={orders.isLoading || zones.isLoading}
          error={orders.error}
          isEmpty={pendingCount === 0}
          empty={
            <EmptyState
              title="Nothing pending"
              description="Every live order has already been delivered or closed."
            />
          }
        >
          <div className="space-y-4">
            {grouped.map((group) => (
              <div key={group.label} className="rounded-lg border border-border/60 bg-card/40 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="flex items-center gap-1.5 text-sm font-semibold">
                    <MapPin className="h-4 w-4 text-muted-foreground" />
                    {group.label}
                  </p>
                  <StatusPill tone={group.orders.length > 3 ? "warning" : "default"}>
                    {group.orders.length} pending
                  </StatusPill>
                </div>
                <div className="space-y-2">
                  {group.orders.map((o) => {
                    const riderId = (o["rider_id"] as string | null) ?? null;
                    return (
                      <div
                        key={String(o["id"])}
                        className="rounded-md border border-border/50 bg-background/40 p-2.5 sm:flex sm:items-center sm:justify-between sm:gap-3"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {String(o["order_number"] ?? "—")} · {titleCase(String(o["order_status"]))}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {String(o["contact_name"] ?? "Guest")} · {money(o["grand_total"] as number)} ·{" "}
                            {titleCase(String(o["payment_method"] ?? "unspecified"))} ·{" "}
                            {riderId ? "rider assigned" : "no rider yet"}
                          </p>
                        </div>
                        {mayAssign ? (
                          <Button
                            size="sm"
                            variant={riderId ? "outline" : "default"}
                            className="mt-2 sm:mt-0"
                            onClick={() =>
                              setTarget({
                                id: String(o["id"]),
                                number: String(o["order_number"] ?? "order"),
                                riderId,
                              })
                            }
                          >
                            {riderId ? "Reassign rider" : "Assign rider"}
                          </Button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </QueryState>
      </SectionCard>

      <SectionCard
        title="Handover stages"
        description="Where each order sits between the rider being given it and the guest confirming receipt. Times are the ones the order itself recorded."
      >
        <QueryState
          isLoading={orders.isLoading}
          error={orders.error}
          isEmpty={stageLanes.every((l) => l.orders.length === 0)}
          empty={
            <EmptyState
              title="Nothing on the road"
              description="Orders appear here once a rider is holding them."
            />
          }
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {stageLanes.map((lane) => (
              <div key={lane.id} className="rounded-lg border border-border/60 bg-card/40 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{lane.label}</p>
                  <StatusPill tone={lane.orders.length ? lane.tone : "default"}>
                    {lane.orders.length}
                  </StatusPill>
                </div>
                {lane.orders.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{lane.emptyHint}</p>
                ) : (
                  <div className="space-y-2">
                    {lane.orders.map((o) => (
                      <div
                        key={String(o["id"])}
                        className="rounded-md border border-border/50 bg-background/40 p-2"
                      >
                        <p className="truncate text-xs font-medium">
                          {String(o["order_number"] ?? "—")}
                        </p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {riderName.get(String(o["rider_id"] ?? "")) ?? "No rider"} ·{" "}
                          {shortDateTime(
                            (o["delivered_at"] as string | null) ??
                              (o["collected_at"] as string | null) ??
                              (o["ready_at"] as string | null) ??
                              (o["updated_at"] as string | null),
                          )}
                        </p>
                        {lane.id === "delivered" ? (
                          <p className="text-[11px] text-muted-foreground">
                            {proofByOrder.has(String(o["id"]))
                              ? "Proof recorded"
                              : "No proof recorded"}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </QueryState>
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="Rider status"
          description="Shift cover, stated availability and how much each rider is already carrying."
        >
          <QueryState
            isLoading={board.isLoading}
            error={board.error}
            isEmpty={riders.length === 0}
            empty={<EmptyState title="No riders on the roster" description="Enrol staff who hold a rider capability." />}
          >
            <div className="space-y-2">
              {riders.map((r) => (
                <div
                  key={r.rider_id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/40 p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      <Bike className="mr-1 inline h-3.5 w-3.5" />
                      {r.display_name ?? "Rider"}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {r.rider_code ?? "—"} · {titleCase(r.vehicle_type ?? "unspecified")} ·{" "}
                      {r.delivered_today} delivered today
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusPill tone={r.on_shift ? "success" : "warning"}>
                      {r.on_shift ? "On shift" : "Off shift"}
                    </StatusPill>
                    <StatusPill tone={tone(riderStatusTone(r.availability_status ?? ""))}>
                      {titleCase(r.availability_status ?? "unknown")}
                    </StatusPill>
                    <StatusPill tone={r.active_load >= (r.max_active ?? 3) ? "destructive" : "default"}>
                      {r.active_load}/{r.max_active}
                    </StatusPill>
                  </div>
                </div>
              ))}
            </div>
          </QueryState>
        </SectionCard>

        <SectionCard
          title="Proof of delivery"
          description="What the rider recorded at the handover. These records are read-only."
        >
          <QueryState
            isLoading={proofs.isLoading}
            error={proofs.error}
            isEmpty={(proofs.data ?? []).length === 0}
            empty={
              <EmptyState
                title="No handovers recorded yet"
                description="Proof appears here as riders confirm deliveries in their app."
              />
            }
          >
            <div className="space-y-2">
              {(proofs.data ?? []).map((p) => (
                <div key={p.id} className="rounded-lg border border-border/60 bg-card/40 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium">
                      {p.delivery_orders?.order_number ?? "Order"} ·{" "}
                      {p.recipient_name ?? p.delivery_orders?.contact_name ?? "Recipient not named"}
                    </p>
                    <StatusPill tone={p.pin_verified ? "success" : "warning"}>
                      <ShieldCheck className="mr-1 inline h-3 w-3" />
                      {p.pin_verified ? "PIN verified" : "No PIN"}
                    </StatusPill>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {titleCase(p.method ?? "confirmation")} · {shortDateTime(p.confirmed_at)}
                    {p.photo_path ? " · photo captured" : ""}
                    {p.signature_path ? " · signature captured" : ""}
                    {p.latitude !== null && p.longitude !== null
                      ? ` · ${p.latitude.toFixed(4)}, ${p.longitude.toFixed(4)}`
                      : ""}
                  </p>
                </div>
              ))}
            </div>
          </QueryState>
        </SectionCard>
      </div>

      <AssignRiderDialog
        orderId={target?.id ?? null}
        orderNumber={target?.number ?? null}
        currentRiderId={target?.riderId ?? null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
      />
    </div>
  );
}
