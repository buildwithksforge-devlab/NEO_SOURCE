/**
 * Guest notifications.
 *
 * Every entry was written by the hotel's own systems when something happened —
 * a booking confirmed, a room made ready, an order accepted, laundry collected.
 * The guest can mark them read; nothing on this screen is generated locally.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { BedDouble, Bell, Receipt, Shirt } from "lucide-react";
import { GuestScreen } from "@/components/public/GuestScreen";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { GuestRowsSkeleton } from "@/components/public/GuestSkeleton";
import { PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { brandFallback, buttonRadius } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import { useGuestProfile } from "@/lib/guest-app";
import {
  guestNotificationCategoryLabel,
  guestNotificationTarget,
  unreadCount,
  useGuestNotifications,
  useMarkGuestNotifications,
  type GuestNotification,
} from "@/lib/guest-notifications";

export const Route = createFileRoute("/guest/$hotelSlug/notifications")({
  head: () => ({
    meta: [
      { title: "Notifications — NEØ Guest" },
      { name: "description", content: "Booking, order and laundry updates for your stay." },
      { name: "robots", content: "noindex" },
      { property: "og:title", content: "Notifications — NEØ Guest" },
      { property: "og:description", content: "Booking, order and laundry updates for your stay." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: NotificationsPage,
});

function CategoryIcon({ category, tint }: { category: string; tint: string }) {
  const Icon = category === "order" ? Receipt : category === "laundry" ? Shirt : BedDouble;
  return (
    <span
      className="grid size-9 shrink-0 place-items-center rounded-full"
      style={{ background: `${tint}1f`, color: tint }}
      aria-hidden
    >
      <Icon className="size-4" />
    </span>
  );
}

function TargetLink({
  row,
  hotelSlug,
  tint,
}: {
  row: GuestNotification;
  hotelSlug: string;
  tint: string;
}) {
  const target = guestNotificationTarget(row.link);
  if (!target) return null;
  const className = "text-xs font-semibold";
  const style = { color: tint };
  if (target.kind === "order") {
    return (
      <Link
        to="/guest/$hotelSlug/orders/$orderReference"
        params={{ hotelSlug, orderReference: target.reference }}
        className={className}
        style={style}
      >
        View order
      </Link>
    );
  }
  if (target.kind === "reservation") {
    return (
      <Link
        to="/guest/$hotelSlug/reservations/$reservationReference"
        params={{ hotelSlug, reservationReference: target.reference }}
        className={className}
        style={style}
      >
        View booking
      </Link>
    );
  }
  if (target.kind === "orders") {
    return (
      <Link to="/guest/$hotelSlug/orders" params={{ hotelSlug }} className={className} style={style}>
        View orders
      </Link>
    );
  }
  if (target.kind === "laundry") {
    return (
      <Link to="/guest/$hotelSlug/laundry" params={{ hotelSlug }} className={className} style={style}>
        View laundry
      </Link>
    );
  }
  return (
    <Link to="/guest/$hotelSlug/trips" params={{ hotelSlug }} className={className} style={style}>
      View requests
    </Link>
  );
}

function NotificationsPage() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { user, loading } = useCustomerSession();
  const profile = useGuestProfile(ws.organization_id, user?.id, ws.branch_id);
  const customerId = profile.data?.["id"] as string | undefined;
  const notifications = useGuestNotifications(ws.organization_id, customerId);
  const mark = useMarkGuestNotifications(ws.organization_id, customerId);
  const primary = ws.primary_color || brandFallback.primary;
  const rows = notifications.data ?? [];
  const unread = unreadCount(rows);

  return (
    <GuestScreen hotelSlug={hotelSlug} active="notifications">
      <section className="grid min-w-0 items-end gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <h1 className="neo-pub-display text-3xl sm:text-4xl" style={{ color: brandFallback.secondary }}>
            Notifications
          </h1>
          <p className="neo-public-copy mt-2 max-w-xl text-sm" style={{ color: brandFallback.steel }}>
            {unread > 0
              ? `${unread} update${unread === 1 ? "" : "s"} you have not read yet.`
              : `Updates from ${ws.hotel_name} about your bookings, orders and laundry.`}
          </p>
        </div>
        {unread > 0 ? (
          <div data-public-actions>
            <button
              type="button"
              onClick={() => mark.mutate(rows.filter((row) => !row.read_at).map((row) => row.id))}
              disabled={mark.isPending}
              className="inline-flex min-h-11 items-center border px-5 text-sm font-semibold disabled:opacity-60"
              style={{
                color: primary,
                borderColor: primary,
                borderRadius: buttonRadius(ws.button_style),
              }}
            >
              Mark all read
            </button>
          </div>
        ) : null}
      </section>

      {!loading && !user ? (
        <GuestSignInPrompt
          hotelSlug={hotelSlug}
          title="Sign in to see your updates"
          description="Booking, order and laundry updates are private to your account."
        />
      ) : notifications.isLoading ? (
        <div className="mt-6">
          <GuestRowsSkeleton rows={4} label="Loading your updates" />
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-6">
          <PublicEmptyState
            title="Nothing to read yet"
            description="When a booking is confirmed, your room is ready, an order is accepted or laundry is collected, it appears here."
          />
        </div>
      ) : (
        <ul className="mt-6 grid gap-3">
          {rows.map((row) => (
            <li
              key={row.id}
              className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-2xl border bg-white p-4"
              style={{
                borderColor: row.read_at ? "rgba(0,0,0,0.06)" : `${primary}59`,
              }}
            >
              <CategoryIcon category={row.category} tint={primary} />
              <div className="min-w-0">
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                  <p className="min-w-0 text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                    {row.title}
                  </p>
                  <span className="shrink-0 text-[0.68rem]" style={{ color: brandFallback.steel }}>
                    {new Date(row.created_at).toLocaleString()}
                  </span>
                </div>
                {row.body ? (
                  <p className="neo-public-copy mt-1 text-sm" style={{ color: brandFallback.steel }}>
                    {row.body}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <span
                    className="rounded-full px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.14em]"
                    style={{ background: `${primary}14`, color: primary }}
                  >
                    {guestNotificationCategoryLabel(row.category)}
                  </span>
                  <TargetLink row={row} hotelSlug={hotelSlug} tint={primary} />
                  {row.read_at ? null : (
                    <button
                      type="button"
                      onClick={() => mark.mutate([row.id])}
                      className="text-xs font-medium"
                      style={{ color: brandFallback.steel }}
                    >
                      Mark read
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </GuestScreen>
  );
}
