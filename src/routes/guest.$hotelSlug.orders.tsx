import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Bike, ChevronRight, Loader2, ShoppingBag, Utensils } from "lucide-react";
import { GuestScreen, GuestSection } from "@/components/public/GuestScreen";
import { PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import { money, statusLabel, useMyPublicOrders } from "@/lib/public-delivery";
import { useGuestProfile, useGuestScreenView } from "@/lib/guest-app";
import { orderBucket } from "@/lib/guest-presentation";

export { orderBucket } from "@/lib/guest-presentation";

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
  const orders = useMyPublicOrders(ws.organization_id, customerId, ws.branch_id);
  useGuestScreenView(ws.organization_id, "orders", Boolean(customerId));

  const grouped = useMemo(() => {
    const out: Record<string, Row[]> = { active: [], scheduled: [], completed: [], cancelled: [] };
    for (const o of orders.data ?? []) {
      out[orderBucket(o["order_status"], o["scheduled_for"], o["fulfilment_type"])]?.push(o as Row);
    }
    return out;
  }, [orders.data]);
  const visible = grouped[bucket] ?? [];

  return (
    <GuestScreen hotelSlug={hotelSlug} active="orders">
      <section className="neo-guest-explore-heading">
        <h1 className="neo-pub-display text-3xl sm:text-4xl" style={{ color: "var(--guest-text, #07142D)" }}>
          My orders
        </h1>
      </section>

      {!loading && !user ? (
        <GuestSignInPrompt
          hotelSlug={hotelSlug}
          title="Sign in to see your orders"
          description="Your order history and live status are private to your account."
        />
      ) : orders.isLoading || profile.isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin" style={{ color: "var(--guest-muted, #52627A)" }} />
        </div>
      ) : orders.isError || profile.isError ? (
        <PublicEmptyState title="Orders couldn’t load" description={`Try again to see orders for ${ws.hotel_name}.`}
          action={<button className="neo-guest-secondary" onClick={() => void (profile.isError ? profile.refetch() : orders.refetch())}>Retry orders</button>} />
      ) : (orders.data?.length ?? 0) === 0 ? (
        <GuestSection title="Order history">
          <PublicEmptyState
            title="No orders yet"
            description="Orders you place with this property will appear here with live status."
          />
        </GuestSection>
      ) : (
        <div className="mt-5">
          <div className="neo-guest-segments mb-4" role="group" aria-label="Order status">
            {buckets.map((b) => {
              const selected = b.key === bucket;
              return (
                <button
                  key={b.key}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setBucket(b.key)}
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
          <ul className="neo-guest-records" aria-label="Order history">
            {visible.map((o) => {
              const fulfilment = o["fulfilment_type"];
              const Icon = fulfilment === "delivery" ? Bike : fulfilment === "pickup" ? ShoppingBag : Utensils;
              const status = statusLabel(o["order_status"]);
              return (
              <li key={String(o["id"])}>
                <Link to="/guest/$hotelSlug/orders/$orderReference" params={{ hotelSlug, orderReference: String(o["order_number"]) }} className="neo-guest-record">
                  <span className="neo-guest-record-icon"><Icon className="size-5" aria-hidden /></span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold" style={{ color: "var(--guest-text, #07142D)" }}>
                      <span data-public-id>{String(o["order_number"])}</span>
                    </p>
                    <p className="text-xs" style={{ color: "var(--guest-muted, #52627A)" }}>
                      {statusLabel(fulfilment)} · {new Date(String(o["created_at"])).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
                    </p>
                  </div>
                  <div className="neo-guest-record-total">
                    <p className="text-sm font-semibold" style={{ color: "var(--guest-text, #07142D)" }}>
                      {money(o["grand_total"], String(o["currency"] ?? "KES"))}
                    </p>
                    <p className="text-xs font-medium" style={{ color: "var(--pa-accent-ink)" }}>
                      {status}
                    </p>
                  </div>
                  <ChevronRight className="neo-guest-record-arrow size-4" aria-hidden />
                </Link>
              </li>
            ); })}
          </ul>
          )}
        </div>
      )}
    </GuestScreen>
  );
}
