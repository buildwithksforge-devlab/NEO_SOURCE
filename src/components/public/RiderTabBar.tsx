import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Bike, Home, LifeBuoy, UserRound } from "lucide-react";
import type { CSSProperties } from "react";
import { fetchRelationshipProperty } from "@/lib/front-door";
import { brandFallback } from "@/lib/public-apps";
import { normalizedHex, primaryInk } from "@/lib/public-palette";

const tabs = [
  { key: "home", label: "Home", icon: Home, to: "/rider" },
  { key: "active", label: "Active job", icon: Bike, to: "/rider/active" },
  { key: "support", label: "Support", icon: LifeBuoy, to: "/rider/support" },
  { key: "profile", label: "Profile", icon: UserRound, to: "/rider/profile" },
] as const;

export type RiderTab = (typeof tabs)[number]["key"];

/** The Rider app's roster determines the property, independently of the staff workspace. */
export function useRiderBrand(branchId: string | null, userId?: string) {
  const property = useQuery({
    queryKey: ["rider", "property-brand", userId, branchId],
    enabled: Boolean(userId && branchId),
    queryFn: () => branchId ? fetchRelationshipProperty(branchId) : null,
    staleTime: 60_000,
  });
  const match = property.data?.branch_id === branchId ? property.data : null;
  const primary = normalizedHex(match?.brand?.primary || brandFallback.primary);
  return {
    property: match,
    primary,
    style: {
      "--pa-primary": primary,
      "--pa-on-primary": primaryInk(primary),
      "--pa-secondary": normalizedHex(match?.brand?.accent || brandFallback.secondary, brandFallback.secondary),
    } as CSSProperties,
  };
}

/**
 * Persistent bottom navigation for the standalone Rider app, mirroring the
 * customer experience standard: mobile-first, one tap between screens.
 */
export function RiderTabBar({ active }: { active: RiderTab }) {
  return (
    <nav aria-label="Rider app" className="neo-app-dock">
      <ul className="contents">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = tab.key === active;
          return (
            <li key={tab.key} className="min-w-0">
              <Link
                to={tab.to}
                aria-current={isActive ? "page" : undefined}
              >
                <Icon className="size-5" aria-hidden />
                <span>{tab.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
