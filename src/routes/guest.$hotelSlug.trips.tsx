import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { GuestScreen, GuestSection } from "@/components/public/GuestScreen";
import { BrandButton, PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import { money } from "@/lib/public-delivery";
import {
  isInHouse,
  requestCategories,
  requestStatusLabels,
  stayVerificationMessages,
  useCreateGuestRequest,
  useGuestProfile,
  useGuestRequests,
  useGuestReservations,
  useGuestScreenView,
  useMyStays,
  useVerifyStay,
} from "@/lib/guest-app";

export const Route = createFileRoute("/guest/$hotelSlug/trips")({
  head: () => ({
    meta: [
      { title: "My Trips — NEØ Guest" },
      { name: "description", content: "Your stays, current room, and service requests with the property." },
      { property: "og:title", content: "My Trips — NEØ Guest" },
      { property: "og:description", content: "Your stays, current room, and service requests with the property." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      // Personal to one guest: never a search result.
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: TripsPage,
});

function TripsPage() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { user, loading } = useCustomerSession();
  const profile = useGuestProfile(ws.organization_id, user?.id, ws.branch_id);
  const customerId = profile.data?.["id"] as string | undefined;
  const reservations = useGuestReservations(ws.organization_id, customerId);
  const requests = useGuestRequests(ws.organization_id, customerId);
  const createRequest = useCreateGuestRequest(ws.organization_id);
  useGuestScreenView(ws.organization_id, "trips", Boolean(customerId));

  const [category, setCategory] = useState<string>("housekeeping");
  const [description, setDescription] = useState("");

  const stay = (reservations.data ?? []).find((r) => isInHouse(r));

  async function submitRequest() {
    if (!description.trim()) return;
    try {
      await createRequest.mutateAsync({ category, description });
      setDescription("");
      toast.success("Request sent to the team");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send your request");
    }
  }

  if (!loading && !user) {
    return (
      <GuestScreen hotelSlug={hotelSlug} active="trips">
      <nav className="mt-4 grid grid-cols-2 gap-2">
        <Link
          to="/guest/$hotelSlug/folio"
          params={{ hotelSlug }}
          className="rounded-xl bg-white p-4 text-sm font-medium shadow-sm"
          style={{ color: brandFallback.secondary }}
        >
          My bill & receipts
        </Link>
        <Link
          to="/guest/$hotelSlug/transport"
          params={{ hotelSlug }}
          className="rounded-xl bg-white p-4 text-sm font-medium shadow-sm"
          style={{ color: brandFallback.secondary }}
        >
          Transport & transfers
        </Link>
        <Link
          to="/guest/$hotelSlug/laundry"
          params={{ hotelSlug }}
          className="rounded-xl bg-white p-4 text-sm font-medium shadow-sm"
          style={{ color: brandFallback.secondary }}
        >
          Laundry
        </Link>
      </nav>

        <GuestSignInPrompt hotelSlug={hotelSlug} title="Sign in to see your stays" description="Bookings, room context and service requests are private to your hotel account." />
      </GuestScreen>
    );
  }

  return (
    <GuestScreen hotelSlug={hotelSlug} active="trips">
      <section className="rounded-2xl bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold" style={{ color: brandFallback.secondary }}>
          My trips
        </h1>
        <p className="mt-2 text-sm" style={{ color: brandFallback.steel }}>
          Stays, current room context and every request you have raised.
        </p>
      </section>

      {stay ? (
        <GuestSection title="You are in house" description="Current stay context from the property system.">
          <dl className="grid gap-2 text-sm" style={{ color: brandFallback.secondary }}>
            <Line label="Confirmation" value={String(stay["confirmation_number"])} />
            <Line label="Arrival" value={String(stay["arrival_date"])} />
            <Line label="Departure" value={String(stay["departure_date"])} />
            <Line label="Balance" value={money(stay["balance"])} />
          </dl>
        </GuestSection>
      ) : null}

      <MyStaySection organizationId={ws.organization_id} enabled={Boolean(customerId)} />


      <GuestSection title="Request assistance" description="Goes straight to the responsible department.">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {requestCategories.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => setCategory(c.value)}
                className="rounded-full border px-3 py-1.5 text-xs font-medium"
                style={{
                  borderColor: category === c.value ? ws.primary_color : "rgba(0,0,0,0.1)",
                  color: category === c.value ? ws.primary_color : brandFallback.steel,
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Tell the team what you need"
            rows={3}
          />
          <BrandButton onClick={() => void submitRequest()} disabled={createRequest.isPending || !description.trim()}>
            {createRequest.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            Send request
          </BrandButton>
        </div>
      </GuestSection>

      <GuestSection title="My requests">
        {requests.isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin" style={{ color: brandFallback.steel }} />
          </div>
        ) : (requests.data?.length ?? 0) === 0 ? (
          <PublicEmptyState title="No requests yet" description="Anything you ask for will be tracked here." />
        ) : (
          <ul className="space-y-2">
            {(requests.data ?? []).map((r) => (
              <li key={String(r["id"])} className="rounded-xl border border-black/5 p-3">
                <p className="text-sm font-medium" style={{ color: brandFallback.secondary }}>
                  {String(r["description"])}
                </p>
                <p className="text-xs" style={{ color: brandFallback.steel }}>
                  {String(r["category"])} ·{" "}
                  {requestStatusLabels[String(r["status"])] ?? String(r["status"])} ·{" "}
                  {new Date(String(r["created_at"])).toLocaleString()}
                </p>
              </li>
            ))}
          </ul>
        )}
      </GuestSection>

      <GuestSection title="My reservations">
        {reservations.isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin" style={{ color: brandFallback.steel }} />
          </div>
        ) : (reservations.data?.length ?? 0) === 0 ? (
          <PublicEmptyState
            title="No reservations yet"
            description="Stays booked under your details will appear here."
          />
        ) : (
          <ul className="space-y-2">
            {(reservations.data ?? []).map((r) => (
              <li key={String(r["id"])} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-xl border border-black/5 p-3">
                <span className="min-w-0">
                  <span className="block text-sm font-medium" style={{ color: brandFallback.secondary }}>
                    <span data-public-id>{String(r["confirmation_number"])}</span>
                  </span>
                  <span className="block text-xs" style={{ color: brandFallback.steel }}>
                    {String(r["arrival_date"])} → {String(r["departure_date"])} · {String(r["status"])}
                  </span>
                </span>
                <Link
                  to="/guest/$hotelSlug/reservations/$reservationReference"
                  params={{ hotelSlug, reservationReference: String(r["confirmation_number"]) }}
                  className="text-xs font-medium"
                  style={{ color: ws.primary_color }}
                >
                  View details
                </Link>
              </li>
            ))}
          </ul>
        )}
      </GuestSection>
    </GuestScreen>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4">
      <dt style={{ color: brandFallback.steel }}>{label}</dt>
      <dd className="break-words text-right font-medium">{value}</dd>
    </div>
  );
}

/**
 * My Stay: bookings made under this customer's own record, plus any booking
 * they have proved is theirs. Everything shown here is decided by the hotel's
 * own records — never by what the browser claims.
 */
function MyStaySection({ organizationId, enabled }: { organizationId: string; enabled: boolean }) {
  const stays = useMyStays(organizationId, enabled);
  const verify = useVerifyStay(organizationId);
  const [reference, setReference] = useState("");
  const [detail, setDetail] = useState("");

  async function submit() {
    if (!reference.trim() || !detail.trim()) return;
    try {
      const result = await verify.mutateAsync({ reference, detail });
      if (result.verified) {
        setReference("");
        setDetail("");
        toast.success("Booking confirmed as yours");
      } else {
        toast.error(
          stayVerificationMessages[result.reason] ?? "We could not confirm that booking.",
        );
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "We could not confirm that booking.");
    }
  }

  return (
    <GuestSection
      title="My stay"
      description="Your stays at this hotel. Booked over the phone or by someone else? Confirm it below."
    >
      {stays.isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="size-5 animate-spin" style={{ color: brandFallback.steel }} />
        </div>
      ) : (stays.data?.length ?? 0) === 0 ? (
        <PublicEmptyState
          title="No stay linked yet"
          description="Confirm a booking with its reference and the surname, phone number or email used to make it."
        />
      ) : (
        <ul className="space-y-2">
          {(stays.data ?? []).map((s) => (
            <li key={String(s["id"])} className="rounded-xl border border-black/5 p-3">
              <p className="text-sm font-medium" style={{ color: brandFallback.secondary }}>
                {String(s["confirmation_number"])}
                {s["room_number"] ? ` · Room ${String(s["room_number"])}` : ""}
              </p>
              <p className="text-xs" style={{ color: brandFallback.steel }}>
                {String(s["arrival_date"])} → {String(s["departure_date"])} ·{" "}
                {String(s["status"])} · Balance {money(s["balance"])}
              </p>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 space-y-2 rounded-xl bg-black/[0.02] p-3">
        <p className="text-xs font-medium" style={{ color: brandFallback.secondary }}>
          Confirm a booking is yours
        </p>
        <Input
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="Booking reference"
          aria-label="Booking reference"
        />
        <Input
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          placeholder="Surname, phone number or email on the booking"
          aria-label="Surname, phone number or email on the booking"
        />
        <BrandButton
          onClick={() => void submit()}
          disabled={verify.isPending || !reference.trim() || !detail.trim()}
        >
          {verify.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Confirm booking
        </BrandButton>
      </div>
    </GuestSection>
  );
}
