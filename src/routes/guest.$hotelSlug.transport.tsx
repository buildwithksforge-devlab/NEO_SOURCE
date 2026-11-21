import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Car, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { GuestPageIntro, GuestScreen, GuestSection } from "@/components/public/GuestScreen";
import { PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import { money } from "@/lib/public-delivery";
import { useGuestProfile, useGuestScreenView } from "@/lib/guest-app";
import { isPreviewMode } from "@/lib/preview-mode";
import {
  transportStatusLabels,
  useMyTransportRequests,
  useRequestTransport,
  useTransportProducts,
} from "@/lib/guest-ordering";

export const Route = createFileRoute("/guest/$hotelSlug/transport")({
  validateSearch: (search): { product?: string } =>
    typeof search["product"] === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(search["product"])
      ? { product: search["product"].toLowerCase() } : {},
  head: () => ({
    meta: [
      { title: "Transport & Transfers — NEØ Guest" },
      { name: "description", content: "Request an airport transfer, station pickup or excursion from the property." },
      { property: "og:title", content: "Transport & Transfers — NEØ Guest" },
      { property: "og:description", content: "Request an airport transfer, station pickup or excursion from the property." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      // Personal to one guest: never a search result.
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: TransportPage,
});

function TransportPage() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { product } = Route.useSearch();
  const preview = isPreviewMode();
  const { user, loading } = useCustomerSession();
  const profile = useGuestProfile(ws.organization_id, user?.id, ws.branch_id);
  const customerId = profile.data?.["id"] as string | undefined;
  const products = useTransportProducts(ws.organization_id, ws.branch_id, Boolean(customerId));
  const requests = useMyTransportRequests(ws.organization_id, ws.branch_id, customerId);
  const request = useRequestTransport(ws.organization_id, ws.branch_id);
  useGuestScreenView(ws.organization_id, "transport", Boolean(customerId));

  const [selectedProductId, setProductId] = useState<string | null>(null);
  const productId = selectedProductId ?? product ?? "";
  const selectedProduct = products.data?.find((entry) => entry["id"] === productId);
  const productUnavailable = Boolean(productId && !selectedProduct);
  const maxPassengers = selectedProduct?.["max_passengers"] ? Number(selectedProduct["max_passengers"]) : undefined;
  const [pickupAt, setPickupAt] = useState("");
  const [pickupPoint, setPickupPoint] = useState("");
  const [destination, setDestination] = useState("");
  const [passengers, setPassengers] = useState(1);
  const [luggage, setLuggage] = useState(0);
  const [travelReference, setTravelReference] = useState("");
  const [notes, setNotes] = useState("");
  const [submittedReference, setSubmittedReference] = useState<string | null>(null);

  async function submit() {
    if (request.isPending || productUnavailable || preview) return;
    const pickup = new Date(pickupAt);
    if (!pickupAt || !pickupPoint.trim() || !destination.trim()) {
      toast.error("Pickup time, pickup point and destination are required");
      return;
    }
    if (!Number.isFinite(pickup.getTime()) || pickup.getTime() <= Date.now()) {
      toast.error("Choose a pickup time in the future");
      return;
    }
    if (!Number.isInteger(passengers) || passengers < 1 || (maxPassengers && passengers > maxPassengers)) {
      toast.error(maxPassengers ? `Enter between 1 and ${maxPassengers} passengers` : "Enter a whole number of passengers");
      return;
    }
    if (!Number.isInteger(luggage) || luggage < 0) {
      toast.error("Enter a whole number of bags");
      return;
    }
    try {
      const result = await request.mutateAsync({
        productId: productId || null,
        pickupAt: pickup.toISOString(),
        pickupPoint: pickupPoint.trim(),
        destination: destination.trim(),
        passengers,
        luggage,
        travelReference: travelReference.trim() || null,
        notes: notes.trim() || null,
      });
      toast.success(`Request ${result.request_number} sent to the concierge`);
      setSubmittedReference(result.request_number);
      setPickupAt("");
      setPickupPoint("");
      setDestination("");
      setTravelReference("");
      setNotes("");
    } catch {
      /* surfaced by the mutation */
    }
  }

  return (
    <GuestScreen hotelSlug={hotelSlug} active="trips">
      <GuestPageIntro title="Transfers" description={`Arrange a pickup or a trip with ${ws.hotel_name}.`}>
        <Link to="/guest/$hotelSlug/explore" params={{ hotelSlug }} search={{ section: "services" }} className="neo-guest-outline-action">Hotel services</Link>
        <Link to="/guest/$hotelSlug/stay" params={{ hotelSlug }} className="neo-guest-outline-action">My stay</Link>
        {customerId && productId ? <a href="#transfer-request" className="neo-guest-outline-action">Continue to request</a> : null}
        {customerId ? <a href="#transfer-history" className="neo-guest-outline-action">My transfer requests</a> : null}
      </GuestPageIntro>

      {submittedReference ? (
        <div role="status" className="neo-guest-task-panel">
          <p className="font-semibold">Transfer requested · {submittedReference}</p>
          <p>The concierge will confirm availability and pricing.</p>
          <a href="#transfer-history" className="neo-guest-outline-action">View request status</a>
        </div>
      ) : null}

      {loading || profile.isLoading ? (
        <p role="status" className="mt-4 text-sm text-[var(--guest-muted)]">Loading transfer options…</p>
      ) : !user ? (
        <GuestSignInPrompt hotelSlug={hotelSlug} title="Sign in to request transport" description="Your transfer requests, property quotes and driver updates stay with your account." />
      ) : profile.isError || !customerId ? (
        <PublicEmptyState title="Your guest profile couldn’t load" description="Reload your profile to request transport."
          action={<button type="button" className="neo-guest-secondary" onClick={() => void profile.refetch()}>Reload profile</button>} />
      ) : (
        <>
          <GuestSection title="Available transfers">
            {products.isLoading ? (
              <div className="flex justify-center py-6">
                <Loader2 className="size-5 animate-spin" style={{ color: "var(--guest-muted, #52627A)" }} />
              </div>
            ) : products.isError ? (
              <PublicEmptyState title="Transfers couldn’t load" description={`Try again to see transfers for ${ws.hotel_name}.`}
                action={<button className="neo-guest-secondary" onClick={() => void products.refetch()}>Retry transfers</button>} />
            ) : (products.data?.length ?? 0) === 0 ? (
              <PublicEmptyState
                title="No published transfers"
                description="You can still request a custom transfer below and the concierge will quote you."
              />
            ) : (
              <ul className="space-y-2">
                {(products.data ?? []).map((p) => {
                  const id = String(p["id"]);
                  const isActive = id === productId;
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        aria-pressed={isActive}
                        onClick={() => setProductId(isActive ? "" : id)}
                        className="flex w-full items-center gap-3 rounded-xl border p-3 text-left"
                        style={{ borderColor: isActive ? ws.primary_color : "rgba(0,0,0,0.08)" }}
                      >
                        <span className="flex size-11 items-center justify-center rounded-lg bg-black/5">
                          <Car className="size-5" style={{ color: "var(--guest-muted, #52627A)" }} aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium" style={{ color: "var(--guest-text, #07142D)" }}>
                            {String(p["name"])}
                          </span>
                          <span className="block truncate text-xs" style={{ color: "var(--guest-muted, #52627A)" }}>
                            {String(p["description"] ?? "")}
                          </span>
                        </span>
                        <span className="text-sm font-semibold" style={{ color: "var(--guest-text, #07142D)" }}>
                          {p["base_price"] == null
                            ? "On request"
                            : money(p["base_price"], String(p["currency"] ?? "KES"))}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </GuestSection>

          <GuestSection id="transfer-request" title="Request a transfer" surface>
            <div className="space-y-3">
              {selectedProduct ? (
                <p className="text-sm font-medium">Transfer selected · {String(selectedProduct["name"])}</p>
              ) : productUnavailable && !products.isLoading ? (
                <p role="status" className="text-sm">The selected transfer is unavailable. Choose another transfer or request a custom trip.</p>
              ) : null}
              {productId ? <button type="button" onClick={() => setProductId("")} className="neo-guest-outline-action">Request a custom trip instead</button> : null}
              <Field label="Pickup time">
                <input
                  type="datetime-local"
                  value={pickupAt}
                  onChange={(e) => setPickupAt(e.target.value)}
                  className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
                />
              </Field>
              <Field label="Pickup point">
                <input
                  value={pickupPoint}
                  onChange={(e) => setPickupPoint(e.target.value)}
                  placeholder="Hotel lobby, JKIA Terminal 1A…"
                  className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
                />
              </Field>
              <Field label="Destination">
                <input
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Passengers">
                  <input
                    type="number"
                    min={1}
                    max={maxPassengers}
                    value={passengers}
                    onChange={(e) => setPassengers(Number(e.target.value))}
                    className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
                  />
                </Field>
                <Field label="Luggage">
                  <input
                    type="number"
                    min={0}
                    value={luggage}
                    onChange={(e) => setLuggage(Number(e.target.value))}
                    className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
                  />
                </Field>
              </div>
              <Field label="Flight / train reference (optional)">
                <input
                  value={travelReference}
                  onChange={(e) => setTravelReference(e.target.value)}
                  className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
                />
              </Field>
              <Field label="Notes (optional)">
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-black/10 px-3 py-2 text-sm"
                />
              </Field>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={request.isPending || preview || productUnavailable}
                className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: ws.primary_color || brandFallback.primary, color: "var(--pa-on-primary)" }}
              >
                {request.isPending ? "Sending…" : preview ? "Preview only" : "Send request"}
              </button>
            </div>
          </GuestSection>

          <GuestSection id="transfer-history" title="My transfers">
            {requests.isLoading ? (
              <p className="text-sm text-[var(--guest-muted)]" role="status">Loading your transfers…</p>
            ) : requests.isError ? (
              <PublicEmptyState
                title="Your transfer history couldn’t load"
                description="Try again to see requests at this property."
                action={<button type="button" className="neo-guest-secondary" onClick={() => void requests.refetch()}>Retry transfer history</button>}
              />
            ) : (requests.data?.length ?? 0) === 0 ? (
              <PublicEmptyState title="No transfers yet" description="Requests you send appear here with live status." />
            ) : (
              <ul className="space-y-2">
                {(requests.data ?? []).map((r) => (
                  <li key={String(r["id"])} className="rounded-xl border border-black/5 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold" style={{ color: "var(--guest-text, #07142D)" }}>
                        {String(r["request_number"])}
                      </span>
                      <span className="text-xs font-medium" style={{ color: "var(--pa-accent-ink)" }}>
                        {transportStatusLabels[String(r["status"])] ?? String(r["status"])}
                      </span>
                    </div>
                    <p className="mt-1 text-xs" style={{ color: "var(--guest-muted, #52627A)" }}>
                      {new Date(String(r["pickup_at"])).toLocaleString()} · {String(r["pickup_point"])} →{" "}
                      {String(r["destination"])}
                    </p>
                    {r["quoted_amount"] != null ? (
                      <p className="mt-1 text-xs font-medium" style={{ color: "var(--guest-text, #07142D)" }}>
                        Quoted {money(r["quoted_amount"], String(r["currency"] ?? "KES"))}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </GuestSection>
        </>
      )}
    </GuestScreen>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium" style={{ color: "var(--guest-muted, #52627A)" }}>
        {label}
      </span>
      {children}
    </label>
  );
}
