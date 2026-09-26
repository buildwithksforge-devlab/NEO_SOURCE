import { createFileRoute, Link } from "@tanstack/react-router";
import { Bike, Loader2 } from "lucide-react";
import { GuestScreen, GuestSection } from "@/components/public/GuestScreen";
import { PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import { money, statusLabel } from "@/lib/public-delivery";
import { useGuestScreenView } from "@/lib/guest-app";
import { useCancelGuestOrder, useGuestOrderTracking } from "@/lib/guest-ordering";

/** One money row in the guest's receipt. */
function Amount({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt style={{ color: brandFallback.steel }}>{label}</dt>
      <dd style={{ color: brandFallback.secondary }}>{value}</dd>
    </div>
  );
}

export const Route = createFileRoute("/guest/$hotelSlug/orders_/$orderReference")({
  head: () => ({
    meta: [
      { title: "Order Tracking — NEØ Guest" },
      { name: "description", content: "Live kitchen and delivery status for your order." },
      { property: "og:title", content: "Order Tracking — NEØ Guest" },
      { property: "og:description", content: "Live kitchen and delivery status for your order." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: TrackingPage,
});

function TrackingPage() {
  const ws = useWorkspace();
  const { hotelSlug, orderReference } = Route.useParams();
  const { user, loading } = useCustomerSession();
  const tracking = useGuestOrderTracking(ws.organization_id, orderReference);
  const cancel = useCancelGuestOrder(ws.organization_id, orderReference);
  useGuestScreenView(ws.organization_id, "order-tracking", Boolean(user));

  const order = tracking.data;
  const currency = order?.currency ?? "KES";

  return (
    <GuestScreen hotelSlug={hotelSlug} active="orders">
      <section className="neo-rider-card p-6">
        <h1 className="text-2xl font-semibold" style={{ color: brandFallback.secondary }}>
          Order {orderReference}
        </h1>
        <p className="mt-2 text-sm" style={{ color: brandFallback.steel }}>
          Live status from {ws.hotel_name}'s kitchen and dispatch.
        </p>
      </section>

      {!loading && !user ? (
        <GuestSignInPrompt hotelSlug={hotelSlug} title="Sign in to track this order" description="Order details and live fulfilment progress are private to the account that placed it." />
      ) : tracking.isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin" style={{ color: brandFallback.steel }} />
        </div>
      ) : !order ? (
        <GuestSection title="Order not found">
          <PublicEmptyState
            title="We can't show this order"
            description="It either doesn't exist or it belongs to another account."
          />
        </GuestSection>
      ) : (
        <>
          <GuestSection title="Status">
            <p className="text-lg font-semibold" style={{ color: ws.primary_color }}>
              {statusLabel(order.order_status)}
            </p>
            <p className="mt-1 text-sm" style={{ color: brandFallback.steel }}>
              {statusLabel(order.fulfilment_type)} · {statusLabel(order.payment_status)} ·{" "}
              {money(order.grand_total, currency)}
            </p>
            {order.estimated_delivery_at ? (
              <p className="mt-1 text-xs" style={{ color: brandFallback.steel }}>
                Estimated {new Date(order.estimated_delivery_at).toLocaleTimeString()}
              </p>
            ) : null}
            {order.kitchen_status ? (
              <p className="mt-1 text-xs" style={{ color: brandFallback.steel }}>
                Kitchen: {statusLabel(order.kitchen_status)}
              </p>
            ) : null}
          </GuestSection>

          {order.courier ? (
            <GuestSection title="Your rider">
              <div className="flex items-center gap-3">
                <span className="flex size-11 items-center justify-center rounded-full bg-black/5">
                  <Bike className="size-5" style={{ color: brandFallback.steel }} aria-hidden />
                </span>
                <span>
                  <span className="block text-sm font-medium" style={{ color: brandFallback.secondary }}>
                    {order.courier.display_name}
                  </span>
                  <span className="block text-xs" style={{ color: brandFallback.steel }}>
                    {order.courier.vehicle_type ?? "Rider"} · {statusLabel(order.dispatch_status)}
                  </span>
                </span>
              </div>
              <p className="mt-3 text-xs" style={{ color: brandFallback.steel }}>
                For your rider's safety and privacy, contact details stay with the property — call the front desk if you
                need to reach them.
              </p>
            </GuestSection>
          ) : null}

          <GuestSection title="Items">
            <ul className="divide-y divide-black/5">
              {order.items.map((item, index) => (
                <li key={`${item.name}-${index}`} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="text-sm" style={{ color: brandFallback.secondary }}>
                    {item.quantity} × {item.name}
                  </span>
                  <span className="text-sm font-medium" style={{ color: brandFallback.secondary }}>
                    {money(item.line_total, currency)}
                  </span>
                </li>
              ))}
            </ul>
          </GuestSection>

          <GuestSection
            title={order.receipt_number ? "Receipt" : "What you pay"}
            description={
              order.receipt_number
                ? `Receipt ${order.receipt_number}${order.paid_at ? ` · ${new Date(order.paid_at).toLocaleString()}` : ""}`
                : "The property's own figures for this order."
            }
          >
            <dl className="space-y-1.5 text-sm">
              <Amount label="Items" value={money(order.subtotal, currency)} />
              <Amount label="Tax" value={money(order.tax_total, currency)} />
              {order.service_charge ? (
                <Amount label="Service charge" value={money(order.service_charge, currency)} />
              ) : null}
              {order.discount_total ? (
                <Amount label="Discount" value={`- ${money(order.discount_total, currency)}`} />
              ) : null}
              {order.delivery_fee ? (
                <Amount label="Delivery" value={money(order.delivery_fee, currency)} />
              ) : null}
              <div
                className="flex items-center justify-between border-t border-black/5 pt-2 text-base font-semibold"
                style={{ color: brandFallback.secondary }}
              >
                <span>Total</span>
                <span>{money(order.grand_total, currency)}</span>
              </div>
            </dl>
            <p className="mt-2 text-xs" style={{ color: brandFallback.steel }}>
              {statusLabel(order.payment_status)}
              {order.payment_method ? ` · ${statusLabel(order.payment_method)}` : ""}
            </p>
          </GuestSection>

          {order.can_cancel ? (
            <GuestSection
              title="Need to cancel?"
              description="You can cancel while the kitchen has not started your order."
            >
              <button
                type="button"
                onClick={() => {
                  if (confirm("Cancel this order?")) cancel.mutate({});
                }}
                disabled={cancel.isPending}
                className="inline-flex min-h-11 items-center gap-2 rounded-full border px-5 text-sm font-semibold disabled:opacity-60"
                style={{ borderColor: "rgba(0,0,0,0.12)", color: brandFallback.secondary }}
              >
                {cancel.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                Cancel this order
              </button>
            </GuestSection>
          ) : order.cancelled_at ? null : (
            <GuestSection title="Need to change something?">
              <p className="text-sm" style={{ color: brandFallback.steel }}>
                Your order is already with the property, so please call {ws.hotel_name} to change or
                cancel it.
              </p>
            </GuestSection>
          )}

          <GuestSection title="Progress">
            <ol className="space-y-3">
              {order.timeline.map((event, index) => (
                <li key={`${event.status}-${index}`} className="flex items-start gap-3">
                  <span
                    className="mt-1 size-2 rounded-full"
                    style={{ background: ws.primary_color || brandFallback.primary }}
                    aria-hidden
                  />
                  <span>
                    <span className="block text-sm" style={{ color: brandFallback.secondary }}>
                      {statusLabel(event.status)}
                    </span>
                    <span className="block text-xs" style={{ color: brandFallback.steel }}>
                      {new Date(event.at).toLocaleString()}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </GuestSection>
        </>
      )}

      <div className="mt-4 px-1 text-center text-xs" style={{ color: brandFallback.steel }}>
        <Link to="/guest/$hotelSlug/orders" params={{ hotelSlug }} className="underline">
          Back to my orders
        </Link>
      </div>
    </GuestScreen>
  );
}
