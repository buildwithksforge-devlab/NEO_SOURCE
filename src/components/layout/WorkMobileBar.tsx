/**
 * Work on a phone.
 *
 * The staff OS keeps one navigation source of truth: `navigationForAccess`.
 * This bar is a presentation layer over that same permitted set — it never
 * introduces a destination the signed-in person's permissions do not already
 * reach, and it disappears entirely on large screens where the rail is shown.
 */
import { Link, useRouterState } from "@tanstack/react-router";
import { BriefcaseBusiness, House, LayoutDashboard, LayoutGrid, Search } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { canAccessPath } from "@/lib/nav-permissions";
import { resolveWorkHome } from "@/lib/work-home";

export function WorkMobileBar({
  onOpenNav,
  onOpenSearch,
}: {
  onOpenNav: () => void;
  onOpenSearch: () => void;
}) {
  const { access, can, canModule, permissionsLoaded } = useAuth();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const home = permissionsLoaded
    ? resolveWorkHome({
        accessScope: access.accessScope,
        dashboardKey: access.dashboardKey,
        canModule,
        canOpen: (route) => canAccessPath(can, route),
      }).route
    : "/workspace";
  const matches = (to: string) => pathname === to || pathname.startsWith(`${to}/`);
  const links = [
    { to: home, label: "Home", icon: House },
    home === "/my-work"
      ? { to: "/workspace", label: "Dashboard", icon: LayoutDashboard }
      : { to: "/my-work", label: "My work", icon: BriefcaseBusiness },
  ];
  const activeTo = links.find((item) => matches(item.to))?.to;

  return (
    <div className="neo-work-dock-wrap shrink-0 lg:hidden">
      <nav aria-label="Work navigation" className="neo-app-dock neo-work-dock">
        {links.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            aria-current={activeTo === item.to ? "page" : undefined}
            activeOptions={{ exact: true }}
            title={item.label}
          >
            <item.icon className="size-5 shrink-0" aria-hidden />
            <span className="w-full truncate">{item.label}</span>
          </Link>
        ))}
        <button type="button" onClick={onOpenSearch} aria-haspopup="dialog">
          <Search className="size-5" aria-hidden />
          Search
        </button>
        <button type="button" onClick={onOpenNav} aria-haspopup="dialog">
          <LayoutGrid className="size-5" aria-hidden />
          Menu
        </button>
      </nav>
    </div>
  );
}
