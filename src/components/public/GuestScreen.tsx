import { useEffect, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
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
  { key: "stay", label: "My Stay", icon: BedDouble, to: "/guest/$hotelSlug/stay" },
  { key: "profile", label: "Profile", icon: UserRound, to: "/guest/$hotelSlug/profile" },
] as const;

export type GuestTab =
  | (typeof tabs)[number]["key"]
  | "book"
  | "laundry"
  | "trips"
  | "settings"
  | "notifications"
  | "account";

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
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const primary = ws.primary_color || brandFallback.primary;

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
      className="neo-public-app flex min-h-screen flex-col"
      style={
        {
          background: ws.background_color || brandFallback.background,
          "--pa-primary": primary,
          "--pa-secondary": ws.secondary_color || brandFallback.secondary,
          "--pa-muted": brandFallback.steel,
          "--pa-radius": buttonRadius(ws.button_style),
        } as React.CSSProperties
      }
    >
      <GuestHeader hotelSlug={hotelSlug} active={active} />

      <PullToRefresh>
      <main className="neo-public-wrap flex-1 py-6 sm:py-9">
        <PreviewBanner experience="Guest" />
        <div className="min-w-0 pb-24 lg:pb-4">{children}</div>
      </main>
      </PullToRefresh>

      <GuestFooter hotelSlug={hotelSlug} />

      <nav
        aria-label="Guest app"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-neo-midnight/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      >
        <ul className="mx-auto flex w-full max-w-5xl">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive =
              tab.key === active ||
              (tab.key !== "home" && pathname.endsWith(`/${tab.key}`));
            return (
              <li key={tab.key} className="flex-1">
                <Link
                  to={tab.to}
                  params={{ hotelSlug }}
                  aria-current={isActive ? "page" : undefined}
                  className="flex min-h-11 min-w-0 flex-col items-center justify-center gap-1 px-1 py-2.5 text-[0.68rem] font-medium"
                  style={{ color: isActive ? primary : "rgba(255,255,255,0.58)" }}
                >
                  <Icon className="size-5" aria-hidden />
                  <span className="w-full truncate text-center">{tab.label}</span>
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
  title,
  description,
  action,
  children,
  surface = false,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  /** Give the section its own panel; off by default so pages have composition. */
  surface?: boolean;
}) {
  return (
    <section className={surface ? "neo-rider-card mt-6 p-5 sm:p-6" : "mt-8"}>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <h2
            className="text-lg font-semibold tracking-tight"
            style={{ color: brandFallback.secondary }}
          >
            {title}
          </h2>
          {description ? (
            <p className="neo-public-copy mt-1 text-sm" style={{ color: brandFallback.steel }}>
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
