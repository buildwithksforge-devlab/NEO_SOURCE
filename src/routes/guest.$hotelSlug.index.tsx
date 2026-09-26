import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  BedDouble,
  ConciergeBell,
  MapPin,
  Receipt,
  Shirt,
  UtensilsCrossed,
  Bike,
} from "lucide-react";
import { BrandMark, useWorkspace } from "@/components/public/PublicAppShell";
import { GuestScreen, GuestSection } from "@/components/public/GuestScreen";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { GuestCardsSkeleton } from "@/components/public/GuestSkeleton";
import { useGuestScreenView } from "@/lib/guest-app";
import { useGuestActiveStay } from "@/lib/guest-ordering";
import { supabase } from "@/integrations/supabase/client";
import { brandFallback, buttonRadius } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import { money, useMyPublicCustomer, usePublicMenu } from "@/lib/public-delivery";
import { useMyGuestHotels } from "@/lib/guest-notifications";
import { canonicalLink, canonicalUrl, robotsDirective } from "@/lib/route-visibility";

export const Route = createFileRoute("/guest/$hotelSlug/")({
  head: ({ params }) => ({
    meta: [
      { title: "Your stay — NEØ Guest" },
      {
        name: "description",
        content:
          "Book a room, order from the restaurant, request housekeeping or laundry, and follow your stay at this hotel.",
      },
      { property: "og:title", content: "Your stay — NEØ Guest" },
      {
        property: "og:description",
        content: "Book, dine and use this hotel's services from one place.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: canonicalUrl(`/guest/${params.hotelSlug}`) },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: robotsDirective(`/guest/${params.hotelSlug}`) },
    ],
    links: [canonicalLink(`/guest/${params.hotelSlug}`)],
  }),
  component: GuestHome,
});

type Row = Record<string, unknown>;

function useMyReservations(organizationId: string, customerId?: string) {
  return useQuery({
    queryKey: ["guest", organizationId, "reservations", customerId ?? "none"],
    enabled: Boolean(customerId),
    queryFn: async () => {
      const { data, error } = await (supabase as unknown as { from: (t: string) => any })
        .from("reservations")
        .select(
          "id, confirmation_number, status, arrival_date, departure_date, nights, adults, children, total_amount, balance",
        )
        .eq("organization_id", organizationId)
        .eq("customer_id", customerId)
        .order("arrival_date", { ascending: false })
        .limit(25);
      if (error) throw new Error(error.message);
      return (data ?? []) as Row[];
    },
  });
}

const shortcuts = [
  { key: "book", label: "Rooms", icon: BedDouble, to: "/guest/$hotelSlug/book" },
  { key: "dine", label: "Dining", icon: UtensilsCrossed, to: "/guest/$hotelSlug/explore" },
  { key: "laundry", label: "Laundry", icon: Shirt, to: "/guest/$hotelSlug/laundry" },
  { key: "transport", label: "Transport", icon: Bike, to: "/guest/$hotelSlug/transport" },
  { key: "folio", label: "Charges", icon: Receipt, to: "/guest/$hotelSlug/folio" },
  { key: "trips", label: "Requests", icon: ConciergeBell, to: "/guest/$hotelSlug/trips" },
] as const;

function GuestHome() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { user, loading } = useCustomerSession();
  const customer = useMyPublicCustomer(ws.organization_id, user?.id);
  const reservations = useMyReservations(
    ws.organization_id,
    customer.data?.["id"] as string | undefined,
  );
  const stay = useGuestActiveStay(ws.organization_id, Boolean(user));
  const publicMenu = usePublicMenu(ws.organization_id, ws.branch_id, "room-service");
  const hasPublishedDining = (publicMenu.data?.length ?? 0) > 0;
  const primary = ws.primary_color || brandFallback.primary;

  useGuestScreenView(ws.organization_id, "home", Boolean(customer.data));

  const hotels = useMyGuestHotels(Boolean(user));
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  /** The guest's own name, as this hotel holds it — never a made-up greeting. */
  const guestName =
    (customer.data?.["full_name"] as string | undefined)?.trim() ||
    (user?.user_metadata?.["full_name"] as string | undefined)?.trim() ||
    "";
  const firstName = guestName ? guestName.split(" ")[0] : "";

  const active = (reservations.data ?? []).filter(
    (row) => String(row["status"] ?? "") !== "cancelled",
  );
  /** Still to come: departure has not passed. Soonest arrival first. */
  const upcomingAll = active
    .filter((row) => String(row["departure_date"] ?? "") >= today)
    .sort((a, b) => String(a["arrival_date"]).localeCompare(String(b["arrival_date"])));
  const upcoming = upcomingAll[0];
  const laterStays = upcomingAll.slice(1);
  const pastStays = active.filter((row) => String(row["departure_date"] ?? "") < today);
  const otherHotels = (hotels.data ?? []).filter((row) => row.public_slug !== hotelSlug);

  return (
    <GuestScreen hotelSlug={hotelSlug} active="home">
      {/* Hero: the property first, in its own colours — not a white welcome box. */}
      <section
        className="relative isolate overflow-hidden rounded-3xl px-6 py-10 sm:px-10 sm:py-14"
        style={{
          background: ws.icon_url
            ? `linear-gradient(120deg, rgba(2,10,28,0.85), rgba(2,10,28,0.45)), url(${ws.icon_url}) center/cover`
            : `linear-gradient(130deg, ${brandFallback.navy} 0%, ${brandFallback.secondary} 45%, ${primary} 140%)`,
        }}
      >
        <div className="max-w-2xl">
          <span className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.22em] text-white/60">
            <MapPin className="size-3.5" aria-hidden />
            {ws.contact_address || "Your hotel"}
          </span>
          <h1 className="neo-pub-display mt-3 text-3xl text-white sm:text-5xl">
            {firstName ? `Welcome back, ${firstName}` : ws.welcome_title || ws.hotel_name}
          </h1>
          <p className="neo-public-copy mt-3 max-w-xl text-sm text-white/75 sm:text-base">
            {firstName
              ? `Your stay, orders and charges with ${ws.hotel_name}, in one place.`
              : ws.welcome_message ||
                "Book a room, order from the kitchen, request what you need and follow your charges — all in one place."}
          </p>
          <div className="mt-6 flex flex-wrap gap-3" data-public-actions>
            <Link
              to="/guest/$hotelSlug/book"
              params={{ hotelSlug }}
              className="inline-flex min-h-11 items-center px-5 text-sm font-semibold text-white"
              style={{ background: primary, borderRadius: buttonRadius(ws.button_style) }}
            >
              Check availability
            </Link>
            {hasPublishedDining ? <Link
              to="/guest/$hotelSlug/explore"
              params={{ hotelSlug }}
              className="inline-flex min-h-11 items-center border border-white/30 px-5 text-sm font-semibold text-white"
              style={{ borderRadius: buttonRadius(ws.button_style) }}
            >
              See the menu
            </Link> : null}
          </div>
        </div>
        {ws.logo_url ? (
          <span className="pointer-events-none absolute right-6 top-6 hidden opacity-90 lg:block">
            <BrandMark workspace={ws} size={52} />
          </span>
        ) : null}
      </section>

      {/* Checked in right now: the room, the balance and what you can do from bed. */}
      {stay.data ? (
        <section className="neo-rider-card mt-6 min-w-0 p-5 sm:p-6">
          <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-[0.18em]" style={{ color: primary }}>
                You are checked in
              </p>
              <p className="mt-1 text-lg font-semibold" style={{ color: brandFallback.secondary }}>
                {stay.data.room_number ? `Room ${stay.data.room_number}` : "Room being assigned"}
              </p>
              <p className="neo-public-copy text-sm" style={{ color: brandFallback.steel }}>
                {stay.data.arrival_date} → {stay.data.departure_date}
              </p>
            </div>
            <div className="min-w-0 sm:text-right">
              <p className="text-xs" style={{ color: brandFallback.steel }}>
                Folio balance
              </p>
              <p className="text-lg font-semibold" style={{ color: brandFallback.secondary }}>
                {money(stay.data.folio_balance ?? 0)}
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2" data-public-actions>
            {hasPublishedDining ? <Link
              to="/guest/$hotelSlug/explore"
              params={{ hotelSlug }}
              className="inline-flex min-h-10 items-center px-4 text-sm font-semibold text-white"
              style={{ background: primary, borderRadius: buttonRadius(ws.button_style) }}
            >
              Order to my room
            </Link> : null}
            <Link
              to="/guest/$hotelSlug/folio"
              params={{ hotelSlug }}
              className="inline-flex min-h-10 items-center border px-4 text-sm font-semibold"
              style={{
                color: primary,
                borderColor: primary,
                borderRadius: buttonRadius(ws.button_style),
              }}
            >
              My charges
            </Link>
            <Link
              to="/guest/$hotelSlug/trips"
              params={{ hotelSlug }}
              className="inline-flex min-h-10 items-center border px-4 text-sm font-semibold"
              style={{
                color: brandFallback.steel,
                borderColor: "rgba(0,0,0,0.12)",
                borderRadius: buttonRadius(ws.button_style),
              }}
            >
              Ask for something
            </Link>
          </div>
        </section>
      ) : null}

      {/* Your stay comes before anything the hotel wants to advertise. */}
      {!loading && !user ? (
        <GuestSignInPrompt
          hotelSlug={hotelSlug}
          title="Sign in to see your stay"
          description="Your bookings, orders and charges with this hotel stay private to your account."
        />
      ) : reservations.isLoading ? (
        <div className="mt-6">
          <GuestCardsSkeleton cards={1} label="Loading your stay" />
        </div>
      ) : upcoming ? (
        <section className="neo-rider-card mt-6 grid min-w-0 gap-4 p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-6">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.18em]" style={{ color: primary }}>
              Your stay
            </p>
            <p className="mt-1 text-lg font-semibold" style={{ color: brandFallback.secondary }}>
              {String(upcoming["arrival_date"])} → {String(upcoming["departure_date"])}
            </p>
            <p className="neo-public-copy text-sm" style={{ color: brandFallback.steel }}>
              <span data-public-id>{String(upcoming["confirmation_number"])}</span> ·{" "}
              {String(upcoming["nights"])} night(s) · {String(upcoming["status"])}
            </p>
          </div>
          <div className="min-w-0 sm:text-right" data-public-actions>
            <p className="text-lg font-semibold" style={{ color: brandFallback.secondary }}>
              {money(upcoming["total_amount"])}
            </p>
            <Link
              to="/guest/$hotelSlug/reservations/$reservationReference"
              params={{
                hotelSlug,
                reservationReference: String(upcoming["confirmation_number"]),
              }}
              className="text-sm font-medium"
              style={{ color: primary }}
            >
              View my stay
            </Link>
          </div>
        </section>
      ) : (
        <section className="neo-rider-card mt-6 p-5 sm:p-6">
          <p className="text-base font-semibold" style={{ color: brandFallback.secondary }}>
            No stay booked yet
          </p>
          <p className="neo-public-copy mt-1 text-sm" style={{ color: brandFallback.steel }}>
            When you book with {ws.hotel_name}, your room, dates and charges appear here.
          </p>
        </section>
      )}

      {/* Services: a scrollable strip on a phone, a grid on a wide screen. */}
      <GuestSection title="What you can do here" description={`Services published by ${ws.hotel_name}.`}>
        <ul className="neo-scroll-x -mx-1 flex gap-3 px-1 lg:mx-0 lg:grid lg:grid-cols-6 lg:px-0">
          {shortcuts.filter((item) => item.key !== "dine" || hasPublishedDining).map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.key} className="w-32 shrink-0 lg:w-auto">
                <Link
                  to={item.to}
                  params={{ hotelSlug }}
                  className="flex h-full min-h-24 flex-col justify-between rounded-2xl border border-black/5 bg-white p-4 transition-shadow hover:shadow-md"
                >
                  <Icon className="size-5" style={{ color: primary }} aria-hidden />
                  <span
                    className="mt-3 block truncate text-sm font-semibold"
                    style={{ color: brandFallback.secondary }}
                  >
                    {item.label}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </GuestSection>

      {user && laterStays.length > 0 ? (
        <GuestSection title="Your upcoming bookings" description="Stays still to come with this hotel.">
          <ul className="grid gap-3 lg:grid-cols-2">
            {laterStays.map((r) => (
              <li key={String(r["id"])} className="min-w-0 rounded-2xl border border-black/5 bg-white p-4">
                <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                      <span data-public-id>{String(r["confirmation_number"])}</span>
                    </p>
                    <p className="text-xs" style={{ color: brandFallback.steel }}>
                      {String(r["arrival_date"])} → {String(r["departure_date"])} ·{" "}
                      {String(r["status"])}
                    </p>
                  </div>
                  <div className="min-w-0 sm:text-right">
                    <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                      {money(r["total_amount"])}
                    </p>
                    <Link
                      to="/guest/$hotelSlug/reservations/$reservationReference"
                      params={{ hotelSlug, reservationReference: String(r["confirmation_number"]) }}
                      className="text-xs font-medium"
                      style={{ color: primary }}
                    >
                      View details
                    </Link>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </GuestSection>
      ) : null}

      {/* Hotels this person already has a guest record with — never a directory advert. */}
      {user && otherHotels.length > 0 ? (
        <GuestSection
          title="Your hotels"
          description="Other properties you have stayed with or hold an account at."
        >
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {otherHotels.map((hotel) => (
              <li
                key={hotel.branch_id}
                className="min-w-0 rounded-2xl border border-black/5 bg-white p-4"
              >
                <p className="truncate text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                  {hotel.display_name ?? hotel.public_slug}
                </p>
                <p className="text-xs" style={{ color: brandFallback.steel }}>
                  {Number(hotel.stays) > 0
                    ? `${hotel.stays} stay(s)${hotel.last_activity ? ` · last ${hotel.last_activity}` : ""}`
                    : "Account only"}
                </p>
                <Link
                  to="/guest/$hotelSlug"
                  params={{ hotelSlug: hotel.public_slug }}
                  className="mt-2 inline-block text-xs font-semibold"
                  style={{ color: primary }}
                >
                  Open
                </Link>
              </li>
            ))}
          </ul>
        </GuestSection>
      ) : null}

      {user && pastStays.length > 0 ? (
        <GuestSection title="Past stays" description="Your completed stays with this hotel.">
          <ul className="grid gap-2">
            {pastStays.slice(0, 5).map((r) => (
              <li
                key={String(r["id"])}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-2xl border border-black/5 bg-white p-4"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                    <span data-public-id>{String(r["confirmation_number"])}</span>
                  </p>
                  <p className="text-xs" style={{ color: brandFallback.steel }}>
                    {String(r["arrival_date"])} → {String(r["departure_date"])}
                  </p>
                </div>
                <span className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                  {money(r["total_amount"])}
                </span>
              </li>
            ))}
          </ul>
        </GuestSection>
      ) : null}


      {ws.contact_phone || ws.contact_email ? (
        <GuestSection title="Talk to the hotel" description="Reception can help with anything not listed here.">
          <div className="flex flex-wrap gap-3" data-public-actions>
            {ws.contact_phone ? (
              <a
                href={`tel:${ws.contact_phone}`}
                className="inline-flex min-h-11 items-center px-4 text-sm font-semibold text-white"
                style={{ background: primary, borderRadius: buttonRadius(ws.button_style) }}
              >
                Call {ws.contact_phone}
              </a>
            ) : null}
            {ws.contact_email ? (
              <a
                href={`mailto:${ws.contact_email}`}
                className="inline-flex min-h-11 items-center border px-4 text-sm font-semibold"
                style={{
                  color: primary,
                  borderColor: primary,
                  borderRadius: buttonRadius(ws.button_style),
                }}
              >
                Email the hotel
              </a>
            ) : null}
          </div>
        </GuestSection>
      ) : null}
    </GuestScreen>
  );
}
