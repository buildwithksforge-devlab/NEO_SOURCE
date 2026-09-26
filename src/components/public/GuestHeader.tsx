/**
 * The Guest app header and footer.
 *
 * The property's own identity leads: its configured logo (never initials when
 * real media exists), its name and its location. The guest always knows which
 * hotel they are in, whether they are signed in, and whether a stay is active.
 */
import { Link, useRouterState } from "@tanstack/react-router";
import {
  BedDouble,
  Bell,
  ChevronDown,
  HelpCircle,
  Heart,
  LifeBuoy,
  LogOut,
  MapPin,
  Repeat,
  Settings,
  UserRound,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { neoSignOut } from "@/lib/session-exit";
import { RefreshButton } from "@/components/common/RefreshButton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PoweredByNeo, PublicCreatorCredit, useWorkspace } from "@/components/public/PublicAppShell";
import { brandFallback, brandInitials, type PublicWorkspace } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import { useGuestActiveStay } from "@/lib/guest-ordering";
import { useGuestProfile } from "@/lib/guest-app";
import { unreadCount, useGuestNotifications } from "@/lib/guest-notifications";

/** Desktop destinations — the wider set a guest moves between. */
export const guestDesktopNav = [
  { key: "home", label: "Home", to: "/guest/$hotelSlug" },
  { key: "book", label: "Stay", to: "/guest/$hotelSlug/book" },
  { key: "explore", label: "Explore", to: "/guest/$hotelSlug/explore" },
  { key: "favourites", label: "Favourites", to: "/guest/$hotelSlug/favourites" },
  { key: "laundry", label: "Services", to: "/guest/$hotelSlug/laundry" },
  { key: "orders", label: "Orders", to: "/guest/$hotelSlug/orders" },
  { key: "stay", label: "My Stay", to: "/guest/$hotelSlug/stay" },
] as const;

/** The hotel's mark: configured media first, a lettered plate only as fallback. */
function PropertyMark({ ws, size = 44 }: { ws: PublicWorkspace; size?: number }) {
  const label = ws.hotel_name || ws.app_name || "Hotel";
  const media = ws.logo_url || ws.icon_url;
  if (media) {
    return (
      <span
        className="grid shrink-0 place-items-center overflow-hidden rounded-xl bg-white/10 ring-1 ring-white/15"
        style={{ width: size, height: size }}
      >
        <img
          src={media}
          alt={`${label} logo`}
          width={size}
          height={size}
          className="size-full object-cover"
          draggable={false}
        />
      </span>
    );
  }
  return (
    <span
      className="grid shrink-0 place-items-center rounded-xl font-semibold text-white ring-1 ring-white/15"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(140deg, ${ws.primary_color || brandFallback.primary}, ${brandFallback.navy})`,
        fontSize: size * 0.34,
      }}
      aria-hidden
    >
      {brandInitials(label)}
    </span>
  );
}

function StayBadge({ tone, children }: { tone: string; children: string }) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 truncate rounded-full px-2.5 py-1 text-[0.68rem] font-semibold"
      style={{ background: `${tone}26`, color: tone }}
    >
      <BedDouble className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{children}</span>
    </span>
  );
}

export function GuestHeader({
  hotelSlug,
  active,
}: {
  hotelSlug: string;
  active: string;
}) {
  const ws = useWorkspace();
  const { user } = useCustomerSession();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const stay = useGuestActiveStay(ws.organization_id, Boolean(user));
  const profile = useGuestProfile(ws.organization_id, user?.id, ws.branch_id);
  const notifications = useGuestNotifications(
    ws.organization_id,
    profile.data?.["id"] as string | undefined,
  );
  const unread = unreadCount(notifications.data);
  const primary = ws.primary_color || brandFallback.primary;
  const name = ws.hotel_name || ws.app_name;
  const displayName =
    (user?.user_metadata?.["full_name"] as string | undefined) || user?.email || "Guest";

  const stayLabel = stay.data
    ? stay.data.room_number
      ? `Checked in · Room ${stay.data.room_number}`
      : "Checked in"
    : null;

  async function signOut() {
    toast.success("Signing out…");
    // One canonical teardown for every entrance: cancel, clear, forget, end.
    await neoSignOut(queryClient, { to: `/guest/${hotelSlug}` });
  }

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-neo-midnight/95 backdrop-blur">
      <div className="neo-public-wrap flex min-w-0 items-center gap-3 py-3">
        <Link
          to="/guest/$hotelSlug"
          params={{ hotelSlug }}
          className="flex min-w-0 items-center gap-3"
        >
          <PropertyMark ws={ws} />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm font-semibold text-white sm:text-base">{name}</span>
            <span className="flex min-w-0 items-center gap-1 text-[0.7rem] text-white/75">
              {ws.contact_address ? (
                <>
                  <MapPin className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">{ws.contact_address}</span>
                </>
              ) : (
                <span className="truncate uppercase tracking-[0.18em]">Guest</span>
              )}
            </span>
          </span>
        </Link>

        <nav aria-label="Guest navigation" className="ml-auto hidden items-center gap-1 lg:flex">
          {guestDesktopNav.map((entry) => {
            const isActive = entry.key === active;
            return (
              <Link
                key={entry.key}
                to={entry.to}
                params={{ hotelSlug }}
                aria-current={isActive ? "page" : undefined}
                className="min-h-9 rounded-full px-3 py-1.5 text-sm font-medium transition-colors"
                style={{
                  color: isActive ? "#ffffff" : "rgba(255,255,255,0.62)",
                  background: isActive ? `${primary}33` : "transparent",
                }}
              >
                {entry.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2 lg:ml-2">
          {stayLabel ? (
            <span className="hidden sm:inline-flex">
              <StayBadge tone={primary}>{stayLabel}</StayBadge>
            </span>
          ) : null}

          {/* Desk and keyboard guests get the same refresh the swipe-down
              gesture gives a phone. */}
          <RefreshButton className="hidden size-10 place-items-center rounded-full border border-white/12 text-white/70 hover:text-white md:grid" />

          {user ? (
            <Link
              to="/guest/$hotelSlug/notifications"
              params={{ hotelSlug }}
              aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
              className="relative grid size-10 place-items-center rounded-full border border-white/12 text-white/70 hover:text-white"
            >
              <Bell className="size-4" aria-hidden />
              {unread > 0 ? (
                <span
                  className="absolute -right-0.5 -top-0.5 grid min-h-4 min-w-4 place-items-center rounded-full px-1 text-[0.6rem] font-bold text-white"
                  style={{ background: primary }}
                >
                  {unread > 9 ? "9+" : unread}
                </span>
              ) : null}
            </Link>
          ) : null}

          <Link
            to="/guest/$hotelSlug/settings"
            params={{ hotelSlug }}
            aria-label="Help and settings"
            className="hidden size-10 place-items-center rounded-full border border-white/12 text-white/70 hover:text-white sm:grid"
          >
            <HelpCircle className="size-4" aria-hidden />
          </Link>

          {user ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                className="inline-flex min-h-10 items-center gap-2 rounded-full border border-white/12 px-2.5 text-sm text-white/85"
                aria-label="Profile menu"
              >
                <span
                  className="grid size-6 shrink-0 place-items-center rounded-full text-[0.65rem] font-semibold text-white"
                  style={{ background: primary }}
                  aria-hidden
                >
                  {brandInitials(displayName)}
                </span>
                <ChevronDown className="size-3.5 opacity-70" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel className="space-y-1">
                  <span className="block truncate text-sm font-semibold">{displayName}</span>
                  <span className="block truncate text-xs font-normal text-muted-foreground">
                    {name}
                  </span>
                  {stayLabel ? (
                    <span className="block text-xs font-normal" style={{ color: primary }}>
                      {stayLabel}
                    </span>
                  ) : null}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/guest/$hotelSlug/profile" params={{ hotelSlug }}>
                    <UserRound className="size-4" aria-hidden /> View profile
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/guest/$hotelSlug/favourites" params={{ hotelSlug }}>
                    <Heart className="size-4" aria-hidden /> Favourites
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/guest/$hotelSlug/settings" params={{ hotelSlug }}>
                    <Settings className="size-4" aria-hidden /> Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/guest/$hotelSlug/stay" params={{ hotelSlug }}>
                    <BedDouble className="size-4" aria-hidden /> My Stay
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/guest/$hotelSlug/settings" params={{ hotelSlug }} hash="help">
                    <LifeBuoy className="size-4" aria-hidden /> Help &amp; contact
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <a href="/continue?choose=1">
                    <Repeat className="size-4" aria-hidden /> Switch context
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void neoSignOut(queryClient, { to: "/auth" })}>
                  <UserRound className="size-4" aria-hidden /> Switch account
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void signOut()}>
                  <LogOut className="size-4" aria-hidden /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Link
              to="/guest/$hotelSlug/signin"
              params={{ hotelSlug }}
              search={{ next: pathname, mode: undefined }}
              className="inline-flex min-h-10 items-center gap-2 rounded-full px-4 text-sm font-semibold text-white"
              style={{ background: primary }}
            >
              <UserRound className="size-4" aria-hidden /> Sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}

/** Designed guest footer: hotel contact, the legal set, and attribution. */
export function GuestFooter({ hotelSlug }: { hotelSlug: string }) {
  const ws = useWorkspace();
  const name = ws.hotel_name || ws.app_name;

  const legal = [
    { label: "Privacy", hash: "privacy" },
    { label: "Terms", hash: "terms" },
    { label: "Accessibility", hash: "accessibility" },
    { label: "Help & support", hash: "help" },
  ];

  return (
    <footer className="mt-12 border-t border-white/10 bg-neo-midnight pb-[max(env(safe-area-inset-bottom),0px)] text-white">
      <div className="neo-public-wrap grid gap-8 py-10 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-3">
            <PropertyMark ws={ws} size={40} />
            <span className="truncate text-sm font-semibold">{name}</span>
          </div>
          <p className="neo-public-copy mt-3 max-w-sm text-sm text-white/75">
            {ws.welcome_message || "Your stay, dining, services and bill in one place."}
          </p>
        </div>

        <div className="min-w-0 text-sm text-white/80">
          <h2 className="text-xs uppercase tracking-[0.2em] text-white/70">Contact</h2>
          <ul className="mt-3 space-y-1.5">
            {ws.contact_phone ? <li className="truncate">{ws.contact_phone}</li> : null}
            {ws.contact_email ? <li className="truncate">{ws.contact_email}</li> : null}
            {ws.contact_address ? <li className="neo-public-copy">{ws.contact_address}</li> : null}
            {!ws.contact_phone && !ws.contact_email && !ws.contact_address ? (
              <li>The hotel has not published contact details yet.</li>
            ) : null}
          </ul>
        </div>

        <div className="min-w-0 text-sm text-white/80">
          <h2 className="text-xs uppercase tracking-[0.2em] text-white/70">Information</h2>
          <ul className="mt-3 space-y-1.5">
            {legal.map((entry) => (
              <li key={entry.hash}>
                <Link
                  to="/guest/$hotelSlug/settings"
                  params={{ hotelSlug }}
                  hash={entry.hash}
                  className="hover:text-white"
                >
                  {entry.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="neo-public-wrap flex flex-col gap-3 border-t border-white/10 py-6 sm:flex-row sm:items-center sm:justify-between">
        <PoweredByNeo tone="light" />
        <PublicCreatorCredit />
      </div>
    </footer>
  );
}
