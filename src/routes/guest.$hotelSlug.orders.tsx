import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { GuestScreen, GuestSection } from "@/components/public/GuestScreen";
import { PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import { money, statusLabel, useMyPublicOrders } from "@/lib/public-delivery";
import { useGuestProfile, useGuestScreenView } from "@/lib/guest-app";

export const Route = createFileRoute("/guest/$hotelSlug/orders")({
  head: () => ({
    meta: [
      { title: "My Orders — NEØ Guest" },
      { name: "description", content: "Track your room service, restaurant and delivery orders." },
      { property: "og:title", content: "My Orders — NEØ Guest" },
      { property: "og:description", content: "Track your room service, restaurant and delivery orders." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      // Personal to one guest: never a search result.
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: OrdersPage,
});

type Row = Record<string, unknown>;

/** Guest-facing grouping of an order's real status. */
const ACTIVE = ["pending", "confirmed", "accepted", "preparing", "ready", "dispatched", "on_the_way", "picked_up"];
const CANCELLED = ["cancelled", "rejected", "declined", "failed"];
const COMPLETED = ["completed", "delivered", "collected", "closed", "served"];

export function orderBucket(status: unknown, scheduledFor?: unknown) {
  const value = String(status ?? "").toLowerCase();
  if (CANCELLED.includes(value)) return "cancelled" as const;
  if (COMPLETED.includes(value)) return "completed" as const;
  if (scheduledFor && new Date(String(scheduledFor)).getTime() > Date.now()) return "scheduled" as const;
  return ACTIVE.includes(value) ? ("active" as const) : ("completed" as const);
}

const buckets = [
  { key: "active", label: "Active" },
  { key: "scheduled", label: "Scheduled" },
  { key: "completed", label: "Completed" },
  { key: "cancelled", label: "Cancelled" },
] as const;

function OrdersPage() {
  const ws = useWorkspace();
  const [bucket, setBucket] = useState<(typeof buckets)[number]["key"]>("active");
  const { hotelSlug } = Route.useParams();
  const { user, loading } = useCustomerSession();
  const profile = useGuestProfile(ws.organization_id, user?.id, ws.branch_id);
  const customerId = profile.data?.["id"] as string | undefined;
  const orders = useMyPublicOrders(ws.organization_id, customerId);
  useGuestScreenView(ws.organization_id, "orders", Boolean(customerId));

  const grouped = useMemo(() => {
    const out: Record<string, Row[]> = { active: [], scheduled: [], completed: [], cancelled: [] };
    for (const o of orders.data ?? []) {
      out[orderBucket(o["order_status"], o["scheduled_for"])]?.push(o as Row);
    }
    return out;
  }, [orders.data]);
  const visible = grouped[bucket] ?? [];

  return (
    <GuestScreen hotelSlug={hotelSlug} active="orders">
      <section>
        <h1 className="neo-pub-display text-3xl sm:text-4xl" style={{ color: brandFallback.secondary }}>
          My orders
        </h1>
        <p className="mt-2 text-sm" style={{ color: brandFallback.steel }}>
          Room service, restaurant and delivery orders placed with {ws.hotel_name}.
        </p>
      </section>

      {!loading && !user ? (
        <GuestSignInPrompt
          hotelSlug={hotelSlug}
          title="Sign in to see your orders"
          description="Your order history and live status are private to your account."
        />
      ) : orders.isLoading || profile.isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin" style={{ color: brandFallback.steel }} />
        </div>
      ) : (orders.data?.length ?? 0) === 0 ? (
        <GuestSection title="Order history">
          <PublicEmptyState
            title="No orders yet"
            description="Orders you place with this property will appear here with live status."
          />
        </GuestSection>
      ) : (
        <GuestSection title="Order history" description="Live status straight from the kitchen and dispatch.">
          <div className="neo-scroll-x -mx-1 mb-4 flex gap-2 px-1" role="tablist" aria-label="Order status">
            {buckets.map((b) => {
              const selected = b.key === bucket;
              return (
                <button
                  key={b.key}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setBucket(b.key)}
                  className="inline-flex min-h-9 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium"
                  style={{
                    borderColor: selected ? ws.primary_color : "rgba(0,0,0,0.1)",
                    background: selected ? ws.primary_color : "transparent",
                    color: selected ? "#fff" : brandFallback.steel,
                  }}
                >
                  {b.label}
                  <span className="text-xs opacity-80">{(grouped[b.key] ?? []).length}</span>
                </button>
              );
            })}
          </div>
          {visible.length === 0 ? (
            <PublicEmptyState
              title={`No ${bucket} orders`}
              description="Switch tabs to see your other orders with this property."
            />
          ) : (
          <ul className="space-y-3">
            {visible.map((o) => (
              <li key={String(o["id"])} className="min-w-0 rounded-xl border border-black/5 p-4">
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                      <span data-public-id>{String(o["order_number"])}</span>
                    </p>
                    <p className="text-xs" style={{ color: brandFallback.steel }}>
                      {new Date(String(o["created_at"])).toLocaleString()} ·{" "}
                      {statusLabel(o["fulfilment_type"])}
                    </p>
                  </div>
                  <div className="min-w-0 sm:text-right">
                    <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                      {money(o["grand_total"], String(o["currency"] ?? "KES"))}
                    </p>
                    <p className="text-xs font-medium" style={{ color: ws.primary_color }}>
                      {statusLabel(o["order_status"])} · {statusLabel(o["payment_status"])}
                    </p>
                    <Link
                      to="/guest/$hotelSlug/orders/$orderReference"
                      params={{ hotelSlug, orderReference: String(o["order_number"]) }}
                      className="text-xs underline"
                      style={{ color: brandFallback.steel }}
                    >
                      Track order
                    </Link>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          )}
        </GuestSection>
      )}
    </GuestScreen>
  );
}
