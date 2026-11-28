import { useEffect, useId, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronDown, LogOut } from "lucide-react";
import { NeoGlyph } from "@/components/brand/NeoGlyph";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { NavSearch } from "./NavSearch";
import { useBranding } from "@/lib/branding";
import { navigationForAccess } from "@/lib/nav-permissions";
import { SidebarNavSkeleton } from "@/components/common/ShellSkeleton";

import { useAuth } from "@/lib/auth";
import { isStaffPinSession } from "@/lib/staff-pin-login";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

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
  const navId = useId();
  const activePath = groups
    .flatMap((group) => group.items)
    .filter(({ to }) => pathname === to || pathname.startsWith(`${to}/`))
    .sort((a, b) => b.to.length - a.to.length)[0]?.to;
  const activeGroup = groups.find((group) => group.items.some((item) => item.to === activePath))?.title;
  const [expanded, setExpanded] = useState<string[]>([]);
  useEffect(() => {
    if (activeGroup) setExpanded((previous) => previous.includes(activeGroup) ? previous : [...previous, activeGroup]);
  }, [activeGroup, pathname]);


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
          {groups.map((group, index) => (
            <div key={group.title}>
              {collapsed ? (
                <div className="mx-auto mb-2 h-px w-6 bg-sidebar-border" />
              ) : (
                <button type="button" aria-expanded={expanded.includes(group.title)}
                  aria-controls={`${navId}-${index}`}
                  onClick={() => setExpanded((previous) => previous.includes(group.title) ? previous.filter((title) => title !== group.title) : [...previous, group.title])}
                  className="mb-1 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[0.7rem] font-bold uppercase tracking-[0.12em] text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground">
                  <span className="truncate">{group.title}</span>
                  <span className="ml-2 flex shrink-0 items-center gap-1.5"><span className="text-[0.6rem] tabular-nums opacity-70">{group.items.length}</span><ChevronDown className={cn("size-3.5 transition-transform", expanded.includes(group.title) && "rotate-180")} aria-hidden /></span>
                </button>
              )}
              <ul id={`${navId}-${index}`} className={cn("space-y-0.5", !collapsed && !expanded.includes(group.title) && "hidden")}>
                {group.items.map((item) => {
                  const active = activePath === item.to;
                  const link = (
                    <Link
                      to={item.to}
                      activeOptions={{ exact: true }}
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
  const pinSession = isStaffPinSession();
  const exitLabel = pinSession ? "Lock / Switch Staff" : "Sign out";
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
            aria-label={exitLabel}
            className="rounded-md p-1.5 text-sidebar-foreground/70 transition-colors duration-200 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <LogOut className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{exitLabel}</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function MobileSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent side="left" aria-describedby={undefined} className="neo-work-menu !w-[min(90vw,23rem)] gap-0 overflow-hidden bg-sidebar p-0 lg:hidden">
        <SheetTitle className="sr-only">Work menu</SheetTitle>
        <SidebarContent onNavigate={onClose} />
      </SheetContent>
    </Sheet>
  );
}
