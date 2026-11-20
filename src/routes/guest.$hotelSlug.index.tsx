import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, BedDouble, Bike, ChevronRight, ConciergeBell, MapPin, Receipt, Shirt, UtensilsCrossed } from "lucide-react";
import { GuestImage } from "@/components/public/GuestImage";
import { GuestScreen, GuestSection } from "@/components/public/GuestScreen";
import { GuestCardsSkeleton } from "@/components/public/GuestSkeleton";
import { PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { useGuestProfile, useGuestReservations, useGuestScreenView } from "@/lib/guest-app";
import { useGuestActiveStay } from "@/lib/guest-ordering";
import { useMyGuestHotels } from "@/lib/guest-notifications";
import { guestDisplayName, orderBucket } from "@/lib/guest-presentation";
import { money, statusLabel, useMyPublicOrders } from "@/lib/public-delivery";
import { useCustomerSession } from "@/lib/public-session";
import { canonicalLink, canonicalUrl, robotsDirective } from "@/lib/route-visibility";

export const Route = createFileRoute("/guest/$hotelSlug/")({
  head: ({ params }) => ({
    meta: [
      { title: "Your stay — NEØ Guest" },
      { name: "description", content: "Book a room, order from the kitchen and get help during your stay." },
      { property: "og:title", content: "Your stay — NEØ Guest" },
      { property: "og:description", content: "Book, dine and use the hotel's services from one place." },
      { property: "og:type", content: "website" },
      { property: "og:url", content: canonicalUrl(`/guest/${params.hotelSlug}`) },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: robotsDirective(`/guest/${params.hotelSlug}`) },
    ],
    links: [canonicalLink(`/guest/${params.hotelSlug}`)],
  }),
  component: GuestHome,
});

function GuestHome() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { user, loading } = useCustomerSession();
  const profile = useGuestProfile(ws.organization_id, user?.id, ws.branch_id);
  const customerId = profile.data?.["id"] as string | undefined;
  const reservations = useGuestReservations(ws.organization_id, customerId, ws.branch_id);
  const orders = useMyPublicOrders(ws.organization_id, customerId, ws.branch_id);
  const stay = useGuestActiveStay(ws.organization_id, ws.branch_id, user?.id);
  const hotels = useMyGuestHotels(Boolean(user));
  useGuestScreenView(ws.organization_id, "home", Boolean(customerId));

  const firstName = guestDisplayName(profile.data, user?.user_metadata)?.split(/\s+/)[0];
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const bookings = (reservations.data ?? [])
    .filter((row) => !["cancelled", "no-show", "no_show"].includes(String(row["status"])))
    .sort((a, b) => String(a["arrival_date"]).localeCompare(String(b["arrival_date"])));
  const nextBooking = bookings.find((row) => String(row["departure_date"] ?? "") >= today);
  const activeOrder = orders.data?.find((row) =>
    orderBucket(row["order_status"], row["scheduled_for"], row["fulfilment_type"]) === "active",
  );
  const otherHotels = (hotels.data ?? []).filter((hotel) =>
    hotel.branch_id !== ws.branch_id && hotel.public_slug !== hotelSlug && hotel.public_slug,
  );
  const activityLoading = Boolean(user) && (profile.isLoading || stay.isLoading || reservations.isLoading || orders.isLoading);
  const activityError = profile.isError || stay.isError || reservations.isError || orders.isError;

  return (
    <GuestScreen hotelSlug={hotelSlug} active="home">
      <div className="neo-guest-home">
        <section className="neo-guest-entry">
          <div className="neo-guest-entry-copy">
            <p className="neo-guest-location"><MapPin size={16} aria-hidden />{ws.hotel_name}</p>
            <h1>{firstName ? `Welcome, ${firstName}` : "Make yourself at home"}</h1>
            {ws.contact_address ? <p className="neo-guest-address">{ws.contact_address}</p> : null}
          </div>
          {ws.hero_url || ws.icon_url ? (
            <GuestImage src={ws.hero_url || ws.icon_url} alt="" width={480} height={440}
              priority sizes="(min-width: 640px) 340px, 38vw" className="neo-guest-entry-image" />
          ) : <div className="neo-guest-entry-art" aria-hidden><ConciergeBell /></div>}
        </section>

        {activityLoading ? <div className="mt-4"><GuestCardsSkeleton cards={1} label="Loading your activity" /></div> : null}
        {activityError ? (
          <div className="mt-4"><PublicEmptyState title="Some activity couldn’t load" description="Try again to refresh your stay and orders."
            action={<button type="button" className="neo-guest-secondary" onClick={() => {
              if (profile.isError) void profile.refetch();
              if (stay.isError) void stay.refetch();
              if (reservations.isError) void reservations.refetch();
              if (orders.isError) void orders.refetch();
            }}>Refresh activity</button>} /></div>
        ) : null}
        {activeOrder ? (
          <Link className="neo-guest-current" to="/guest/$hotelSlug/orders/$orderReference"
            params={{ hotelSlug, orderReference: String(activeOrder["order_number"]) }}>
            <span className="neo-guest-current-icon"><Receipt aria-hidden /></span>
            <span><strong>Track your order</strong><small>{statusLabel(activeOrder["order_status"])} · {String(activeOrder["order_number"])}</small></span>
            <ChevronRight aria-hidden />
          </Link>
        ) : stay.data ? (
          <Link className="neo-guest-current" to="/guest/$hotelSlug/stay" params={{ hotelSlug }}>
            <span className="neo-guest-current-icon"><BedDouble aria-hidden /></span>
            <span><strong>{stay.data.room_number ? `Room ${stay.data.room_number}` : "Your stay"}</strong><small>Checked in · {stay.data.departure_date}</small></span>
            <ChevronRight aria-hidden />
          </Link>
        ) : nextBooking ? (
          <Link className="neo-guest-current" to="/guest/$hotelSlug/reservations/$reservationReference"
            params={{ hotelSlug, reservationReference: String(nextBooking["confirmation_number"]) }}>
            <span className="neo-guest-current-icon"><BedDouble aria-hidden /></span>
            <span><strong>View your booking</strong><small>{String(nextBooking["arrival_date"])} → {String(nextBooking["departure_date"])}</small></span>
            <ChevronRight aria-hidden />
          </Link>
        ) : (
          <Link className="neo-guest-current" to="/guest/$hotelSlug/book" params={{ hotelSlug }}>
            <span className="neo-guest-current-icon"><BedDouble aria-hidden /></span>
            <span><strong>Find a room</strong><small>Choose dates to check availability</small></span>
            <ArrowRight aria-hidden />
          </Link>
        )}

        <section className="neo-guest-shortcut-section" aria-labelledby="guest-shortcuts">
          <h2 id="guest-shortcuts">At the hotel</h2>
          <div className="neo-guest-shortcuts">
            <Link to="/guest/$hotelSlug/explore" params={{ hotelSlug }} search={{ section: "dining" }}>
              <UtensilsCrossed aria-hidden /><strong>Dining</strong><small>See the menu</small>
            </Link>
            <Link to="/guest/$hotelSlug/transport" params={{ hotelSlug }}>
              <Bike aria-hidden /><strong>Transfers</strong><small>Plan a pickup</small>
            </Link>
            <Link to="/guest/$hotelSlug/trips" params={{ hotelSlug }}>
              <ConciergeBell aria-hidden /><strong>Requests</strong><small>Ask the hotel</small>
            </Link>
            <Link to="/guest/$hotelSlug/laundry" params={{ hotelSlug }}>
              <Shirt aria-hidden /><strong>Laundry</strong><small>See services</small>
            </Link>
          </div>
        </section>

        <section className="neo-guest-shortcut-section" aria-labelledby="guest-activity">
          <h2 id="guest-activity">Your activity</h2>
          <div className="neo-guest-activity">
            <Link to="/guest/$hotelSlug/stay" params={{ hotelSlug }}><BedDouble aria-hidden /><span>Your bookings</span><ChevronRight aria-hidden /></Link>
            <Link to="/guest/$hotelSlug/orders" params={{ hotelSlug }}><Receipt aria-hidden /><span>Orders and tracking</span><ChevronRight aria-hidden /></Link>
            {stay.data?.folio_id ? (
              <Link to="/guest/$hotelSlug/folio" params={{ hotelSlug }}>
                <Receipt aria-hidden /><span>Room charges</span>
                <strong>{money(stay.data.folio_balance ?? 0, ws.currency ?? "KES")}</strong>
              </Link>
            ) : null}
            {!loading && !user ? (
              <Link to="/guest/$hotelSlug/signin" params={{ hotelSlug }} search={{ next: undefined, mode: undefined }}>
                <BedDouble aria-hidden /><span>Sign in to see your activity</span><ChevronRight aria-hidden />
              </Link>
            ) : null}
          </div>
        </section>

        <GuestSection title="Properties">
          <div className="neo-guest-activity">
            {otherHotels.map((hotel) => (
              <Link key={hotel.branch_id} to="/guest/$hotelSlug" params={{ hotelSlug: hotel.public_slug }}>
                <MapPin aria-hidden /><span>{hotel.display_name || hotel.public_slug}</span><ChevronRight aria-hidden />
              </Link>
            ))}
            <Link to="/"><MapPin aria-hidden /><span>Find another property</span><ChevronRight aria-hidden /></Link>
          </div>
        </GuestSection>
      </div>
    </GuestScreen>
  );
}
