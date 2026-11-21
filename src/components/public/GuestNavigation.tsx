import { Link } from "@tanstack/react-router";
import { BedDouble, Compass, Home, Receipt } from "lucide-react";

const destinations = [
  { key: "home", label: "Home", icon: Home, to: "/guest/$hotelSlug" },
  { key: "explore", label: "Explore", icon: Compass, to: "/guest/$hotelSlug/explore" },
  { key: "orders", label: "Orders", icon: Receipt, to: "/guest/$hotelSlug/orders" },
  { key: "stay", label: "My Stay", icon: BedDouble, to: "/guest/$hotelSlug/stay" },
] as const;

export type GuestDestination = (typeof destinations)[number]["key"];

export function GuestNavigation({ hotelSlug, active }: { hotelSlug: string; active?: GuestDestination }) {
  return (
    <nav aria-label="Guest app" className="neo-app-dock neo-guest-tabbar">
      <ul className="contents">
        {destinations.map(({ key, label, icon: Icon, to }) => (
          <li key={key}>
            <Link to={to} params={{ hotelSlug }} activeOptions={{ exact: true }} className="min-h-11"
              aria-current={key === active ? "page" : undefined}>
              <Icon className="size-5" aria-hidden />
              <span className="w-full text-center">{label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
