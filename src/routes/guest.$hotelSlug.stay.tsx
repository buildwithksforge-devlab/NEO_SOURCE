import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CalendarDays, ChevronRight, Loader2 } from "lucide-react";
import { GuestPageIntro, GuestScreen, GuestSection } from "@/components/public/GuestScreen";
import { PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import { money, statusLabel } from "@/lib/public-delivery";
import {
  stayVerificationMessages,
  useGuestScreenView,
  useMyStays,
  useVerifyStay,
} from "@/lib/guest-app";

export const Route = createFileRoute("/guest/$hotelSlug/stay")({
  head: () => ({
    meta: [
      { title: "My Stay — NEØ Guest" },
      { name: "description", content: "Your booking, room and charges for this hotel stay." },
      { property: "og:title", content: "My Stay — NEØ Guest" },
      { property: "og:description", content: "Your booking, room and charges for this hotel stay." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: MyStayPage,
});

type Row = Record<string, unknown>;

function MyStayPage() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { user, loading } = useCustomerSession();
  const stays = useMyStays(ws.organization_id, ws.branch_id, user?.id);
  const verify = useVerifyStay(ws.organization_id, ws.branch_id);
  const [reference, setReference] = useState("");
  const [detail, setDetail] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useGuestScreenView(ws.organization_id, "my-stay", Boolean(user));

  return (
    <GuestScreen hotelSlug={hotelSlug} active="stay">
      <GuestPageIntro title="My stay" description={ws.hotel_name} image={ws.hero_url}>
          <Link to="/guest/$hotelSlug/book" params={{ hotelSlug }} className="neo-guest-outline-action">Book a stay</Link>
          {user ? <a href="#link-booking" className="neo-guest-outline-action">Link a booking</a> : null}
          {user ? <Link to="/guest/$hotelSlug/folio" params={{ hotelSlug }} className="neo-guest-outline-action">Room charges</Link> : null}
          <Link to="/guest/$hotelSlug/transport" params={{ hotelSlug }} className="neo-guest-outline-action">Transfers</Link>
          <Link to="/guest/$hotelSlug/explore" params={{ hotelSlug }} search={{ section: "services" }} className="neo-guest-outline-action">Hotel services</Link>
      </GuestPageIntro>

      {loading ? (
        <p role="status" className="mt-4 text-sm text-[var(--guest-muted)]">Checking your guest session…</p>
      ) : !user ? (
        <GuestSignInPrompt
          hotelSlug={hotelSlug}
          title="Sign in to see your stay"
          description="Your room, dates and charges are private to your account."
        />
      ) : stays.isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin" style={{ color: "var(--guest-muted, #52627A)" }} />
        </div>
      ) : stays.isError ? (
        <PublicEmptyState title="Your bookings couldn’t load" description={`Refresh bookings for ${ws.hotel_name}.`}
          action={<button type="button" className="neo-guest-secondary" onClick={() => void stays.refetch()}>Retry bookings</button>} />
      ) : (stays.data?.length ?? 0) === 0 ? (
        <GuestSection title="Your bookings">
          <PublicEmptyState title="No bookings yet"
            description="Enter your booking reference below if you already booked with the hotel." />
        </GuestSection>
      ) : (
        <GuestSection title="Your bookings">
          <ul className="neo-guest-records">
            {((stays.data ?? []) as Row[]).map((s) => (
              <li key={String(s["reservation_id"] ?? s["confirmation_number"])}>
                <Link to="/guest/$hotelSlug/reservations/$reservationReference" params={{ hotelSlug, reservationReference: String(s["confirmation_number"]) }} className="neo-guest-record">
                  <span className="neo-guest-record-icon"><CalendarDays className="size-5" aria-hidden /></span>
                  <div>
                    <p className="text-sm font-semibold" style={{ color: "var(--guest-text, #07142D)" }}>
                      {String(s["confirmation_number"] ?? "")}
                    </p>
                    <p className="text-xs" style={{ color: "var(--guest-muted, #52627A)" }}>
                      {String(s["arrival_date"] ?? "")} → {String(s["departure_date"] ?? "")}
                      {s["room_number"] ? ` · Room ${String(s["room_number"])}` : ""}
                    </p>
                  </div>
                  <div className="neo-guest-record-total">
                    {s["balance"] === undefined ? null : (
                      <p className="text-sm font-semibold" style={{ color: "var(--guest-text, #07142D)" }}>
                        {money(s["balance"], String(s["currency"] ?? ws.currency ?? "KES"))}
                      </p>
                    )}
                    <p className="text-xs text-[var(--guest-muted)]">{statusLabel(s["status"])}</p>
                  </div>
                  <ChevronRight className="neo-guest-record-arrow size-4" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </GuestSection>
      )}

      {user ? (
        <GuestSection
          id="link-booking"
          title="Link another booking"
          description="Use the reference on your confirmation with a detail held on the booking."
        >
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              setMessage(null);
              verify.mutate(
                { reference: reference.trim(), detail: detail.trim() },
                {
                  onSuccess: (result) => {
                    setMessage(
                      result.verified
                        ? "Booking linked to your account."
                        : (stayVerificationMessages[result.reason] ?? "We could not link that booking."),
                    );
                    if (result.verified) {
                      setReference("");
                      setDetail("");
                    }
                  },
                  onError: () => setMessage("We could not link that booking just now."),
                },
              );
            }}
          >
            <div>
              <Label htmlFor="stay-reference">Booking reference</Label>
              <Input
                id="stay-reference"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div>
              <Label htmlFor="stay-detail">Surname, phone or email</Label>
              <Input
                id="stay-detail"
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="sm:col-span-2">
              <button
                type="submit"
                disabled={verify.isPending || !reference.trim() || !detail.trim()}
                className="rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: ws.primary_color || brandFallback.primary, color: "var(--pa-on-primary)" }}
              >
                {verify.isPending ? "Checking…" : "Link my booking"}
              </button>
              {message ? (
                <p className="mt-2 text-xs" style={{ color: "var(--guest-muted, #52627A)" }}>
                  {message}
                </p>
              ) : null}
            </div>
          </form>
        </GuestSection>
      ) : null}
    </GuestScreen>
  );
}
