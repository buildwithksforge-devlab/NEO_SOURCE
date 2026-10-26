import { createFileRoute, Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  BrandButton,
  PublicAppShell,
  PublicEmptyState,
  useWorkspace,
} from "@/components/public/PublicAppShell";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { brandFallback } from "@/lib/public-apps";
import { useMyOrderPin } from "@/lib/delivery-data";
import { supabase } from "@/integrations/supabase/client";
import { validateMpesaReceiptCode } from "@/lib/delivery-mpesa-reference";
import { STALE_LOCATION_SECONDS, locationAgeSeconds, useDeliveryLive } from "@/lib/delivery-live";
import {
  money,
  statusLabel,
  useDeliveryMpesaCharge,
  usePublicOrderByReference,
} from "@/lib/public-delivery";

export const Route = createFileRoute("/delivery/$hotelSlug/track/$orderReference")({
  component: TrackPage,
});

const DELIVERY_STEPS = [
  { key: "placed", label: "Order received" },
  { key: "confirmed", label: "Confirmed by restaurant" },
  { key: "in-preparation", label: "Being prepared" },
  { key: "rider-assigned", label: "Rider assigned" },
  { key: "out-for-delivery", label: "On the way" },
  { key: "delivered", label: "Delivered" },
];

const PICKUP_STEPS = [
  { key: "placed", label: "Order received" },
  { key: "confirmed", label: "Confirmed by restaurant" },
  { key: "in-preparation", label: "Being prepared" },
  { key: "ready-for-pickup", label: "Ready for collection" },
  { key: "completed", label: "Collected" },
];

function TrackPage() {
  const ws = useWorkspace();
  const { hotelSlug, orderReference } = Route.useParams();
  const order = usePublicOrderByReference(ws.organization_id, orderReference);

  const status = String(order.data?.["order_status"] ?? "");
  const steps = String(order.data?.["fulfilment_type"] ?? "delivery") === "pickup" ? PICKUP_STEPS : DELIVERY_STEPS;
  const activeIndex = steps.findIndex((s) => s.key === status);

  const charge = useDeliveryMpesaCharge();
  const [retryPhone, setRetryPhone] = useState("");
  const [tillReceiptCode, setTillReceiptCode] = useState("");
  const [tillSubmitting, setTillSubmitting] = useState(false);
  const [tillSubmitted, setTillSubmitted] = useState(false);
  const paymentMethod = String(order.data?.["payment_method"] ?? "");
  const paymentStatus = String(order.data?.["payment_status"] ?? "");
  // An M-Pesa request that failed, was declined or never completed leaves the
  // bill outstanding â€” the guest must be able to send the request again.
  const canRetryPayment =
    paymentMethod === "mpesa" &&
    !["paid", "refunded", "voided"].includes(paymentStatus) &&
    !["cancelled", "rejected", "delivered", "completed"].includes(status);

  return (
    <PublicAppShell homeTo={{ to: "/delivery/$hotelSlug", params: { hotelSlug } }}>
      <h1 className="text-2xl font-semibold" style={{ color: brandFallback.secondary }}>
        Order {orderReference}
      </h1>

      {order.isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin" style={{ color: brandFallback.steel }} />
        </div>
      ) : !order.data ? (
        <div className="mt-4">
          <PublicEmptyState
            title="Order not found"
            description="We could not find this order reference. Sign in with the account used to order, or check the reference."
            action={
              <Link to="/delivery/$hotelSlug/orders" params={{ hotelSlug }}>
                <BrandButton>My orders</BrandButton>
              </Link>
            }
          />
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <section className="rounded-2xl bg-white p-5 shadow-sm">
            <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
              {statusLabel(status)}
            </p>
            <p className="mt-1 text-xs" style={{ color: brandFallback.steel }}>
              Placed {new Date(String(order.data["created_at"])).toLocaleString()}
              {order.data["estimated_delivery_at"]
                ? ` Â· Expected ${new Date(String(order.data["estimated_delivery_at"])).toLocaleTimeString()}`
                : ""}
            </p>

            <ol className="mt-5 space-y-3">
              {steps.map((step, index) => {
                const done = activeIndex >= 0 && index <= activeIndex;
                return (
                  <li key={step.key} className="flex items-center gap-3">
                    <span
                      className="size-2.5 rounded-full"
                      style={{ background: done ? ws.primary_color : brandFallback.mist }}
                    />
                    <span
                      className="text-sm"
                      style={{ color: done ? brandFallback.secondary : brandFallback.steel }}
                    >
                      {step.label}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>

          <LiveDeliveryCard organizationId={ws.organization_id} reference={orderReference} />

          <DeliveryPinCard orderId={String(order.data["id"] ?? "")} />

          <section className="rounded-2xl bg-white p-5 shadow-sm text-sm">
            <div className="flex items-center justify-between">
              <span style={{ color: brandFallback.steel }}>Total</span>
              <span className="font-semibold" style={{ color: brandFallback.secondary }}>
                {money(order.data["grand_total"], String(order.data["currency"] ?? "KES"))}
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span style={{ color: brandFallback.steel }}>Payment</span>
              <span style={{ color: brandFallback.secondary }}>
                {String(order.data["payment_method"] ?? "â€”")} Â· {String(order.data["payment_status"] ?? "â€”")}
              </span>
            </div>

            {canRetryPayment ? (
              <div className="mt-4 border-t border-black/5 pt-4">
                <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                  {paymentStatus === "failed"
                    ? "Payment did not go through"
                    : "Waiting for your payment"}
                </p>
                <p className="mt-1 text-xs" style={{ color: brandFallback.steel }}>
                  Enter your M-Pesa number and we will send the request again. If it keeps failing,
                  call the restaurant on your order confirmation to arrange payment.
                </p>
                <Label htmlFor="retry-phone" className="mt-3 block">
                  M-Pesa number
                </Label>
                <Input
                  id="retry-phone"
                  inputMode="tel"
                  placeholder="07xx xxx xxx"
                  className="mt-1"
                  value={retryPhone}
                  onChange={(e) => setRetryPhone(e.target.value)}
                />
                <BrandButton
                  className="mt-3 w-full"
                  disabled={charge.isPending || retryPhone.replace(/\D/g, "").length < 9}
                  onClick={async () => {
                    try {
                      const result = await charge.mutateAsync({
                        orderId: String(order.data?.["id"] ?? ""),
                        msisdn: retryPhone,
                      });
                      if (result.ok) toast.success(result.detail);
                      else toast.error(result.detail);
                    } catch {
                      toast.error("We could not send the payment request. Please try again.");
                    }
                    void order.refetch();
                  }}
                >
                  {charge.isPending ? "Sending payment requestâ€¦" : "Send payment request"}
                </BrandButton>
              </div>
            ) : null}

            {paymentMethod === "mpesa" &&
             !["paid", "settled", "completed", "refunded", "voided"].includes(paymentStatus) &&
             !["cancelled", "rejected", "failed"].includes(status) ? (
              <div className="mt-5 border-t border-black/10 pt-4">
                <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                  Already paid to our M-PESA Till?
                </p>

                <p className="mt-2 text-xs" style={{ color: brandFallback.steel }}>
                  If you paid the hotel's official Till directly, submit the M-PESA
                  transaction code for verification. Submitting a code does not
                  confirm payment.
                </p>

                <Label htmlFor="till-receipt" className="mt-3 block">
                  M-PESA transaction code
                </Label>

                <Input
                  id="till-receipt"
                  className="mt-1"
                  value={tillReceiptCode}
                  onChange={(e) => setTillReceiptCode(e.target.value)}
                  placeholder="Transaction code"
                  autoComplete="off"
                  disabled={tillSubmitting || tillSubmitted}
                />

                <BrandButton
                  className="mt-3 w-full"
                  disabled={tillSubmitting || tillSubmitted || !tillReceiptCode.trim()}
                  onClick={async () => {
                    try {
                      const code = validateMpesaReceiptCode(tillReceiptCode);
                      setTillSubmitting(true);

                      const client = supabase as unknown as {
                        rpc: (
                          name: string,
                          args: Record<string, unknown>
                        ) => Promise<{
                          data: {
                            ok?: boolean;
                            status?: string;
                            detail?: string;
                            reason?: string;
                          } | null;
                          error: { message: string } | null;
                        }>;
                      };

                      const { data, error } = await client.rpc(
                        "neo_delivery_mpesa_till_claim_submit",
                        {
                          _order: String(order.data?.["id"] ?? ""),
                          _receipt: code,
                        }
                      );

                      if (error) throw new Error(error.message);
                      if (!data?.ok) {
                        throw new Error(
                          data?.detail ?? data?.reason ?? "Reference not accepted."
                        );
                      }

                      setTillSubmitted(true);
                      toast.success("Reference submitted for Finance verification.");
                    } catch (error) {
                      toast.error(
                        error instanceof Error
                          ? error.message
                          : "Could not submit M-PESA reference."
                      );
                    } finally {
                      setTillSubmitting(false);
                    }
                  }}
                >
                  {tillSubmitting
                    ? "Submitting reference..."
                    : tillSubmitted
                      ? "Awaiting Finance verification"
                      : "Submit transaction code"}
                </BrandButton>

                <p className="mt-2 text-xs" style={{ color: brandFallback.steel }}>
                  Keep your M-PESA confirmation message. The order remains
                  unpaid until the hotel verifies the transaction.
                </p>
              </div>
            ) : null}
          </section>
        </div>
      )}
    </PublicAppShell>
  );
}

/**
 * Where the order is going, who is bringing it and â€” while the run is live and
 * the property allows it â€” the courier's last known position. There is no map
 * provider here: a position is shown as a place and an age, with a link the
 * guest's own phone can open.
 */
function LiveDeliveryCard({ organizationId, reference }: { organizationId: string; reference: string }) {
  const live = useDeliveryLive(organizationId, reference);
  const data = live.data;
  if (!data) return null;

  const destination = data.destination;
  const courier = data.courier;
  const location = data.courier_location;
  const age = locationAgeSeconds(location);
  const stale = age !== null && age > STALE_LOCATION_SECONDS;

  if (!destination && !courier && !location) return null;

  return (
    <section className="rounded-2xl bg-white p-5 shadow-sm">
      {destination ? (
        <>
          <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
            Delivering to
          </p>
          <p className="mt-1 text-sm" style={{ color: brandFallback.secondary }}>
            {destination.address_line || destination.label || "Your saved address"}
            {destination.city ? `, ${destination.city}` : ""}
          </p>
          {destination.landmark ? (
            <p className="mt-1 text-xs" style={{ color: brandFallback.steel }}>
              Landmark: {destination.landmark}
            </p>
          ) : null}
          <p className="mt-2 text-xs" style={{ color: brandFallback.steel }}>
            {destination.instructions
              ? `Your instructions: ${destination.instructions}`
              : "No delivery instructions were added to this order."}
          </p>
        </>
      ) : null}

      {courier ? (
        <div className="mt-4 border-t border-black/5 pt-4">
          <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
            {courier.display_name} is bringing your order
          </p>
          <p className="mt-1 text-xs" style={{ color: brandFallback.steel }}>
            {[courier.vehicle_type, courier.vehicle_registration].filter(Boolean).join(" Â· ") ||
              "Vehicle details not recorded"}
          </p>
          {courier.phone ? (
            <a
              href={`tel:${courier.phone}`}
              className="mt-2 inline-block text-sm font-medium"
              style={{ color: brandFallback.primary }}
            >
              Call {courier.display_name}
            </a>
          ) : null}
        </div>
      ) : null}

      {data.live ? (
        <div className="mt-4 border-t border-black/5 pt-4">
          {!data.tracking_enabled ? (
            <p className="text-xs" style={{ color: brandFallback.steel }}>
              This property does not share rider locations. You will still see each step above as
              your order moves.
            </p>
          ) : location ? (
            <>
              <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                {stale ? "Last known position" : "Rider position"}
              </p>
              <p className="mt-1 text-xs" style={{ color: brandFallback.steel }}>
                {age !== null && age < 60
                  ? "Updated moments ago"
                  : `Updated ${Math.round((age ?? 0) / 60)} min ago`}
                {stale ? " â€” the signal has dropped, so this may have moved." : ""}
              </p>
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${location.latitude},${location.longitude}`}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-block text-sm font-medium"
                style={{ color: brandFallback.primary }}
              >
                Open position in maps
              </a>
            </>
          ) : (
            <p className="text-xs" style={{ color: brandFallback.steel }}>
              Waiting for the rider's first position update.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The collection PIN, shown only to the customer who placed this order.
 * Staff and riders cannot read it anywhere â€” the rider types it in and the
 * database checks it against a stored fingerprint.
 */
function DeliveryPinCard({ orderId }: { orderId: string }) {
  const pin = useMyOrderPin(orderId || undefined);
  const data = pin.data;
  if (!data?.ok) return null;

  const used = Boolean(data.consumed_at);
  const expired = Boolean(data.expires_at && new Date(data.expires_at).getTime() < Date.now());

  return (
    <section className="rounded-2xl bg-white p-5 shadow-sm">
      <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
        Your collection PIN
      </p>
      {used ? (
        <p className="mt-2 text-sm" style={{ color: brandFallback.steel }}>
          This order was handed over, so the PIN is no longer usable.
        </p>
      ) : expired ? (
        <p className="mt-2 text-sm" style={{ color: brandFallback.steel }}>
          This PIN has expired. Call the restaurant and they will send you a new one.
        </p>
      ) : (
        <>
          <p className="mt-2 text-3xl font-semibold tracking-[0.35em]" style={{ color: brandFallback.secondary }}>
            {data.pin ?? "â€”â€”â€”â€”â€”â€”"}
          </p>
          <p className="mt-2 text-xs" style={{ color: brandFallback.steel }}>
            Give this to the rider when your order arrives. Do not share it with anyone else.
          </p>
          {data.locked ? (
            <p className="mt-2 text-xs" style={{ color: brandFallback.steel }}>
              Too many wrong entries were made at the door. Call the restaurant to continue.
            </p>
          ) : null}
          {data.sent_at ? (
            <p className="mt-1 text-xs" style={{ color: brandFallback.steel }}>
              Also sent to you by {data.channel === "email" ? "email" : "text message"}.
            </p>
          ) : data.send_status === "no_contact" ? (
            <p className="mt-1 text-xs" style={{ color: brandFallback.steel }}>
              We had no phone number or email on file, so it is only shown here.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

