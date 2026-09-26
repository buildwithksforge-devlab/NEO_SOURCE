import { createFileRoute, Link } from "@tanstack/react-router";
import { GuestScreen, GuestSection } from "@/components/public/GuestScreen";
import { GuestCardsSkeleton } from "@/components/public/GuestSkeleton";
import { PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import { money, statusLabel, useMyPublicOrders } from "@/lib/public-delivery";
import { useGuestProfile, useGuestScreenView } from "@/lib/guest-app";

export const Route = createFileRoute("/guest/$hotelSlug/track")({
  head: () => ({
    meta: [
      { title: "Track your order — NEØ Guest" },
      { name: "description", content: "Follow your room service and delivery orders as they happen." },
      { property: "og:title", content: "Track your order — NEØ Guest" },
      { property: "og:description", content: "Follow your room service and delivery orders as they happen." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: TrackOrderPage,
});

const CLOSED = ["delivered", "completed", "cancelled", "returned", "refunded"];

function TrackOrderPage() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { user, loading } = useCustomerSession();
  const profile = useGuestProfile(ws.organization_id, user?.id, ws.branch_id);
  const customerId = profile.data?.["id"] as string | undefined;
  const orders = useMyPublicOrders(ws.organization_id, customerId);
  useGuestScreenView(ws.organization_id, "track-order", Boolean(customerId));

  const live = (orders.data ?? []).filter(
    (o) => !CLOSED.includes(String(o["order_status"])),
  );

  return (
    <GuestScreen hotelSlug={hotelSlug} active="orders">
      <section className="rounded-2xl bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold" style={{ color: brandFallback.secondary }}>
          Track order
        </h1>
        <p className="mt-2 text-sm" style={{ color: brandFallback.steel }}>
          Live progress from the kitchen to your room or your door.
        </p>
      </section>

      {!loading && !user ? (
        <GuestSignInPrompt hotelSlug={hotelSlug} title="Sign in to track an order" description="Live kitchen, dispatch and rider progress is private to your account." />
      ) : orders.isLoading || profile.isLoading ? (
        <GuestSection title="On the way now">
          <GuestCardsSkeleton cards={2} label="Loading your orders" />
        </GuestSection>
      ) : live.length === 0 ? (
        <GuestSection title="Nothing on the way">
          <PublicEmptyState
            title="No order in progress"
            description="When you place an order, its live progress shows here."
          />
        </GuestSection>
      ) : (
        <GuestSection title="On the way now">
          <ul className="space-y-3">
            {live.map((o) => (
              <li key={String(o["id"])} className="rounded-xl border border-black/5 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                      {String(o["order_number"])}
                    </p>
                    <p className="text-xs" style={{ color: brandFallback.steel }}>
                      {statusLabel(o["fulfilment_type"])} · {statusLabel(o["order_status"])}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                      {money(o["grand_total"], String(o["currency"] ?? "KES"))}
                    </p>
                    <Link
                      to="/guest/$hotelSlug/orders/$orderReference"
                      params={{ hotelSlug, orderReference: String(o["order_number"]) }}
                      className="text-xs font-medium"
                      style={{ color: ws.primary_color }}
                    >
                      Follow this order
                    </Link>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </GuestSection>
      )}
    </GuestScreen>
  );
}
