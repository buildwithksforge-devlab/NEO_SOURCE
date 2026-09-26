import { useMemo, useState } from "react";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { canonicalLink, canonicalUrl, robotsDirective } from "@/lib/route-visibility";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CalendarCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { GuestScreen, GuestSection } from "@/components/public/GuestScreen";
import { BrandButton, PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { brandFallback } from "@/lib/public-apps";
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
  component: BookPage,
});

function isoDay(offsetDays: number) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function BookPage() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { user, loading } = useCustomerSession();
  const profile = useGuestProfile(ws.organization_id, user?.id, ws.branch_id);
  const customerId = profile.data?.["id"] as string | undefined;
  useGuestScreenView(ws.organization_id, "book", Boolean(customerId));

  const [arrival, setArrival] = useState(isoDay(1));
  const [departure, setDeparture] = useState(isoDay(2));
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [requests, setRequests] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{ reference: string; total: number } | null>(null);
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

  const primary = ws.primary_color || brandFallback.primary;
  const chosen = (offers.data ?? []).find((o) => o.room_type_id === selected) ?? null;

  async function confirm(offer: RoomOffer) {
    if (!ws.branch_id) return;
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
      setConfirmed({ reference: result.confirmation_number, total: Number(result.total_amount ?? 0) });
      toast.success(`Stay confirmed — ${result.confirmation_number}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not confirm your stay");
    }
  }

  if (loading) {
    return (
      <GuestScreen hotelSlug={hotelSlug} active="book">
        <div className="flex justify-center py-16">
          <Loader2 className="size-6 animate-spin" aria-label="Loading" />
        </div>
      </GuestScreen>
    );
  }

  if (!user) {
    return (
      <GuestScreen hotelSlug={hotelSlug} active="book">
        <GuestSignInPrompt hotelSlug={hotelSlug} title="Sign in to book" description="Your booking will be saved to your hotel profile and returned here after sign-in." />
      </GuestScreen>
    );
  }

  if (confirmed) {
    return (
      <GuestScreen hotelSlug={hotelSlug} active="book">
        <GuestSection title="Your stay is confirmed" description="The front office can see it straight away.">
          <div className="rounded-xl border border-black/5 p-4">
            <p className="text-xs uppercase tracking-wide" style={{ color: brandFallback.steel }}>
              Confirmation
            </p>
            <p className="text-xl font-semibold" style={{ color: brandFallback.secondary }}>
              {confirmed.reference}
            </p>
            <p className="mt-2 text-sm" style={{ color: brandFallback.steel }}>
              {arrival} to {departure} · {nights} night{nights === 1 ? "" : "s"} · {adults} adult
              {adults === 1 ? "" : "s"}
              {children ? ` · ${children} child${children === 1 ? "" : "ren"}` : ""}
            </p>
            <p className="mt-2 text-base font-semibold" style={{ color: primary }}>
              {money(confirmed.total, chosen?.currency ?? "KES")}
            </p>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link to="/guest/$hotelSlug/trips" params={{ hotelSlug }}>
              <BrandButton>View my trips</BrandButton>
            </Link>
            <Link to="/guest/$hotelSlug/folio" params={{ hotelSlug }}>
              <BrandButton variant="outline">See my bill</BrandButton>
            </Link>
          </div>
        </GuestSection>
      </GuestScreen>
    );
  }

  return (
    <GuestScreen hotelSlug={hotelSlug} active="book">
      <GuestSection title="Book a stay" description="Live availability for this property.">
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
                setSelected(null);
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
                setSelected(null);
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
        <p className="mt-3 text-xs" style={{ color: brandFallback.steel }}>
          {nights > 0 ? `${nights} night${nights === 1 ? "" : "s"}` : "Choose a departure after your arrival."}
        </p>
      </GuestSection>

      <GuestSection title="Available rooms" description="Only rooms the property still has free for these dates.">
        {offers.isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin" aria-label="Checking availability" />
          </div>
        ) : offers.error ? (
          <p className="text-sm text-red-600">
            {offers.error instanceof Error ? offers.error.message : "Could not check availability"}
          </p>
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
                  className="rounded-xl border p-4"
                  style={{ borderColor: active ? primary : "rgba(0,0,0,0.08)" }}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold" style={{ color: brandFallback.secondary }}>
                        {offer.room_type_name}
                      </p>
                      {offer.description ? (
                        <p className="mt-1 text-xs" style={{ color: brandFallback.steel }}>
                          {offer.description}
                        </p>
                      ) : null}
                      <p className="mt-1 text-xs" style={{ color: brandFallback.steel }}>
                        {offer.rooms_available} room{offer.rooms_available === 1 ? "" : "s"} left
                        {offer.rate_plan_name ? ` · ${offer.rate_plan_name}` : ""}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold" style={{ color: primary }}>
                        {money(offer.nightly_rate, offer.currency)}
                      </p>
                      <p className="text-xs" style={{ color: brandFallback.steel }}>
                        per night
                      </p>
                      <p className="mt-1 text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                        {money(offer.total_amount, offer.currency)} total
                      </p>
                    </div>
                  </div>
                  <div className="mt-3">
                    <BrandButton
                      variant={active ? "solid" : "outline"}
                      onClick={() => setSelected(offer.room_type_id)}
                    >
                      {active ? "Selected" : "Choose this room"}
                    </BrandButton>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </GuestSection>

      {chosen ? (
        <GuestSection title="Confirm your stay" description="We will hold this room for your arrival.">
          <Label htmlFor="requests">Anything we should know?</Label>
          <Textarea
            id="requests"
            value={requests}
            onChange={(e) => setRequests(e.target.value)}
            placeholder="Late arrival, quiet floor, allergies…"
            rows={3}
          />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm" style={{ color: brandFallback.steel }}>
              {chosen.room_type_name} · {nights} night{nights === 1 ? "" : "s"} ·{" "}
              <strong style={{ color: brandFallback.secondary }}>
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
      ) : null}
    </GuestScreen>
  );
}
