import { roomQuoteBreakdown } from '@/lib/guest-presentation';
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { canonicalLink, canonicalUrl, robotsDirective } from "@/lib/route-visibility";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CalendarCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { GuestPageIntro, GuestScreen, GuestSection } from "@/components/public/GuestScreen";
import { BrandButton, PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { fetchPublicPropertyRooms } from "@/lib/front-door";
import { useCustomerSession } from "@/lib/public-session";
import { money } from "@/lib/public-delivery";
import { useGuestProfile, useGuestScreenView } from "@/lib/guest-app";
import {
  nightsBetween,
  useCreateGuestBooking,
  useRoomOffers,
  type RoomOffer,
} from "@/lib/guest-booking";

export const Route = createFileRoute("/guest/$hotelSlug/book")({
  validateSearch: (search): { room?: string } =>
    typeof search["room"] === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(search["room"])
      ? { room: search["room"].toLowerCase() } : {},
  loaderDeps: ({ search }) => ({ room: search.room }),
  loader: async ({ params, deps, abortController }) => {
    if (!deps.room) return null;
    try {
      const signal = AbortSignal.any([abortController.signal, AbortSignal.timeout(3500)]);
      const rooms = await fetchPublicPropertyRooms(params.hotelSlug, signal);
      return rooms.find((entry) => entry.room_type_id === deps.room) ?? null;
    } catch {
      return null;
    }
  },
  head: ({ params }) => ({
    meta: [
      { title: "Book a Stay — NEØ Guest" },
      {
        name: "description",
        content: "Check live room availability, see the nightly rate and confirm your own stay in a few taps.",
      },
      { property: "og:title", content: "Book a Stay — NEØ Guest" },
      {
        property: "og:description",
        content: "Check live room availability, see the nightly rate and confirm your own stay in a few taps.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: canonicalUrl(`/guest/${params.hotelSlug}/book`) },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: robotsDirective(`/guest/${params.hotelSlug}/book`) },
    ],
    links: [canonicalLink(`/guest/${params.hotelSlug}/book`)],
  }),
  component: BookingRoute,
});

function BookingRoute() {
  const { room } = Route.useSearch();
  return <BookPage key={room ?? "browse"} />;
}

function isoDay(offsetDays: number) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function BookPage() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { room } = Route.useSearch();
  const linkedRoom = Route.useLoaderData();
  const { user, loading } = useCustomerSession();
  const profile = useGuestProfile(ws.organization_id, user?.id, ws.branch_id);
  const catalogue = useQuery({
    queryKey: ["public", "property-rooms", hotelSlug],
    queryFn: () => fetchPublicPropertyRooms(hotelSlug),
    retry: 1,
  });
  const customerId = profile.data?.["id"] as string | undefined;
  useGuestScreenView(ws.organization_id, "book", Boolean(customerId));

  const [arrival, setArrival] = useState(isoDay(1));
  const [departure, setDeparture] = useState(isoDay(2));
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [requests, setRequests] = useState("");
  const [selected, setSelected] = useState<string | null>(room ?? null);
  const [confirmed, setConfirmed] = useState<{ reference: string; quote: RoomOffer; arrival: string; departure: string; adults: number; children: number } | null>(null);
  const review = useRef<HTMLDivElement>(null);
  // One intent per search, so a double tap or a refresh returns the same stay.
  const intentKey = useMemo(
    () => `${arrival}:${departure}:${adults}:${children}:${selected ?? ""}`,
    [arrival, departure, adults, children, selected],
  );

  const nights = nightsBetween(arrival, departure);
  const offers = useRoomOffers(
    {
      organizationId: ws.organization_id,
      branchId: ws.branch_id,
      arrival,
      departure,
      adults,
      children,
    },
    Boolean(customerId),
  );
  const booking = useCreateGuestBooking(ws.organization_id);

  const chosen = (offers.data ?? []).find((o) => o.room_type_id === selected) ?? null;
  const selectedRoom = catalogue.data?.find((entry) => entry.room_type_id === selected)
    ?? (linkedRoom?.room_type_id === selected ? linkedRoom : null);

  const breakdown = chosen ? roomQuoteBreakdown(chosen) : null;

  async function confirm(offer: RoomOffer) {
    if (!ws.branch_id || booking.isPending) return;
    try {
      const result = await booking.mutateAsync({
        branchId: ws.branch_id,
        roomTypeId: offer.room_type_id,
        arrival,
        departure,
        adults,
        children,
        specialRequests: requests,
        intentKey: `${intentKey}:${offer.room_type_id}`,
      });
      setConfirmed({ reference: result.confirmation_number, quote: { ...offer, total_amount: result.total_amount }, arrival, departure, adults, children });
      toast.success(`Stay confirmed — ${result.confirmation_number}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not confirm your stay");
    }
  }

  if (loading || !user) {
    return (
      <GuestScreen hotelSlug={hotelSlug} active="book">
        <GuestPageIntro title={selectedRoom?.name ?? "Book a stay"}
          description={selectedRoom?.description ?? ws.hotel_name}
          image={selectedRoom?.images[0] ?? ws.hero_url}>
          {selectedRoom?.from_rate != null ? (
            <span className="neo-guest-outline-action">From {money(selectedRoom.from_rate, selectedRoom.currency ?? ws.currency ?? "KES")} / night</span>
          ) : null}
          <Link to="/guest/$hotelSlug/explore" params={{ hotelSlug }} search={{ section: "rooms" }} className="neo-guest-outline-action">Browse rooms</Link>
        </GuestPageIntro>
        <GuestSection title="Check dates and availability">
          {loading ? (
            <p role="status" className="flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Checking your guest session…
            </p>
          ) : <GuestSignInPrompt hotelSlug={hotelSlug} title="Sign in to book" description="You’ll return here to check dates and book." />}
        </GuestSection>
      </GuestScreen>
    );
  }

  if (confirmed) {
    return (
      <GuestScreen hotelSlug={hotelSlug} active="book">
        <GuestPageIntro title="Stay confirmed" description={ws.hotel_name} image={selectedRoom?.images[0] ?? ws.hero_url} />
        <GuestSection title="Booking details">
          <div className="rounded-xl border border-black/5 p-4">
            <p className="text-xs uppercase tracking-wide" style={{ color: "var(--guest-muted, #52627A)" }}>
              Confirmation
            </p>
            <p className="text-xl font-semibold" style={{ color: "var(--guest-text, #07142D)" }}>
              {confirmed.reference}
            </p>
            <p className="mt-2 text-sm" style={{ color: "var(--guest-muted, #52627A)" }}>
              {confirmed.arrival} to {confirmed.departure} · {confirmed.quote.nights} night{confirmed.quote.nights === 1 ? "" : "s"} · {confirmed.adults} adult
              {confirmed.adults === 1 ? "" : "s"}
              {confirmed.children ? ` · ${confirmed.children} child${confirmed.children === 1 ? "" : "ren"}` : ""}
            </p>
            <p className="mt-2 text-base font-semibold" style={{ color: "var(--pa-accent-ink)" }}>
              {money(confirmed.quote.total_amount, confirmed.quote.currency)}
            </p>
          </div>
          {(() => { const summary = roomQuoteBreakdown(confirmed.quote); return summary ? <dl className="mt-3 space-y-1 text-sm">
            <div className="flex justify-between gap-3"><dt>Room rate × {confirmed.quote.nights} nights</dt><dd>{money(summary.base, confirmed.quote.currency)}</dd></div>
            {summary.adjustment !== 0 ? <div className="flex justify-between gap-3"><dt>{summary.adjustment > 0 ? "Other quoted charges" : "Quoted adjustments"}</dt><dd>{money(summary.adjustment, confirmed.quote.currency)}</dd></div> : null}
          </dl> : null; })()}
          <div className="mt-4 flex flex-wrap gap-2">
            <Link to="/guest/$hotelSlug/reservations/$reservationReference" params={{ hotelSlug, reservationReference: confirmed.reference }} className="neo-guest-secondary">
              View this reservation
            </Link>
            <Link to="/guest/$hotelSlug/stay" params={{ hotelSlug }} className="neo-guest-outline-action">
              My stay
            </Link>
          </div>
        </GuestSection>
      </GuestScreen>
    );
  }

  return (
    <GuestScreen hotelSlug={hotelSlug} active="book">
      <GuestPageIntro title={selectedRoom?.name ?? "Book a stay"} description={ws.hotel_name}
        image={selectedRoom?.images[0] ?? ws.hero_url}>
        <Link to="/guest/$hotelSlug/explore" params={{ hotelSlug }} search={{ section: "rooms" }} className="neo-guest-outline-action">Browse rooms</Link>
      </GuestPageIntro>
      <GuestSection title="Dates and guests" surface>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="arrival">Arrival</Label>
            <NeoDatePicker
              id="arrival"
              value={arrival}
              min={isoDay(0)}
              ariaLabel="Arrival date"
              onChange={(value) => {
                setArrival(value);
              }}
            />
          </div>
          <div>
            <Label htmlFor="departure">Departure</Label>
            <NeoDatePicker
              id="departure"
              value={departure}
              min={arrival}
              ariaLabel="Departure date"
              onChange={(value) => {
                setDeparture(value);
              }}
            />
          </div>
          <div>
            <Label htmlFor="adults">Adults</Label>
            <Input
              id="adults"
              type="number"
              min={1}
              max={10}
              value={adults}
              onChange={(e) => setAdults(Math.max(1, Number(e.target.value) || 1))}
            />
          </div>
          <div>
            <Label htmlFor="children">Children</Label>
            <Input
              id="children"
              type="number"
              min={0}
              max={10}
              value={children}
              onChange={(e) => setChildren(Math.max(0, Number(e.target.value) || 0))}
            />
          </div>
        </div>
        <p className="mt-3 text-xs" style={{ color: "var(--guest-muted, #52627A)" }}>
          {nights > 0 ? `${nights} night${nights === 1 ? "" : "s"}` : "Choose a departure after your arrival."}
        </p>
      </GuestSection>

      <GuestSection title="Available rooms" description="Only rooms the property still has free for these dates.">
        {profile.isLoading || offers.isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin" aria-label="Checking availability" />
          </div>
        ) : profile.isError || offers.isError ? (
          <PublicEmptyState title="Availability couldn’t load" description="Try checking availability again."
            action={<BrandButton onClick={() => void (profile.isError ? profile.refetch() : offers.refetch())}>Retry</BrandButton>} />
        ) : !customerId ? (
          <PublicEmptyState title="Your guest profile isn’t ready" description="Reload your profile to check availability."
            action={<BrandButton onClick={() => void profile.refetch()}>Reload profile</BrandButton>} />
        ) : nights < 1 ? (
          <p role="status" className="text-sm text-[var(--guest-muted)]">Choose a departure after your arrival to see available rooms.</p>
        ) : (offers.data ?? []).length === 0 ? (
          <PublicEmptyState
            title="Nothing free for those dates"
            description="Try a different arrival or a shorter stay."
          />
        ) : (
          <ul className="space-y-3">
            {(offers.data ?? []).map((offer) => {
              const active = offer.room_type_id === selected;
              return (
                <li
                  key={offer.room_type_id}
                  className="neo-guest-task-panel"
                  data-selected={active}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold" style={{ color: "var(--guest-text, #07142D)" }}>
                        {offer.room_type_name}
                      </p>
                      {offer.description ? (
                        <p className="mt-1 text-xs" style={{ color: "var(--guest-muted, #52627A)" }}>
                          {offer.description}
                        </p>
                      ) : null}
                      <p className="mt-1 text-xs" style={{ color: "var(--guest-muted, #52627A)" }}>
                        {offer.rooms_available} room{offer.rooms_available === 1 ? "" : "s"} left
                        {offer.rate_plan_name ? ` · ${offer.rate_plan_name}` : ""}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold" style={{ color: "var(--pa-accent-ink)" }}>
                        {money(offer.nightly_rate, offer.currency)}
                      </p>
                      <p className="text-xs" style={{ color: "var(--guest-muted, #52627A)" }}>
                        per night
                      </p>
                      <p className="mt-1 text-sm font-semibold" style={{ color: "var(--guest-text, #07142D)" }}>
                        {money(offer.total_amount, offer.currency)} total
                      </p>
                    </div>
                  </div>
                  <div className="mt-3">
                    <BrandButton
                      variant={active ? "solid" : "outline"}
                      onClick={() => {
                        setSelected(offer.room_type_id);
                        requestAnimationFrame(() => review.current?.focus());
                      }}
                    >
                      {active ? "Review selected room" : "Choose this room"}
                    </BrandButton>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </GuestSection>

      {chosen ? (
        <div ref={review} tabIndex={-1}>
        <GuestSection title={`Review ${chosen.room_type_name}`} surface>
          {breakdown ? <dl className="mb-4 space-y-2 rounded-xl border p-4 text-sm">
            <div className="flex justify-between gap-3"><dt>Room rate × {chosen.nights} night{chosen.nights === 1 ? "" : "s"}</dt><dd>{money(breakdown.base, chosen.currency)}</dd></div>
            {breakdown.adjustment !== 0 ? <div className="flex justify-between gap-3"><dt>{breakdown.adjustment > 0 ? "Other quoted charges" : "Quoted adjustments"}</dt><dd>{money(breakdown.adjustment, chosen.currency)}</dd></div> : null}
            <div className="flex justify-between gap-3 font-semibold"><dt>Total for your stay</dt><dd>{money(breakdown.total, chosen.currency)}</dd></div>
          </dl> : null}
          <Label htmlFor="requests">Anything we should know?</Label>
          <Textarea
            id="requests"
            value={requests}
            onChange={(e) => setRequests(e.target.value)}
            placeholder="Late arrival, quiet floor, allergies…"
            rows={3}
          />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm" style={{ color: "var(--guest-muted, #52627A)" }}>
              {chosen.room_type_name} · {nights} night{nights === 1 ? "" : "s"} ·{" "}
              <strong style={{ color: "var(--guest-text, #07142D)" }}>
                {money(chosen.total_amount, chosen.currency)}
              </strong>
            </p>
            <BrandButton disabled={booking.isPending} onClick={() => void confirm(chosen)}>
              {booking.isPending ? (
                <Loader2 className="mr-2 inline size-4 animate-spin" aria-hidden />
              ) : (
                <CalendarCheck className="mr-2 inline size-4" aria-hidden />
              )}
              Confirm stay
            </BrandButton>
          </div>
        </GuestSection>
        </div>
      ) : null}
    </GuestScreen>
  );
}
