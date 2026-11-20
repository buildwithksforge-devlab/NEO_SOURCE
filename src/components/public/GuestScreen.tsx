import { useGuestDisplayPrefs } from "@/lib/guest-display-preferences";
import { guestPalette } from "@/lib/public-palette";
import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { writeLaunchLockup } from "@/lib/brand-cache";
import { BedDouble, Compass, Home, Receipt, UserRound } from "lucide-react";
import { useWorkspace } from "@/components/public/PublicAppShell";
import { GuestFooter, GuestHeader } from "@/components/public/GuestHeader";
import { brandFallback, buttonRadius } from "@/lib/public-apps";
import { PullToRefresh } from "@/components/common/PullToRefresh";
import { PreviewBanner } from "@/components/public/PreviewBanner";

/** Phone navigation: the five places a guest moves between during a stay. */
const tabs = [
  { key: "home", label: "Home", icon: Home, to: "/guest/$hotelSlug" },
  { key: "explore", label: "Explore", icon: Compass, to: "/guest/$hotelSlug/explore" },
  { key: "orders", label: "Orders", icon: Receipt, to: "/guest/$hotelSlug/orders" },
  { key: "stay", label: "Stay", icon: BedDouble, to: "/guest/$hotelSlug/stay" },
  { key: "profile", label: "Account", icon: UserRound, to: "/guest/$hotelSlug/profile" },
] as const;

export type GuestTab =
  | (typeof tabs)[number]["key"]
  | "book"
  | "laundry"
  | "favourites"
  | "trips"
  | "settings"
  | "notifications"
  | "account";

const tabForScreen: Partial<Record<GuestTab, (typeof tabs)[number]["key"]>> = {
  book: "stay",
  trips: "stay",
  laundry: "explore",
  favourites: "explore",
  settings: "profile",
  notifications: "profile",
  account: "profile",
};

/**
 * The hotel companion shell.
 *
 * Width decides the navigation, not the route: a phone gets a safe-area bottom
 * bar, a laptop gets a real top navigation and the bottom bar disappears
 * entirely. The property's own identity — its logo, name and location — stays
 * in view on every screen.
 */
export function GuestScreen({
  hotelSlug,
  active,
  children,
}: {
  hotelSlug: string;
  active: GuestTab;
  children: ReactNode;
}) {
  const ws = useWorkspace();
  const { prefs } = useGuestDisplayPrefs();
  const primary = ws.primary_color || brandFallback.primary;
  const activeTab = tabForScreen[active] ?? active;
  const scrollFrame = useRef<HTMLDivElement>(null);

  // The launch frame opens on this hotel's own lockup next time, not the
  // neutral default. Only values the property already configured are kept.
  const lockupName = ws.hotel_name || ws.app_name || null;
  const lockupLogo = ws.logo_url || null;
  useEffect(() => {
    if (!lockupName && !lockupLogo) return;
    writeLaunchLockup({
      name: lockupName,
      logo: lockupLogo,
      primary: ws.primary_color ?? null,
      secondary: ws.secondary_color ?? null,
      background: ws.background_color ?? null,
    });
  }, [lockupName, lockupLogo, ws.primary_color, ws.secondary_color, ws.background_color]);

  return (
    <div
      className="neo-public-app neo-guest-app neo-customer-frame flex flex-col"
      data-guest-appearance={prefs.appearance}
      data-reduced-motion={prefs.reducedMotion}
      data-larger-text={prefs.largerText}
      data-high-contrast={prefs.highContrast}
      style={
        {
          ...guestPalette(primary, ws.background_color || brandFallback.background),
          background: "var(--guest-ground)",
          "--pa-primary": primary,
          "--pa-secondary": ws.secondary_color || brandFallback.secondary,
          "--pa-muted": brandFallback.steel,
          "--pa-radius": buttonRadius(ws.button_style),
        } as React.CSSProperties
      }
    >
      <GuestHeader hotelSlug={hotelSlug} active={active} />

      <div ref={scrollFrame} className="neo-customer-content" data-scroll-restoration-id="guest-body">
        <PullToRefresh scrollTarget={() => scrollFrame.current}>
          <main className="neo-public-wrap flex-1 py-5 sm:py-8">
            <PreviewBanner experience="Guest" />
            <div className="min-w-0">{children}</div>
          </main>
        </PullToRefresh>
        <GuestFooter hotelSlug={hotelSlug} />
      </div>

      <nav
        aria-label="Guest app"
        className="neo-app-dock neo-guest-tabbar lg:hidden"
      >
        <ul className="contents">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = tab.key === activeTab;
            return (
              <li key={tab.key}>
                <Link
                  to={tab.to}
                  params={{ hotelSlug }}
                  activeOptions={{ exact: true }}
                  className="min-h-11"
                  aria-current={isActive ? "page" : undefined}
                >
                  <Icon className="size-5" aria-hidden />
                  <span className="w-full text-center">{tab.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

/**
 * A section of the page — a heading with its content, not a floating card.
 * Only genuinely self-contained content gets a surface of its own.
 */
export function GuestSection({
  id,
  title,
  description,
  action,
  children,
  surface = false,
}: {
  id?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  /** Give the section its own panel; off by default so pages have composition. */
  surface?: boolean;
}) {
  return (
    <section id={id} className={surface ? "neo-rider-card mt-6 p-5 sm:p-6" : "mt-8"}>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <h2
            className="text-lg font-semibold tracking-tight"
            style={{ color: "var(--guest-text, #07142D)" }}
          >
            {title}
          </h2>
          {description ? (
            <p
              className="neo-public-copy mt-1 text-sm"
              style={{ color: "var(--guest-muted, #52627A)" }}
            >
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div data-public-actions>{action}</div> : null}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}
