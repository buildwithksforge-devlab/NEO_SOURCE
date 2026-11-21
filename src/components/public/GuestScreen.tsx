import { useGuestDisplayPrefs } from "@/lib/guest-display-preferences";
import { guestPalette } from "@/lib/public-palette";
import { useEffect, useRef, type ReactNode } from "react";
import { writeLaunchLockup } from "@/lib/brand-cache";
import { useWorkspace } from "@/components/public/PublicAppShell";
import { GuestFooter, GuestHeader } from "@/components/public/GuestHeader";
import { GuestNavigation, type GuestDestination } from "@/components/public/GuestNavigation";
import { brandFallback, buttonRadius } from "@/lib/public-apps";
import { PullToRefresh } from "@/components/common/PullToRefresh";
import { PreviewBanner } from "@/components/public/PreviewBanner";

export type GuestTab =
  | GuestDestination
  | "profile"
  | "book"
  | "laundry"
  | "favourites"
  | "trips"
  | "settings"
  | "notifications"
  | "account";

const tabForScreen: Record<GuestTab, GuestDestination | undefined> = {
  home: "home",
  explore: "explore",
  orders: "orders",
  stay: "stay",
  book: "stay",
  trips: "stay",
  laundry: "explore",
  favourites: "explore",
  settings: undefined,
  notifications: undefined,
  profile: undefined,
  account: undefined,
};

/**
 * The hotel companion shell.
 *
 * One set of destinations sits in the safe-area dock on phones and below
 * the property header on wider screens.
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
  const activeTab = tabForScreen[active];
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
      <GuestHeader hotelSlug={hotelSlug} />

      <GuestNavigation hotelSlug={hotelSlug} {...(activeTab ? { active: activeTab } : {})} />

      <div ref={scrollFrame} className="neo-customer-content" data-scroll-restoration-id="guest-body">
        <PullToRefresh scrollTarget={() => scrollFrame.current}>
          <main className="neo-public-wrap flex-1 py-5 sm:py-8">
            <PreviewBanner experience="Guest" />
            <div className="min-w-0">{children}</div>
          </main>
        </PullToRefresh>
        <GuestFooter hotelSlug={hotelSlug} />
      </div>
    </div>
  );
}

export function GuestPageIntro({ title, description, image, children }: {
  title: string;
  description?: string;
  image?: string | null | undefined;
  children?: ReactNode;
}) {
  return (
    <section className="neo-guest-page-intro" data-with-image={Boolean(image)}>
      <div className="neo-guest-page-intro-copy">
        <h1 className="neo-pub-display">{title}</h1>
        {description ? <p>{description}</p> : null}
        {children ? <div className="neo-guest-page-actions">{children}</div> : null}
      </div>
      {image ? <img src={image} alt="" className="neo-guest-page-intro-image" /> : null}
    </section>
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
