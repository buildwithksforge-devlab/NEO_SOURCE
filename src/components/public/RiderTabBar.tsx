import { Link } from "@tanstack/react-router";
import { Bike, Home, LifeBuoy, UserRound } from "lucide-react";
import { brandFallback } from "@/lib/public-apps";

const tabs = [
  { key: "home", label: "Home", icon: Home, to: "/rider" },
  { key: "active", label: "Active job", icon: Bike, to: "/rider/active" },
  { key: "support", label: "Support", icon: LifeBuoy, to: "/rider/support" },
  { key: "profile", label: "Profile", icon: UserRound, to: "/rider/profile" },
] as const;

export type RiderTab = (typeof tabs)[number]["key"];

/**
 * Persistent bottom navigation for the standalone Rider app, mirroring the
 * customer experience standard: mobile-first, one tap between screens.
 */
export function RiderTabBar({ active }: { active: RiderTab }) {
  return (
    <nav aria-label="Rider app" className="neo-pub-float max-w-[calc(100vw-1rem)] px-2 py-2">
      <ul className="grid grid-cols-4 items-center gap-1">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = tab.key === active;
          return (
            <li key={tab.key} className="min-w-0">
              <Link
                to={tab.to}
                aria-current={isActive ? "page" : undefined}
                className={`flex min-w-0 items-center justify-center gap-2 rounded-full px-2.5 py-2 text-[0.72rem] font-semibold transition-colors ${
                  isActive ? "bg-white/12 text-white" : "text-white/60 hover:text-white"
                }`}
                style={isActive ? { color: brandFallback.primary } : undefined}
              >
                <Icon className="size-4" aria-hidden />
                <span className={`${isActive ? "" : "hidden sm:inline"} truncate`}>{tab.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
