import { useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronDown, LogOut, X } from "lucide-react";
import { NeoGlyph } from "@/components/brand/NeoGlyph";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { NavSearch } from "./NavSearch";
import { useBranding } from "@/lib/branding";
import { navigationForAccess } from "@/lib/nav-permissions";
import { SidebarNavSkeleton } from "@/components/common/ShellSkeleton";

import { useAuth } from "@/lib/auth";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

export function SidebarContent({
  onNavigate,
  collapsed = false,
}: {
  onNavigate?: () => void;
  collapsed?: boolean;
}) {
  const { branding } = useBranding();
  const { property } = useSession();
  const { isAdmin, can, permissionsLoaded } = useAuth();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const groups = navigationForAccess(can, isAdmin, permissionsLoaded);
  const [expanded, setExpanded] = useState<string[]>([]);
  useEffect(() => {
    const activeGroup = groups.find((group) => group.items.some((item) => item.to === pathname));
    if (activeGroup) setExpanded((previous) => previous.includes(activeGroup.title) ? previous : [...previous, activeGroup.title]);
  }, [groups, pathname]);


  return (
    <TooltipProvider delayDuration={120}>
      <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
        {/* Platform identity (NEØ) + hotel workspace identity */}
        <div
          className={cn(
            "flex items-center gap-3 border-b border-sidebar-border px-4 py-4",
            collapsed && "justify-center px-2",
          )}
        >
          {branding.logo ? (
            <img
              src={branding.logo}
              alt={`${branding.businessName} logo`}
              className={cn(
                "shrink-0 rounded-lg object-contain",
                collapsed ? "size-8" : "h-9 w-9",
              )}
            />
          ) : (
            <NeoGlyph className="size-8 shrink-0" />
          )}

          {collapsed ? null : (
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-sidebar-accent-foreground">
                {branding.businessName}
                {branding.logo ? <NeoGlyph className="size-3.5 shrink-0 opacity-80" /> : null}
              </p>
              <p className="truncate text-xs text-sidebar-foreground/70">{property.name}</p>
            </div>
          )}
        </div>

        {collapsed ? null : <NavSearch onNavigate={onNavigate} />}

        <nav
          className={cn(
            "flex-1 space-y-5 overflow-y-auto py-4 [scrollbar-width:thin]",
            collapsed ? "px-2" : "px-3",
          )}
        >
          {!permissionsLoaded && groups.length === 0 ? (
            <SidebarNavSkeleton collapsed={collapsed} />
          ) : null}
          {groups.map((group) => (
            <div key={group.title}>
              {collapsed ? (
                <div className="mx-auto mb-2 h-px w-6 bg-sidebar-border" />
              ) : (
                <button type="button" aria-expanded={expanded.includes(group.title)}
                  aria-controls={`neo-nav-${group.title.replace(/[^a-z0-9]/gi, "-").toLowerCase()}`}
                  onClick={() => setExpanded((previous) => previous.includes(group.title) ? previous.filter((title) => title !== group.title) : [...previous, group.title])}
                  className="mb-1 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[0.7rem] font-bold uppercase tracking-[0.12em] text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground">
                  <span className="truncate">{group.title}</span>
                  <span className="ml-2 flex shrink-0 items-center gap-1.5"><span className="text-[0.6rem] tabular-nums opacity-70">{group.items.length}</span><ChevronDown className={cn("size-3.5 transition-transform", expanded.includes(group.title) && "rotate-180")} aria-hidden /></span>
                </button>
              )}
              <ul id={`neo-nav-${group.title.replace(/[^a-z0-9]/gi, "-").toLowerCase()}`} className={cn("space-y-0.5", !collapsed && !expanded.includes(group.title) && "hidden")}>
                {group.items.map((item) => {
                  const active = pathname === item.to;
                  const link = (
                    <Link
                      to={item.to}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors duration-200",
                        collapsed && "justify-center px-0",
                        active
                          ? "bg-sidebar-primary/12 font-semibold text-sidebar-accent-foreground"
                          : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                      )}
                    >
                      {active ? (
                        <span
                          aria-hidden
                          className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-sidebar-primary"
                        />
                      ) : null}
                      <item.icon
                        className={cn(
                          "size-4 shrink-0 transition-colors duration-200",
                          active
                            ? "text-sidebar-primary"
                            : "text-sidebar-foreground/70 group-hover:text-sidebar-accent-foreground",
                        )}
                      />
                      {collapsed ? null : (
                        <>
                          <span className="truncate">{item.label}</span>
                          {item.badge ? (
                            <span className="ml-auto rounded-full border border-sidebar-primary/40 bg-sidebar-primary/15 px-1.5 py-0.5 text-[0.58rem] font-semibold uppercase tracking-wide text-sidebar-primary">
                              {item.badge}
                            </span>
                          ) : null}
                        </>
                      )}
                    </Link>
                  );

                  return (
                    <li key={item.to}>
                      {collapsed ? (
                        <Tooltip>
                          <TooltipTrigger asChild>{link}</TooltipTrigger>
                          <TooltipContent side="right">{item.label}</TooltipContent>
                        </Tooltip>
                      ) : (
                        link
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <SidebarUser collapsed={collapsed} />
      </div>
    </TooltipProvider>
  );
}

function SidebarUser({ collapsed }: { collapsed: boolean }) {
  const { profile, roleNames, signOut } = useAuth();
  const hasName = Boolean(profile?.full_name?.trim());
  const name = hasName ? profile!.full_name : "Profile setup incomplete";
  const initials = hasName
    ? name
        .split(" ")
        .filter(Boolean)
        .map((p) => p[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : "—";

  return (
    <div
      className={cn(
        "flex items-center gap-3 border-t border-sidebar-border py-3",
        collapsed ? "flex-col px-2" : "px-4",
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-[0.7rem] font-semibold text-sidebar-accent-foreground">
        {initials}
      </span>
      {collapsed ? null : (
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-sidebar-accent-foreground">{name}</p>
          <p className="truncate text-[0.68rem] text-sidebar-foreground/70">
            {roleNames[0] ?? "No role assigned"}
          </p>
        </div>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => void signOut()}
            aria-label="Sign out"
            className="rounded-md p-1.5 text-sidebar-foreground/70 transition-colors duration-200 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <LogOut className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Sign out</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function MobileSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <button
        aria-label="Close navigation"
        onClick={onClose}
        className="absolute inset-0 bg-foreground/50 backdrop-blur-sm"
      />
      <div className="absolute inset-y-0 left-0 w-72 shadow-lift">
        <button
          onClick={onClose}
          aria-label="Close navigation"
          className="absolute -right-11 top-3 rounded-lg bg-card p-2 text-foreground shadow-elegant"
        >
          <X className="size-4" />
        </button>
        <SidebarContent onNavigate={onClose} />
      </div>
    </div>
  );
}
