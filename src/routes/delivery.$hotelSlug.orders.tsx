import { createFileRoute, Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import {
  BrandButton,
  PublicAppShell,
  PublicEmptyState,
  useWorkspace,
} from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import { money, statusLabel, useMyPublicCustomer, useMyPublicOrders } from "@/lib/public-delivery";

export const Route = createFileRoute("/delivery/$hotelSlug/orders")({
  component: OrdersPage,
});

function OrdersPage() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { user, loading } = useCustomerSession();
  const customer = useMyPublicCustomer(ws.organization_id, user?.id);
  const orders = useMyPublicOrders(ws.organization_id, customer.data?.["id"] as string | undefined);

  return (
    <PublicAppShell homeTo={{ to: "/delivery/$hotelSlug", params: { hotelSlug } }}>
      <h1 className="text-2xl font-semibold" style={{ color: brandFallback.secondary }}>
        My orders
      </h1>

      {!loading && !user ? (
        <GuestSignInPrompt hotelSlug={hotelSlug} title="Sign in to see your orders" description="Order history, payments and delivery progress are private to your account." />
      ) : orders.isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin" style={{ color: brandFallback.steel }} />
        </div>
      ) : (orders.data?.length ?? 0) === 0 ? (
        <div className="mt-4">
          <PublicEmptyState
            title="No orders yet"
            description="Your past and current orders will appear here once you place your first one."
            action={
              <Link to="/delivery/$hotelSlug" params={{ hotelSlug }}>
                <BrandButton>Browse the menu</BrandButton>
              </Link>
            }
          />
        </div>
      ) : (
        <ul className="mt-4 space-y-3">
          {(orders.data ?? []).map((order) => (
            <li key={String(order["id"])} className="rounded-2xl bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                    {String(order["order_number"])}
                  </p>
                  <p className="text-xs" style={{ color: brandFallback.steel }}>
                    {new Date(String(order["created_at"])).toLocaleString()} ·{" "}
                    {statusLabel(order["order_status"])}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                    {money(order["grand_total"], String(order["currency"] ?? "KES"))}
                  </span>
                  <Link
                    to="/delivery/$hotelSlug/track/$orderReference"
                    params={{ hotelSlug, orderReference: String(order["order_number"]) }}
                  >
                    <BrandButton variant="outline">Track</BrandButton>
                  </Link>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </PublicAppShell>
  );
}
