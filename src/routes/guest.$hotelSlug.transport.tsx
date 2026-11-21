import { useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Car, Check, Loader2, Users } from "lucide-react";
import { GuestPageIntro, GuestScreen, GuestSection } from "@/components/public/GuestScreen";
import { PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
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
  const navigate = Route.useNavigate();
  const preview = isPreviewMode();
  const { user, loading } = useCustomerSession();
  const profile = useGuestProfile(ws.organization_id, user?.id, ws.branch_id);
  const customerId = profile.data?.["id"] as string | undefined;
  const products = useTransportProducts(ws.organization_id, ws.branch_id, Boolean(customerId));
  const requests = useMyTransportRequests(ws.organization_id, ws.branch_id, customerId);
  const request = useRequestTransport(ws.organization_id, ws.branch_id);
  useGuestScreenView(ws.organization_id, "transport", Boolean(customerId));

  const productId = product ?? "";
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
  const [formError, setFormError] = useState<string | null>(null);
  const submitting = useRef(false);

  function chooseProduct(id: string) {
    if (submitting.current) return;
    setFormError(null);
    setSubmittedReference(null);
    void navigate({ search: id ? { product: id } : {}, hash: "transfer-request", resetScroll: false });
  }

  async function submit() {
    if (submitting.current || request.isPending || productUnavailable || preview || !customerId) return;
    setFormError(null);
    setSubmittedReference(null);
    const pickup = new Date(pickupAt);
    if (!pickupAt || !pickupPoint.trim() || !destination.trim()) {
      setFormError("Enter a pickup time, pickup point and destination.");
      return;
    }
    if (!Number.isFinite(pickup.getTime()) || pickup.getTime() <= Date.now()) {
      setFormError("Choose a pickup time in the future.");
      return;
    }
    if (!Number.isInteger(passengers) || passengers < 1 || (maxPassengers && passengers > maxPassengers)) {
      setFormError(maxPassengers ? `Enter between 1 and ${maxPassengers} passengers.` : "Enter a whole number of passengers.");
      return;
    }
    if (!Number.isInteger(luggage) || luggage < 0) {
      setFormError("Enter a whole number of bags.");
      return;
    }
    submitting.current = true;
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
      setSubmittedReference(result.request_number);
      setPickupAt("");
      setPickupPoint("");
      setDestination("");
      setTravelReference("");
      setNotes("");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "The request could not be saved. Try again.");
    } finally {
      submitting.current = false;
    }
  }

  return (
    <GuestScreen hotelSlug={hotelSlug} active="trips">
      <GuestPageIntro title="Transfers" description={`Arrange a pickup or a trip with ${ws.hotel_name}.`}>
        <Link to="/guest/$hotelSlug/explore" params={{ hotelSlug }} search={{ section: "services" }} className="neo-guest-outline-action">Hotel services</Link>
        {customerId ? <a href="#transfer-request" className="neo-guest-secondary neo-guest-transfer-primary">Request a transfer</a> : null}
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
              <ul className="neo-guest-transfer-options">
                {(products.data ?? []).map((p) => {
                  const id = String(p["id"]);
                  const isActive = id === productId;
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        aria-pressed={isActive}
                        disabled={request.isPending}
                        onClick={() => chooseProduct(id)}
                        className="neo-guest-transfer-option"
                      >
                        <span className="neo-guest-transfer-option-icon">
                          {isActive ? <Check className="size-5" aria-hidden /> : <Car className="size-5" aria-hidden />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium" style={{ color: "var(--guest-text, #07142D)" }}>
                            {String(p["name"])}
                          </span>
                          <span className="block text-xs text-[var(--guest-muted)]">
                            {String(p["description"] ?? "")}
                          </span>
                          {Number(p["max_passengers"]) > 0 ? <span className="mt-1 flex items-center gap-1 text-xs text-[var(--guest-muted)]"><Users className="size-4" aria-hidden />Up to {Number(p["max_passengers"])}</span> : null}
                        </span>
                        <span className="text-right text-sm font-semibold" style={{ color: "var(--guest-text, #07142D)" }}>
                          {p["base_price"] == null
                            ? "On request"
                            : money(p["base_price"], String(p["currency"] ?? ws.currency ?? "KES"))}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </GuestSection>

          <GuestSection id="transfer-request" title="Request a transfer" surface>
            <form aria-busy={request.isPending} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <fieldset disabled={request.isPending} className="neo-guest-transfer-form">
              {selectedProduct ? (
                <div className="neo-guest-transfer-selection"><Car className="size-5 shrink-0" aria-hidden /><div><strong>{String(selectedProduct["name"])}</strong><p>{selectedProduct["base_price"] == null ? "Price on request" : `Published price ${money(selectedProduct["base_price"], String(selectedProduct["currency"] ?? ws.currency ?? "KES"))}`}</p></div></div>
              ) : productUnavailable && !products.isLoading ? (
                <p role="status" className="text-sm">The selected transfer is unavailable. Choose another transfer or request a custom trip.</p>
              ) : null}
              {productId ? <button type="button" disabled={request.isPending} onClick={() => chooseProduct("")} className="neo-guest-outline-action justify-self-start">Request a custom trip instead</button> : null}
              <Field label="Pickup time (your device’s time zone)">
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
              {formError ? <p role="alert" className="text-sm text-destructive">{formError}</p> : null}
              <button
                type="submit"
                disabled={request.isPending || preview || productUnavailable}
                className="neo-guest-secondary neo-guest-transfer-primary flex w-full items-center justify-center gap-2 disabled:opacity-50"
              >
                {request.isPending ? "Sending…" : preview ? "Preview only" : "Send request"}
                {!request.isPending && !preview ? <ArrowRight className="size-4" aria-hidden /> : null}
              </button>
            </fieldset>
            </form>
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
