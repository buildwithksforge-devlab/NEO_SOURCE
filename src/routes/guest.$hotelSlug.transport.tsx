import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Car, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { GuestScreen, GuestSection } from "@/components/public/GuestScreen";
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
  const preview = isPreviewMode();
  const { user, loading } = useCustomerSession();
  const profile = useGuestProfile(ws.organization_id, user?.id, ws.branch_id);
  const customerId = profile.data?.["id"] as string | undefined;
  const products = useTransportProducts(ws.organization_id);
  const requests = useMyTransportRequests(ws.organization_id, customerId);
  const request = useRequestTransport(ws.organization_id);
  useGuestScreenView(ws.organization_id, "transport", Boolean(customerId));

  const [productId, setProductId] = useState<string>("");
  const [pickupAt, setPickupAt] = useState("");
  const [pickupPoint, setPickupPoint] = useState("");
  const [destination, setDestination] = useState("");
  const [passengers, setPassengers] = useState(1);
  const [luggage, setLuggage] = useState(0);
  const [travelReference, setTravelReference] = useState("");
  const [notes, setNotes] = useState("");

  async function submit() {
    if (!pickupAt || !pickupPoint.trim() || !destination.trim()) {
      toast.error("Pickup time, pickup point and destination are required");
      return;
    }
    try {
      const result = await request.mutateAsync({
        productId: productId || null,
        pickupAt: new Date(pickupAt).toISOString(),
        pickupPoint: pickupPoint.trim(),
        destination: destination.trim(),
        passengers,
        luggage,
        travelReference: travelReference.trim() || null,
        notes: notes.trim() || null,
      });
      toast.success(`Request ${result.request_number} sent to the concierge`);
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
      <section className="rounded-2xl bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold" style={{ color: brandFallback.secondary }}>
          Transport & transfers
        </h1>
        <p className="mt-2 text-sm" style={{ color: brandFallback.steel }}>
          Airport, station and excursion transfers arranged by {ws.hotel_name}. Prices shown are the property's own —
          nothing is estimated for you.
        </p>
      </section>

      {!loading && !user ? (
        <GuestSignInPrompt hotelSlug={hotelSlug} title="Sign in to request transport" description="Your transfer requests, property quotes and driver updates stay with your account." />
      ) : (
        <>
          <GuestSection title="Available transfers">
            {products.isLoading ? (
              <div className="flex justify-center py-6">
                <Loader2 className="size-5 animate-spin" style={{ color: brandFallback.steel }} />
              </div>
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
                        onClick={() => setProductId(isActive ? "" : id)}
                        className="flex w-full items-center gap-3 rounded-xl border p-3 text-left"
                        style={{ borderColor: isActive ? ws.primary_color : "rgba(0,0,0,0.08)" }}
                      >
                        <span className="flex size-11 items-center justify-center rounded-lg bg-black/5">
                          <Car className="size-5" style={{ color: brandFallback.steel }} aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium" style={{ color: brandFallback.secondary }}>
                            {String(p["name"])}
                          </span>
                          <span className="block truncate text-xs" style={{ color: brandFallback.steel }}>
                            {String(p["description"] ?? "")}
                          </span>
                        </span>
                        <span className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
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

          <GuestSection title="Request a transfer">
            <div className="space-y-3">
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
                disabled={request.isPending || preview}
                className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: ws.primary_color || brandFallback.primary }}
              >
                {request.isPending ? "Sending…" : preview ? "Preview only" : "Send request"}
              </button>
            </div>
          </GuestSection>

          <GuestSection title="My transfers">
            {(requests.data?.length ?? 0) === 0 ? (
              <PublicEmptyState title="No transfers yet" description="Requests you send appear here with live status." />
            ) : (
              <ul className="space-y-2">
                {(requests.data ?? []).map((r) => (
                  <li key={String(r["id"])} className="rounded-xl border border-black/5 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                        {String(r["request_number"])}
                      </span>
                      <span className="text-xs font-medium" style={{ color: ws.primary_color }}>
                        {transportStatusLabels[String(r["status"])] ?? String(r["status"])}
                      </span>
                    </div>
                    <p className="mt-1 text-xs" style={{ color: brandFallback.steel }}>
                      {new Date(String(r["pickup_at"])).toLocaleString()} · {String(r["pickup_point"])} →{" "}
                      {String(r["destination"])}
                    </p>
                    {r["quoted_amount"] != null ? (
                      <p className="mt-1 text-xs font-medium" style={{ color: brandFallback.secondary }}>
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
      <span className="mb-1 block text-xs font-medium" style={{ color: brandFallback.steel }}>
        {label}
      </span>
      {children}
    </label>
  );
}
