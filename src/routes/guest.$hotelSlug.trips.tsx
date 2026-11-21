import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { GuestPageIntro, GuestScreen, GuestSection } from "@/components/public/GuestScreen";
import { BrandButton, PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import { money } from "@/lib/public-delivery";
import { usePublicExperiences } from "@/lib/guest-experiences";
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
  validateSearch: (search): { experience?: string } =>
    typeof search["experience"] === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(search["experience"])
      ? { experience: search["experience"].toLowerCase() } : {},
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
  const { experience } = Route.useSearch();
  const { user, loading } = useCustomerSession();
  const profile = useGuestProfile(ws.organization_id, user?.id, ws.branch_id);
  const customerId = profile.data?.["id"] as string | undefined;
  const reservations = useGuestReservations(ws.organization_id, customerId, ws.branch_id);
  const requests = useGuestRequests(ws.organization_id, ws.branch_id, customerId);
  const createRequest = useCreateGuestRequest(ws.organization_id, ws.branch_id);
  const packages = usePublicExperiences(experience ? ws.branch_id ?? undefined : undefined);
  const selectedExperience = packages.data?.find((entry) => entry.id === experience);
  useGuestScreenView(ws.organization_id, "trips", Boolean(customerId));

  const [category, setCategory] = useState<string>("housekeeping");
  const [description, setDescription] = useState("");
  const [sentRequest, setSentRequest] = useState<string | null>(null);

  const stay = (reservations.data ?? []).find((r) => isInHouse(r));

  async function submitRequest() {
    if (!customerId || !description.trim() || createRequest.isPending || (experience && !selectedExperience)) return;
    try {
      const id = await createRequest.mutateAsync({
        category: selectedExperience ? "concierge" : category,
        description: selectedExperience
          ? `Experience enquiry · ${selectedExperience.name}\n${description.trim()}`
          : description.trim(),
      });
      setDescription("");
      setSentRequest(id);
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
          style={{ color: "var(--guest-text, #07142D)" }}
        >
          My bill & receipts
        </Link>
        <Link
          to="/guest/$hotelSlug/transport"
          params={{ hotelSlug }}
          className="rounded-xl bg-white p-4 text-sm font-medium shadow-sm"
          style={{ color: "var(--guest-text, #07142D)" }}
        >
          Transport & transfers
        </Link>
        <Link
          to="/guest/$hotelSlug/laundry"
          params={{ hotelSlug }}
          className="rounded-xl bg-white p-4 text-sm font-medium shadow-sm"
          style={{ color: "var(--guest-text, #07142D)" }}
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
      <GuestPageIntro title={experience ? "Ask about an experience" : "Hotel requests"}
        description={`Ask the team at ${ws.hotel_name} for help with your stay.`}>
        <Link to="/guest/$hotelSlug/stay" params={{ hotelSlug }} className="neo-guest-outline-action">My stay</Link>
        <Link to="/guest/$hotelSlug/transport" params={{ hotelSlug }} className="neo-guest-outline-action">Transfers</Link>
        {customerId ? <a href="#guest-requests" className="neo-guest-outline-action">My requests</a> : null}
      </GuestPageIntro>

      {loading || profile.isLoading ? (
        <p role="status" className="text-sm text-[var(--guest-muted)]">Loading your hotel requests…</p>
      ) : profile.isError || !customerId ? (
        <PublicEmptyState title="Your guest account could not load"
          description="Refresh your account to send and track requests."
          action={<button type="button" className="neo-guest-secondary" onClick={() => void profile.refetch()}>Try again</button>} />
      ) : <>
      {!experience && stay ? (
        <GuestSection title="You are in house" description="Current stay context from the property system.">
          <dl className="grid gap-2 text-sm" style={{ color: "var(--guest-text, #07142D)" }}>
            <Line label="Confirmation" value={String(stay["confirmation_number"])} />
            <Line label="Arrival" value={String(stay["arrival_date"])} />
            <Line label="Departure" value={String(stay["departure_date"])} />
            <Line label="Balance" value={money(stay["balance"])} />
          </dl>
        </GuestSection>
      ) : null}

      {!experience ? <MyStaySection organizationId={ws.organization_id} branchId={ws.branch_id} {...(user ? { userId: user.id } : {})} /> : null}


      <GuestSection id="request-assistance" title={experience ? "Experience enquiry" : "Request assistance"} surface>
        <div className="space-y-3">
          {experience ? (
            <div className="space-y-2">
              <p className="font-medium">
                {selectedExperience?.name ?? (packages.isPending ? "Loading the selected experience…" : "This experience is unavailable")}
              </p>
              <Link to="/guest/$hotelSlug/explore" params={{ hotelSlug }} search={{ section: "experiences" }} className="neo-guest-outline-action">Browse experiences</Link>
              {packages.isError ? <button type="button" className="neo-guest-outline-action" onClick={() => void packages.refetch()}>Retry</button> : null}
            </div>
          ) : <div className="flex flex-wrap gap-2">
            {requestCategories.map((c) => (
              <button
                key={c.value}
                type="button"
                aria-pressed={category === c.value}
                onClick={() => setCategory(c.value)}
                className="rounded-full border px-3 py-1.5 text-xs font-medium"
                style={{
                  borderColor: category === c.value ? ws.primary_color : "rgba(0,0,0,0.1)",
                  color: category === c.value ? "var(--pa-accent-ink)" : "var(--guest-muted)",
                }}
              >
                {c.label}
              </button>
            ))}
          </div>}
          <Textarea
            value={description}
            aria-label="What do you need help with?"
            onChange={(e) => setDescription(e.target.value)}
            placeholder={experience ? "Tell the concierge your preferred date and number of guests" : "Tell the team what you need"}
            rows={3}
          />
          <BrandButton onClick={() => void submitRequest()} disabled={createRequest.isPending || !description.trim() || Boolean(experience && !selectedExperience)}>
            {createRequest.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            Send request
          </BrandButton>
          {sentRequest ? <p role="status" className="text-sm">Request sent. <a href={requests.data?.some((row) => row["id"] === sentRequest) ? `#guest-request-${sentRequest}` : "#guest-requests"} className="underline">Check its status</a>.</p> : null}
        </div>
      </GuestSection>

      <GuestSection id="guest-requests" title="My requests">
        {requests.isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin" style={{ color: "var(--guest-muted, #52627A)" }} />
          </div>
        ) : requests.isError ? (
          <PublicEmptyState title="Requests could not load"
            description="Refresh to see the latest updates from the hotel."
            action={<button type="button" className="neo-guest-secondary" onClick={() => void requests.refetch()}>Try again</button>} />
        ) : (requests.data?.length ?? 0) === 0 ? (
          <PublicEmptyState title="No requests yet" description="Anything you ask for will be tracked here." />
        ) : (
          <ul className="space-y-2">
            {(requests.data ?? []).map((r) => (
              <li id={`guest-request-${String(r["id"])}`} key={String(r["id"])} className="rounded-xl border border-black/5 p-3">
                <p className="text-sm font-medium" style={{ color: "var(--guest-text, #07142D)" }}>
                  {String(r["description"])}
                </p>
                <p className="text-xs" style={{ color: "var(--guest-muted, #52627A)" }}>
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
            <Loader2 className="size-5 animate-spin" style={{ color: "var(--guest-muted, #52627A)" }} />
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
                  <span className="block text-sm font-medium" style={{ color: "var(--guest-text, #07142D)" }}>
                    <span data-public-id>{String(r["confirmation_number"])}</span>
                  </span>
                  <span className="block text-xs" style={{ color: "var(--guest-muted, #52627A)" }}>
                    {String(r["arrival_date"])} → {String(r["departure_date"])} · {String(r["status"])}
                  </span>
                </span>
                <Link
                  to="/guest/$hotelSlug/reservations/$reservationReference"
                  params={{ hotelSlug, reservationReference: String(r["confirmation_number"]) }}
                  className="text-xs font-medium"
                  style={{ color: "var(--pa-accent-ink)" }}
                >
                  View details
                </Link>
              </li>
            ))}
          </ul>
        )}
      </GuestSection>
      </>}
    </GuestScreen>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4">
      <dt style={{ color: "var(--guest-muted, #52627A)" }}>{label}</dt>
      <dd className="break-words text-right font-medium">{value}</dd>
    </div>
  );
}

/**
 * My Stay: bookings made under this customer's own record, plus any booking
 * they have proved is theirs. Everything shown here is decided by the hotel's
 * own records — never by what the browser claims.
 */
function MyStaySection({ organizationId, branchId, userId }: { organizationId: string; branchId: string | null; userId?: string }) {
  const stays = useMyStays(organizationId, branchId, userId);
  const verify = useVerifyStay(organizationId, branchId);
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
          <Loader2 className="size-5 animate-spin" style={{ color: "var(--guest-muted, #52627A)" }} />
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
              <p className="text-sm font-medium" style={{ color: "var(--guest-text, #07142D)" }}>
                {String(s["confirmation_number"])}
                {s["room_number"] ? ` · Room ${String(s["room_number"])}` : ""}
              </p>
              <p className="text-xs" style={{ color: "var(--guest-muted, #52627A)" }}>
                {String(s["arrival_date"])} → {String(s["departure_date"])} ·{" "}
                {String(s["status"])} · Balance {money(s["balance"])}
              </p>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 space-y-2 rounded-xl bg-black/[0.02] p-3">
        <p className="text-xs font-medium" style={{ color: "var(--guest-text, #07142D)" }}>
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
