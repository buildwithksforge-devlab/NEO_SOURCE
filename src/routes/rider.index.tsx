import { useEffect, useState } from "react";
import { RiderHandoverForm } from "@/components/public/RiderHandoverForm";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CarTaxiFront, LifeBuoy, Loader2, LogOut, Phone, UserRound } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { normalisePaymentMethod } from "@/lib/payment-methods";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { neoSignOut } from "@/lib/session-exit";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import { money, statusLabel } from "@/lib/public-delivery";
import {
  useClaimWaitingOrder,
  useMyDeliveries,
  useMyOutstandingCash,
  useMyRiderProfile,
  useRiderAdvance,
  useSetRiderAvailability,
  useSubmitRemittance,
  useAdvanceTransportJob,
  useMyTransportJobs,
  useZoneWaitingQueue,
  type RiderTransportJob,
  type ZoneQueueGroup,
} from "@/lib/delivery-data";
import { PreviewBanner } from "@/components/public/PreviewBanner";
import { RiderTabBar, useRiderBrand } from "@/components/public/RiderTabBar";
import { BrandMark } from "@/components/public/PublicAppShell";
import { useRiderLocationSharing } from "@/lib/delivery-live";

export const Route = createFileRoute("/rider/")({
  head: () => ({
    meta: [
      { title: "Rider App — NEØ deliveries" },
      { name: "description", content: "Assigned deliveries, pickup, drop-off and cash collection for hotel riders." },
      { property: "og:title", content: "Rider App — NEØ deliveries" },
      { property: "og:description", content: "Assigned deliveries and delivery confirmation for hotel riders." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: RiderHome,
});

type Row = Record<string, unknown>;

const NEXT_STEP: Record<string, { to: string; label: string }> = {
  "rider-assigned": { to: "collected", label: "Picked up from restaurant" },
  collected: { to: "en-route", label: "Start delivery" },
};

function RiderHome() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { user, loading } = useCustomerSession();
  const rider = useMyRiderProfile();
  const brand = useRiderBrand((rider.data?.["branch_id"] as string | null) ?? null, user?.id);
  const riderId = rider.data?.["id"] as string | undefined;
  const deliveries = useMyDeliveries(riderId);
  const advance = useRiderAdvance();
  const claim = useClaimWaitingOrder();
  const setAvailability = useSetRiderAvailability();
  const transportJobs = useMyTransportJobs();
  const waiting = useZoneWaitingQueue((rider.data?.["branch_id"] as string | null) ?? null);
  const advanceTransport = useAdvanceTransportJob();

  useEffect(() => {
    if (!loading && !user) void navigate({ to: "/rider/login" });
  }, [loading, user, navigate]);

  if (loading || rider.isLoading) {
    return (
       <div className="neo-public-app flex min-h-screen items-center justify-center">
        <Loader2 className="size-6 animate-spin text-white" />
      </div>
    );
  }

  if (!rider.data) {
    return (
      <div
         className="neo-public-app flex min-h-screen flex-col items-center justify-center px-5 text-center"
        style={{ background: brandFallback.navy }}
      >
         <div className="neo-rider-card w-full max-w-sm p-6">
          <h1 className="text-lg font-semibold" style={{ color: brandFallback.secondary }}>
            Rider access not open
          </h1>
          <p className="mt-2 text-sm" style={{ color: brandFallback.steel }}>
            This account is not on an active rider roster. Ask your delivery manager to add you, or
            to put you back on the roster if your access was withdrawn.
          </p>
          <button
            className="mt-5 text-sm font-medium"
            style={{ color: brandFallback.primary }}
            onClick={async () => {
              await neoSignOut(queryClient, { to: "/rider/login" });
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  const availability = String(rider.data["availability_status"] ?? "offline");
  const active = ((deliveries.data ?? []) as Row[]).filter(
    (o) => !["delivered", "completed", "cancelled", "returned"].includes(String(o["order_status"])),
  ).sort((a, b) => riderJobPriority(b) - riderJobPriority(a));
  const onRoad = active.filter((o) => ["rider-assigned", "collected", "out-for-delivery"].includes(String(o["order_status"])));
  const done = ((deliveries.data ?? []) as Row[]).filter((o) =>
    ["delivered", "completed"].includes(String(o["order_status"])),
  );

  return (
     <div className="neo-rider-page" style={brand.style}>
      <PreviewBanner experience="Rider" />
      <header className="sticky top-0 z-10 bg-[color:var(--rider-navy)] px-4 py-4" style={{ background: brandFallback.navy }}>
         <div className="mx-auto grid w-full max-w-md min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
           <div className="flex min-w-0 items-center gap-2">
            {brand.property ? <span className="max-w-10 shrink-0 overflow-hidden rounded-lg"><BrandMark size={32} workspace={{
              hotel_name: brand.property.property_name, app_name: "Rider", primary_color: brand.primary,
              logo_url: brand.property.media?.logo_url || brand.property.logo_url, button_style: "rounded",
            }} /></span> : null}
            <div className="min-w-0">
             <p className="truncate text-sm font-semibold text-white">
              {String(rider.data["display_name"] ?? "Rider")}
            </p>
            <p className="truncate text-xs text-white/75">{brand.property?.property_name || statusLabel(availability)} · {active.length} active</p>
            </div>
          </div>
           <div className="flex shrink-0 items-center gap-2">
            <Link to="/rider/support" aria-label="My support" className="text-white/70">
              <LifeBuoy className="size-4" />
            </Link>
            <Link to="/rider/profile" aria-label="My profile" className="text-white/70">
              <UserRound className="size-4" />
            </Link>
            <button
              onClick={() =>
                setAvailability.mutate({
                  riderId: String(rider.data!["id"]),
                  status: availability === "available" ? "offline" : "available",
                })
              }
              className="rounded-full px-3 py-1.5 text-xs font-semibold"
              style={{
                background: availability === "available" ? brand.primary : "#ffffff22",
                color: availability === "available" ? "var(--pa-on-primary)" : "#fff",
              }}
            >
              {availability === "available" ? "Available" : "Go online"}
            </button>
            <button
              aria-label="Sign out"
              onClick={async () => {
                await neoSignOut(queryClient, { to: "/rider/login" });
              }}
              className="text-white/70"
            >
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </header>

       <main className="mx-auto w-full max-w-md min-w-0 space-y-5 px-4 pb-28 pt-5">
        <section className="neo-rider-hero !flex flex-wrap items-center justify-between">
          <div><h1 className="text-2xl font-bold text-white">My deliveries</h1>
            <p className="mt-1 text-sm text-white/80">{active.length} assigned · {statusLabel(availability)}</p>
          </div>
          {onRoad.length ? <Link to="/rider/active" className="neo-commerce-primary">Active jobs</Link> : null}
        </section>

        {deliveries.isLoading ? (
          <p className="neo-rider-card p-5 text-slate-700" role="status">Loading assigned deliveries…</p>
        ) : deliveries.isError ? (
          <div className="neo-rider-card p-5 text-slate-800" role="alert">
            <p>Your assigned deliveries couldn’t load.</p>
            <button className="neo-commerce-primary mt-3" onClick={() => void deliveries.refetch()}>Retry</button>
          </div>
        ) : active.length === 0 ? (
          <p className="neo-rider-card p-6 text-center text-sm" style={{ color: brandFallback.steel }}>
            No active deliveries assigned to you right now.
          </p>
        ) : (
          active.map((order) => (
            <DeliveryCard
              key={String(order["id"])}
              order={order}
              busy={advance.isPending}
              onAdvance={(to) => advance.mutate({ orderId: String(order["id"]), to })}
            />
          ))
        )}

        <LocationSharing deliveryIds={onRoad.filter((o) => o["order_status"] !== "rider-assigned").map((o) => String(o["id"]))} />

        <ZoneQueue
          groups={waiting.data ?? []}
          loading={waiting.isLoading}
          onClaim={(id, collect) => claim.mutate({ orderId: id, collect })}
          claiming={claim.isPending}
        />

        <TransportJobs
          jobs={transportJobs.data ?? []}
          onAdvance={(id, status) => advanceTransport.mutate({ requestId: id, status })}
          busy={advanceTransport.isPending}
        />

        <CashHandover riderId={String(rider.data["id"])} branchId={(rider.data["branch_id"] as string | null) ?? null} />

        {done.length ? (
          <section>
            <h2 className="mb-2 mt-6 text-sm font-semibold" style={{ color: brandFallback.steel }}>
              Recently completed
            </h2>
            <ul className="space-y-2">
              {done.slice(0, 10).map((order) => (
                <li
                  key={String(order["id"])}
                  className="neo-public-row rounded-xl bg-white px-4 py-3 text-sm"
                >
                   <span data-public-id style={{ color: brandFallback.secondary }}>{String(order["order_number"])}</span>
                   <span className="shrink-0 whitespace-nowrap" style={{ color: brandFallback.steel }}>
                    {money(order["grand_total"], String(order["currency"] ?? "KES"))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>
      <RiderTabBar active="home" />
    </div>
  );
}

function riderJobPriority(order: Row) {
  const status = order["order_status"];
  if (status === "out-for-delivery") return 3;
  if (status === "collected") return 2;
  return ["ready", "completed"].includes(String(order["kitchen_status"])) ? 1 : 0;
}

const TRANSPORT_NEXT: Record<string, { to: "arriving" | "picked-up" | "completed"; label: string }> = {
  "driver-assigned": { to: "arriving", label: "On my way to pickup" },
  confirmed: { to: "arriving", label: "On my way to pickup" },
  arriving: { to: "picked-up", label: "Guest picked up" },
  "picked-up": { to: "completed", label: "Drop-off complete" },
};

/** Transfers assigned to this rider only — never another rider's work. */
/**
 * Orders at this property still waiting for a rider, grouped by zone. Dispatch
 * can hand one over, and a rider can also take one here; the database still
 * checks the property, the rider's load and cash clearance.
 */
function ZoneQueue({
  groups,
  loading,
  onClaim,
  claiming,
}: {
  groups: ZoneQueueGroup[];
  loading: boolean;
  onClaim: (orderId: string, collect: boolean) => void;
  claiming: boolean;
}) {
  if (loading) return null;
  return (
    <section>
      <h2 className="mb-2 mt-6 text-sm font-semibold" style={{ color: brandFallback.steel }}>
        Waiting for a rider
      </h2>
      {groups.length === 0 ? (
        <p className="rounded-2xl bg-white p-4 text-center text-sm" style={{ color: brandFallback.steel }}>
          Nothing is waiting for a rider at your property.
        </p>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <div key={group.zoneId} className="neo-rider-card p-4">
              <div className="neo-public-row">
                <p className="truncate text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                  {group.zoneName}
                </p>
                <span className="text-xs" style={{ color: brandFallback.steel }}>
                  {group.orders.length} order{group.orders.length === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="mt-2 space-y-1.5">
                {group.orders.map((order) => {
                  // Only an order the kitchen has finished can be picked up in
                  // one tap; anything earlier is claimed now and collected
                  // when it is actually handed over.
                  const ready = String(order["order_status"]) === "ready-for-pickup";
                  return (
                    <li key={String(order["id"])} className="grid min-w-0 gap-2 border-t border-black/5 py-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                      <span data-public-id style={{ color: brandFallback.secondary }}>{String(order["order_number"])}</span>
                      <span data-public-actions className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
                        <span className="min-w-0 text-xs" style={{ color: brandFallback.steel }}>
                          {statusLabel(String(order["order_status"]))} · {money(Number(order["grand_total"] ?? 0))}
                        </span>
                        <button
                          type="button"
                          disabled={claiming}
                          onClick={() => onClaim(String(order["id"]), false)}
                          className="rounded-full px-3 py-1 text-xs font-semibold disabled:opacity-50"
                          style={{ border: `1px solid ${brandFallback.primary}`, color: brandFallback.primary }}
                        >
                          {claiming ? "Taking…" : "Take it"}
                        </button>
                        {ready ? (
                          <button
                            type="button"
                            disabled={claiming}
                            onClick={() => onClaim(String(order["id"]), true)}
                            className="rounded-full px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
                            style={{ background: brandFallback.primary }}
                          >
                            {claiming ? "Taking…" : "Take & picked up"}
                          </button>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-xs" style={{ color: brandFallback.steel }}>
                Dispatch can also hand you an order; either way it moves up to your deliveries.
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}


function TransportJobs({
  jobs,
  onAdvance,
  busy,
}: {
  jobs: RiderTransportJob[];
  onAdvance: (id: string, status: "arriving" | "picked-up" | "completed") => void;
  busy: boolean;
}) {
  if (!jobs.length) return null;
  return (
    <section className="space-y-2">
      <h2 className="mt-6 flex items-center gap-2 text-sm font-semibold" style={{ color: brandFallback.steel }}>
        <CarTaxiFront className="size-4" aria-hidden /> My transfers
      </h2>
      {jobs.map((job) => {
        const next = TRANSPORT_NEXT[job.status];
        return (
          <article key={job.id} className="neo-rider-card p-4">
            <div className="neo-public-row">
              <div className="min-w-0">
                <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                  <span data-public-id>{job.request_number}</span>
                </p>
                <p className="text-xs" style={{ color: brandFallback.steel }}>
                  {job.pickup_at ? new Date(job.pickup_at).toLocaleString() : "—"} ·{" "}
                  {statusLabel(job.status)}
                </p>
              </div>
              {job.guest_phone ? (
                <a
                  href={`tel:${job.guest_phone}`}
                  className="inline-flex items-center gap-1 text-xs font-medium"
                  style={{ color: brandFallback.primary }}
                >
                  <Phone className="size-3.5" /> Call
                </a>
              ) : null}
            </div>
            <p className="mt-2 break-words text-sm" style={{ color: brandFallback.secondary }}>
              {job.pickup_point} → {job.destination}
            </p>
            <p className="text-xs" style={{ color: brandFallback.steel }}>
              {job.guest_name ?? "Guest"} · {job.passengers ?? 1} pax · {job.luggage_count ?? 0} bags
            </p>
            {next ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => onAdvance(job.id, next.to)}
                className="mt-3 w-full rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: brandFallback.primary }}
              >
                {next.label}
              </button>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}

/** Cash the rider still holds. The server recomputes what is owed on submit. */
function CashHandover({ riderId, branchId }: { riderId: string; branchId: string | null }) {
  const outstanding = useMyOutstandingCash(riderId);
  const submit = useSubmitRemittance();
  const [declared, setDeclared] = useState("");
  const total = outstanding.data?.total ?? 0;
  const count = outstanding.data?.rows.length ?? 0;

  if (!count) return null;

  return (
    <section className="neo-rider-card p-4">
      <h2 className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
        Cash to hand over
      </h2>
      <p className="mt-1 text-xs" style={{ color: brandFallback.steel }}>
        {count} collected {count === 1 ? "order" : "orders"} · {money(total, "KES")} recorded
      </p>
      <div className="mt-3 space-y-2">
        <Label>Amount you are handing over</Label>
        <Input value={declared} onChange={(e) => setDeclared(e.target.value)} inputMode="decimal" />
        <button
          onClick={() => {
            submit.mutate(
              { declared: Number(declared), branchId },
              { onSuccess: () => setDeclared("") },
            );
          }}
          disabled={!declared || submit.isPending}
          className="w-full rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          style={{ background: brandFallback.secondary }}
        >
          Submit cash for counting
        </button>
      </div>
    </section>
  );
}

function DeliveryCard({
  order,
  busy,
  onAdvance,
}: {
  order: Row;
  busy: boolean;
  onAdvance: (to: string) => void;
}) {
  const status = String(order["order_status"]);
  const next = NEXT_STEP[status];
  const readyForPickup = status !== "rider-assigned" || ["ready", "completed"].includes(String(order["kitchen_status"]));
  const snapshot = (order["address_snapshot"] ?? {}) as Row;
  const destination = [snapshot["address_line"] ?? snapshot["line1"] ?? order["delivery_address"], snapshot["city"]].filter(Boolean).join(", ");
  // Older orders were saved as "cash-on-delivery"; they still count as cash.
  const isCash = normalisePaymentMethod(String(order["payment_method"] ?? "")) === "cash";

  return (
    <article id={`job-${String(order["id"])}`} className="neo-rider-card scroll-mt-24 p-4">
      <div className="neo-public-row">
        <div className="min-w-0">
          <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
            <span data-public-id>{String(order["order_number"])}</span>
          </p>
          <p className="text-xs" style={{ color: brandFallback.steel }}>
            {statusLabel(status)} · {money(order["grand_total"], String(order["currency"] ?? "KES"))}
            {isCash ? " · collect cash" : ""}
          </p>
        </div>
        {order["contact_phone"] ? (
          <a
            href={`tel:${String(order["contact_phone"])}`}
            className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-slate-800"
          >
            <Phone className="size-3.5" /> Call
          </a>
        ) : null}
      </div>

      {destination ? (
        <p className="mt-2 break-words text-sm" style={{ color: brandFallback.secondary }}>
          {destination}
        </p>
      ) : null}

      {next ? (
        readyForPickup ? <button onClick={() => onAdvance(next.to)} disabled={busy}
          className="neo-commerce-primary mt-4 w-full">
          {next.label}
        </button> : <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2 text-sm font-medium text-amber-950">Waiting for the kitchen to mark this order ready.</p>
      ) : null}

      {status === "out-for-delivery" ? (
        <RiderHandoverForm orderId={String(order["id"])} paymentMethod={String(order["payment_method"] ?? "")} />
      ) : null}
    </article>
  );
}

/**
 * Position sharing while a run is live. The rider's phone sends a position
 * only for deliveries they are actually carrying, and the database refuses it
 * where the property has tracking switched off — nothing is shared between runs.
 */
function LocationSharing({ deliveryIds }: { deliveryIds: string[] }) {
  const { sharing } = useRiderLocationSharing(deliveryIds);
  if (deliveryIds.length === 0) return null;
  return (
    <p className="neo-rider-card px-4 py-3 text-xs" style={{ color: brandFallback.steel }}>
      {sharing
        ? "Your position is shared with the customer while you are on this run. It stops when the run ends."
        : "Position sharing is off for this property, or your phone has not allowed location access."}
    </p>
  );
}
