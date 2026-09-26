import { useEffect, useState } from "react";
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
  useConfirmDelivery,
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
import { RiderTabBar } from "@/components/public/RiderTabBar";
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
  const riderId = rider.data?.["id"] as string | undefined;
  const deliveries = useMyDeliveries(riderId);
  const advance = useRiderAdvance();
  const claim = useClaimWaitingOrder();
  const confirm = useConfirmDelivery();
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
  );
  const onRoad = active.filter((o) => ["rider-assigned", "collected", "out-for-delivery"].includes(String(o["order_status"])));
  const done = ((deliveries.data ?? []) as Row[]).filter((o) =>
    ["delivered", "completed"].includes(String(o["order_status"])),
  );

  return (
     <div className="neo-rider-page">
      <PreviewBanner experience="Rider" />
      <header className="sticky top-0 z-10 bg-[color:var(--rider-navy)] px-4 py-4" style={{ background: brandFallback.navy }}>
         <div className="mx-auto grid w-full max-w-md min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
           <div className="min-w-0">
             <p className="truncate text-sm font-semibold text-white">
              {String(rider.data["display_name"] ?? "Rider")}
            </p>
            <p className="text-xs text-white/60">{statusLabel(availability)} · {active.length} active</p>
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
                background: availability === "available" ? brandFallback.primary : "#ffffff22",
                color: "#fff",
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
        <section className="neo-rider-hero">
          <div>
            <p className="neo-commerce-eyebrow">Today's run</p>
            <h1 className="mt-1 text-2xl font-bold text-white">Your delivery board</h1>
            <p className="mt-2 text-sm text-white/75">Pick up only when Kitchen is ready. Complete the handover with PIN/POD and reconcile cash here.</p>
          </div>
          <div className="neo-rider-stat-grid">
            <div><strong>{active.length}</strong><span>Active</span></div>
            <div><strong>{onRoad.length}</strong><span>On road</span></div>
            <div><strong>{done.length}</strong><span>Done</span></div>
          </div>
        </section>

        <LocationSharing deliveryIds={onRoad.map((o) => String(o["id"]))} />

        <div className="flex items-center justify-between gap-3">
          <div><p className="text-xs font-bold uppercase tracking-[.16em] text-slate-500">Assigned to you</p><h2 className="text-lg font-bold text-slate-950">Deliveries</h2></div>
          <Link to="/rider/active" className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-800">Open active job</Link>
        </div>


        {active.length === 0 ? (
          <p className="neo-rider-card p-6 text-center text-sm" style={{ color: brandFallback.steel }}>
            No active deliveries assigned to you right now.
          </p>
        ) : (
          active.map((order) => (
            <DeliveryCard
              key={String(order["id"])}
              order={order}
              onAdvance={(to) => advance.mutate({ orderId: String(order["id"]), to })}
              onConfirm={(pin, recipient, cash) =>
                confirm.mutate({
                  orderId: String(order["id"]),
                  pin,
                  recipient,
                  ...(cash === undefined ? {} : { cash }),
                })
              }
            />
          ))
        )}

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
              Completed today
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
  onAdvance,
  onConfirm,
}: {
  order: Row;
  onAdvance: (to: string) => void;
  onConfirm: (pin: string, recipient: string, cash?: number) => void;
}) {
  const status = String(order["order_status"]);
  const next = NEXT_STEP[status];
  // Older orders were saved as "cash-on-delivery"; they still count as cash.
  const isCash = normalisePaymentMethod(String(order["payment_method"] ?? "")) === "cash";
  const [pin, setPin] = useState("");
  const [recipient, setRecipient] = useState("");
  const [cash, setCash] = useState("");

  return (
    <article className="neo-rider-card p-4">
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
            className="inline-flex items-center gap-1 text-xs font-medium"
            style={{ color: brandFallback.primary }}
          >
            <Phone className="size-3.5" /> Call
          </a>
        ) : null}
      </div>

      {order["delivery_address"] ? (
        <p className="mt-2 break-words text-sm" style={{ color: brandFallback.secondary }}>
          {String(order["delivery_address"])}
        </p>
      ) : null}

      {next ? (
        <button
          onClick={() => onAdvance(next.to)}
          className="mt-4 w-full rounded-xl px-4 py-2.5 text-sm font-semibold text-white"
          style={{ background: brandFallback.primary }}
        >
          {next.label}
        </button>
      ) : null}

      {status === "out-for-delivery" ? (
        <div className="mt-4 space-y-2 border-t border-black/5 pt-4">
          <Label htmlFor={`pod-pin-${String(order["id"])}`}>Customer PIN</Label>
          <Input
            id={`pod-pin-${String(order["id"])}`}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            maxLength={6}
            placeholder="Ask the customer for their PIN"
          />
          <p className="text-xs" style={{ color: brandFallback.steel }}>
            Ask the customer to read it from their order screen. After five wrong tries the
            handover locks and dispatch has to authorise it.
          </p>
          <Label htmlFor={`pod-recipient-${String(order["id"])}`}>Received by</Label>
          <Input
            id={`pod-recipient-${String(order["id"])}`}
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
          />
          {isCash ? (
            <>
              <Label htmlFor={`pod-cash-${String(order["id"])}`}>Cash collected</Label>
              <Input
                id={`pod-cash-${String(order["id"])}`}
                value={cash}
                onChange={(e) => setCash(e.target.value)}
                inputMode="decimal"
              />
            </>
          ) : null}
          <button
            onClick={() => onConfirm(pin, recipient, cash ? Number(cash) : undefined)}
            disabled={!recipient || (pin.length > 0 && pin.length < 4)}
            className="mt-2 w-full rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: brandFallback.secondary }}
          >
            Confirm delivery
          </button>
          <p className="text-xs" style={{ color: brandFallback.steel }}>
            Leave the PIN blank only if dispatch has authorised this handover without it.
          </p>
        </div>
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
