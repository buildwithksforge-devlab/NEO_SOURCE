/**
 * Work on a phone.
 *
 * The staff OS keeps one navigation source of truth: `navigationForAccess`.
 * This bar is a presentation layer over that same permitted set — it never
 * introduces a destination the signed-in person's permissions do not already
 * reach, and it disappears entirely on large screens where the rail is shown.
 */
import { Link, useRouterState } from "@tanstack/react-router";
import { Menu, Search } from "lucide-react";
import { navigationForAccess } from "@/lib/nav-permissions";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

export function WorkMobileBar({
  onOpenNav,
  onOpenSearch,
}: {
  onOpenNav: () => void;
  onOpenSearch: () => void;
}) {
  const { isAdmin, can, permissionsLoaded } = useAuth();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const groups = navigationForAccess(can, isAdmin, permissionsLoaded);
  // The first destinations of the first permitted groups: whatever this role
  // actually holds, in the order the canonical navigation already defines.
  const quick = groups.flatMap((g) => g.items).slice(0, 3);

  if (!permissionsLoaded && quick.length === 0) return null;

  return (
    <nav
      aria-label="Work navigation"
      className="neo-safe-b sticky bottom-0 z-30 flex items-stretch gap-1 border-t border-border bg-card/95 px-2 py-1.5 backdrop-blur lg:hidden"
    >
      <button
        type="button"
        onClick={onOpenNav}
        className="flex min-h-11 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 py-1.5 text-[0.68rem] font-medium text-muted-foreground transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <Menu className="size-4" aria-hidden />
        Menu
      </button>
      {quick.map((item) => {
        const active = pathname === item.to;
        return (
          <Link
            key={item.to}
            to={item.to}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 py-1.5 text-[0.68rem] font-medium transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
              active ? "bg-primary/10 text-primary" : "text-muted-foreground",
            )}
          >
            <item.icon className="size-4 shrink-0" aria-hidden />
            <span className="w-full truncate text-center">{item.label}</span>
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onOpenSearch}
        className="flex min-h-11 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 py-1.5 text-[0.68rem] font-medium text-muted-foreground transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <Search className="size-4" aria-hidden />
        Search
      </button>
    </nav>
  );
}
