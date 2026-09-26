import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { GuestScreen, GuestSection } from "@/components/public/GuestScreen";
import { PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import { money } from "@/lib/public-delivery";
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
  const stays = useMyStays(ws.organization_id, Boolean(user));
  const verify = useVerifyStay(ws.organization_id);
  const [reference, setReference] = useState("");
  const [detail, setDetail] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useGuestScreenView(ws.organization_id, "my-stay", Boolean(user));

  return (
    <GuestScreen hotelSlug={hotelSlug} active="stay">
      <section>
        <h1 className="neo-pub-display text-3xl sm:text-4xl" style={{ color: brandFallback.secondary }}>
          My stay
        </h1>
        <p className="mt-2 text-sm" style={{ color: brandFallback.steel }}>
          Your booking with {ws.hotel_name}, the room you are in and what has been charged.
        </p>
      </section>

      {!loading && !user ? (
        <GuestSignInPrompt
          hotelSlug={hotelSlug}
          title="Sign in to see your stay"
          description="Your room, dates and charges are private to your account."
        />
      ) : stays.isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin" style={{ color: brandFallback.steel }} />
        </div>
      ) : (stays.data?.length ?? 0) === 0 ? (
        <GuestSection
          title="No stay linked yet"
          description="If you booked another way, confirm it is yours below."
        >
          <PublicEmptyState
            title="Nothing linked to your account"
            description="Enter your booking reference with the surname, phone or email on the booking."
          />
        </GuestSection>
      ) : (
        <GuestSection title="Your bookings" description="Straight from the hotel's system.">
          <ul className="space-y-3">
            {((stays.data ?? []) as Row[]).map((s) => (
              <li key={String(s["reservation_id"] ?? s["confirmation_number"])} className="rounded-xl border border-black/5 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                      {String(s["confirmation_number"] ?? "")}
                    </p>
                    <p className="text-xs" style={{ color: brandFallback.steel }}>
                      {String(s["arrival_date"] ?? "")} → {String(s["departure_date"] ?? "")}
                      {s["room_number"] ? ` · Room ${String(s["room_number"])}` : ""}
                      {s["status"] ? ` · ${String(s["status"])}` : ""}
                    </p>
                  </div>
                  <div className="text-right">
                    {s["balance"] === undefined ? null : (
                      <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                        {money(s["balance"])}
                      </p>
                    )}
                    <Link
                      to="/guest/$hotelSlug/folio"
                      params={{ hotelSlug }}
                      className="text-xs font-medium"
                      style={{ color: ws.primary_color }}
                    >
                      View charges
                    </Link>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </GuestSection>
      )}

      {user ? (
        <GuestSection
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
                style={{ background: ws.primary_color || brandFallback.primary }}
              >
                {verify.isPending ? "Checking…" : "Link my booking"}
              </button>
              {message ? (
                <p className="mt-2 text-xs" style={{ color: brandFallback.steel }}>
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
