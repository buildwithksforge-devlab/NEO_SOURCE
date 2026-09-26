import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BedDouble, Loader2, Receipt, Shirt, Sparkles, Car, Heart } from "lucide-react";
import { toast } from "sonner";
import { GuestScreen, GuestSection } from "@/components/public/GuestScreen";
import { BrandButton, PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AvatarUploader } from "@/components/common/AvatarDisplay";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import {
  useGuestAddresses,
  useGuestProfile,
  useGuestRequests,
  useGuestReservations,
  useGuestScreenView,
  useUpdateGuestProfile,
} from "@/lib/guest-app";
import { useGuestActiveStay } from "@/lib/guest-ordering";

export const Route = createFileRoute("/guest/$hotelSlug/profile")({
  head: () => ({
    meta: [
      { title: "My profile — NEØ Guest" },
      { name: "description", content: "Your guest profile, hotel relationships, stays and service history." },
      { property: "og:title", content: "My profile — NEØ Guest" },
      { property: "og:description", content: "Your guest profile, hotel relationships, stays and service history." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: ProfilePage,
});

const dateLabel = (value: unknown) =>
  value ? new Date(String(value)).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—";

function ProfilePage() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { user, loading } = useCustomerSession();
  const profile = useGuestProfile(ws.organization_id, user?.id, ws.branch_id);
  const customer = profile.data;
  const customerId = customer?.["id"] as string | undefined;
  const reservations = useGuestReservations(ws.organization_id, customerId);
  const requests = useGuestRequests(ws.organization_id, customerId);
  const addresses = useGuestAddresses(ws.organization_id, customerId);
  const stay = useGuestActiveStay(ws.organization_id, Boolean(user));
  const update = useUpdateGuestProfile(ws.organization_id);
  useGuestScreenView(ws.organization_id, "profile", Boolean(customerId));

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");

  useEffect(() => {
    setFullName(String(customer?.["full_name"] ?? ""));
    setPhone(String(customer?.["phone"] ?? ""));
  }, [customer]);

  const grouped = useMemo(() => {
    const rows = reservations.data ?? [];
    const today = new Date().toISOString().slice(0, 10);
    return {
      upcoming: rows.filter((r) => String(r["arrival_date"] ?? "") >= today && String(r["status"]) !== "cancelled"),
      past: rows.filter((r) => String(r["departure_date"] ?? "") < today && String(r["status"]) !== "cancelled"),
      cancelled: rows.filter((r) => String(r["status"]) === "cancelled"),
    };
  }, [reservations.data]);

  if (!loading && !user) {
    return (
      <GuestScreen hotelSlug={hotelSlug} active="profile">
        <GuestSignInPrompt
          hotelSlug={hotelSlug}
          title="Sign in to your profile"
          description="Your details, stays, orders, bills and service history stay private to you."
        />
      </GuestScreen>
    );
  }

  if (profile.isLoading) {
    return (
      <GuestScreen hotelSlug={hotelSlug} active="profile">
        <div className="flex justify-center py-16">
          <Loader2 className="size-5 animate-spin" style={{ color: brandFallback.steel }} />
        </div>
      </GuestScreen>
    );
  }

  if (!customer) {
    return (
      <GuestScreen hotelSlug={hotelSlug} active="profile">
        <GuestSection title="No guest profile yet">
          <PublicEmptyState
            title="Your account is not linked to this hotel"
            description="Complete a booking or ask reception to invite you — your profile will link to your existing record, never a duplicate."
          />
        </GuestSection>
      </GuestScreen>
    );
  }

  async function save() {
    try {
      await update.mutateAsync({ fullName, phone });
      toast.success("Profile updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save your profile");
    }
  }

  const primary = ws.primary_color || brandFallback.primary;
  const stayRow = stay.data;

  return (
    <GuestScreen hotelSlug={hotelSlug} active="profile">
      {/* Overview: an identity band, not a white card. */}
      <section
        className="grid min-w-0 gap-5 rounded-3xl p-6 text-white sm:grid-cols-[auto_minmax(0,1fr)] sm:p-8"
        style={{ background: `linear-gradient(135deg, ${brandFallback.navy}, ${primary}55)` }}
      >
        <AvatarUploader
          path={(customer["avatar_url"] as string | null) ?? null}
          name={String(customer["full_name"] ?? "")}
          onChange={async (next) => {
            await update.mutateAsync({ avatarUrl: next });
          }}
        />
        <div className="min-w-0">
          <h1 className="neo-line-2 text-2xl font-semibold tracking-tight">
            {String(customer["full_name"] ?? "Guest")}
          </h1>
          <p className="mt-1 truncate text-sm text-white/70">
            {String(customer["email"] ?? "—")}
            {customer["phone"] ? ` · ${String(customer["phone"])}` : ""}
          </p>
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-white/12 px-3 py-1">
              Guest {String(customer["customer_number"] ?? "—")}
            </span>
            <span className="rounded-full bg-white/12 px-3 py-1">
              {String(customer["guest_account_status"] ?? "active")}
            </span>
            <span className="rounded-full bg-white/12 px-3 py-1 truncate">{ws.hotel_name}</span>
            {stayRow ? (
              <span className="rounded-full bg-white px-3 py-1 font-semibold" style={{ color: brandFallback.navy }}>
                {stayRow.room_number ? `Checked in · Room ${stayRow.room_number}` : "Checked in"}
              </span>
            ) : null}
          </div>
        </div>
      </section>

      <GuestSection title="My hotel" description="Only relationships this hotel's records actually hold.">
        <ul className="grid min-w-0 gap-2 sm:grid-cols-2">
          <li className="neo-rider-card p-4">
            <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
              {ws.hotel_name}
            </p>
            <p className="text-xs" style={{ color: brandFallback.steel }}>
              {stayRow
                ? `Staying now · ${dateLabel(stayRow.arrival_date)} – ${dateLabel(stayRow.departure_date)}`
                : grouped.upcoming.length > 0
                  ? `Arriving ${dateLabel(grouped.upcoming[0]?.["arrival_date"])}`
                  : grouped.past.length > 0
                    ? `Last stayed ${dateLabel(grouped.past[0]?.["departure_date"])}`
                    : "No stay recorded yet"}
            </p>
          </li>
          <li className="neo-rider-card p-4">
            <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
              Loyalty
            </p>
            <p className="text-xs" style={{ color: brandFallback.steel }}>
              This hotel has not published a loyalty programme in your account yet.
            </p>
          </li>
        </ul>
      </GuestSection>

      <GuestSection title="Stays" description="Upcoming, completed and cancelled bookings, by their own reference.">
        {(reservations.data?.length ?? 0) === 0 ? (
          <PublicEmptyState
            title="No bookings yet"
            description="Your reservations appear here as soon as one is made."
            action={
              <Link to="/guest/$hotelSlug/book" params={{ hotelSlug }}>
                <BrandButton>Book a stay</BrandButton>
              </Link>
            }
          />
        ) : (
          <div className="space-y-5">
            {([
              ["Upcoming", grouped.upcoming],
              ["Completed", grouped.past],
              ["Cancelled", grouped.cancelled],
            ] as const).map(([label, rows]) =>
              rows.length === 0 ? null : (
                <div key={label} className="min-w-0">
                  <h3 className="text-xs uppercase tracking-[0.18em]" style={{ color: brandFallback.steel }}>
                    {label}
                  </h3>
                  <ul className="mt-2 space-y-2">
                    {rows.map((row) => (
                      <li
                        key={String(row["id"])}
                        className="grid min-w-0 gap-1 rounded-xl border border-black/5 bg-white p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                            {String(row["confirmation_number"] ?? "Reservation")}
                          </p>
                          <p className="truncate text-xs" style={{ color: brandFallback.steel }}>
                            {dateLabel(row["arrival_date"])} – {dateLabel(row["departure_date"])} ·{" "}
                            {String(row["nights"] ?? "—")} night(s)
                          </p>
                        </div>
                        <Link
                          to="/guest/$hotelSlug/reservations/$reservationReference"
                          params={{ hotelSlug, reservationReference: String(row["confirmation_number"] ?? "") }}
                          className="text-sm font-semibold"
                          style={{ color: primary }}
                        >
                          View
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ),
            )}
          </div>
        )}
      </GuestSection>

      <GuestSection title="Orders & services" description="Everything you have asked this hotel for.">
        <nav className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-label="Service history">
          {[
            { to: "/guest/$hotelSlug/orders", label: "Orders", detail: "Dining, room service and delivery", icon: Receipt },
            { to: "/guest/$hotelSlug/trips", label: "Stays & requests", detail: `${requests.data?.length ?? 0} request(s) recorded`, icon: BedDouble },
            { to: "/guest/$hotelSlug/laundry", label: "Laundry", detail: "Price list and progress", icon: Shirt },
            { to: "/guest/$hotelSlug/transport", label: "Transport", detail: "Transfers and bookings", icon: Car },
            { to: "/guest/$hotelSlug/folio", label: "Bills & receipts", detail: "Your folio and confirmed payments", icon: Sparkles },
            { to: "/guest/$hotelSlug/explore", label: "Saved dishes", detail: "Favourites and the live menu", icon: Heart },
          ].map((entry) => {
            const Icon = entry.icon;
            return (
              <Link key={entry.to} to={entry.to} params={{ hotelSlug }} className="neo-rider-card flex min-w-0 items-start gap-3 p-4">
                <Icon className="mt-0.5 size-4 shrink-0" style={{ color: primary }} aria-hidden />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                    {entry.label}
                  </span>
                  <span className="neo-line-2 block text-xs" style={{ color: brandFallback.steel }}>
                    {entry.detail}
                  </span>
                </span>
              </Link>
            );
          })}
        </nav>
      </GuestSection>

      <GuestSection title="Personal information" description="Only what this hotel needs to look after you.">
        <div className="max-w-md space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="profile-name">Full name</Label>
            <Input id="profile-name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="profile-phone">Phone</Label>
            <Input id="profile-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Email</Label>
            <p className="text-sm" style={{ color: brandFallback.steel }}>
              {String(customer["email"] ?? "—")} — your verified sign-in address. Change it in Settings.
            </p>
          </div>
          <BrandButton onClick={() => void save()} disabled={update.isPending || !fullName.trim()}>
            {update.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save changes
          </BrandButton>
        </div>
      </GuestSection>

      <GuestSection title="Saved addresses" description="Used for delivery only.">
        {(addresses.data?.length ?? 0) === 0 ? (
          <PublicEmptyState title="No saved addresses" description="Addresses you use for delivery are saved here." />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {(addresses.data ?? []).map((a) => (
              <li key={String(a["id"])} className="rounded-xl border border-black/5 bg-white p-3 text-sm">
                <span className="font-medium" style={{ color: brandFallback.secondary }}>
                  {String(a["label"] ?? "Address")}
                </span>
                <span className="block text-xs" style={{ color: brandFallback.steel }}>
                  {String(a["address_line"] ?? "")} {String(a["city"] ?? "")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </GuestSection>
    </GuestScreen>
  );
}
