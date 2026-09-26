import { useCallback, useEffect, useMemo, useState } from "react";
import { Outlet } from "@tanstack/react-router";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { MobileSidebar, SidebarContent } from "./Sidebar";
import { PullToRefresh } from "@/components/common/PullToRefresh";
import { Topbar } from "./Topbar";
import { RouteAccessGate } from "./RouteAccessGate";
import { WorkMobileBar } from "./WorkMobileBar";
import { ConfigurationContextBar } from "./ConfigurationContextBar";

import { WorkspaceBootGate } from "./WorkspaceBootGate";
import { CommandPalette } from "./CommandPalette";
import { useKeyboardShortcuts } from "@/lib/keyboard-shortcuts";
import { CreatorCredit } from "@/components/brand/NeoGlyph";
import { PoweredByNeoSignature } from "@/components/brand/NeoIdentity";

import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { useQueryClient } from "@tanstack/react-query";
import { useScopedRealtime } from "@/lib/realtime-scope";
import { hydrateDensity, scopeDensityToUser, setDensityRoleHint } from "@/lib/density";

const COLLAPSE_KEY = "neo.sidebar.collapsed";

export function AppShell() {
  return (
    <WorkspaceBootGate>
      <WorkspaceLayout />
    </WorkspaceBootGate>
  );
}

function WorkspaceLayout() {
  const queryClient = useQueryClient();
  // The header and inbox share this query. A worker should see new assignments
  // as soon as the database commits them while NEØ is open, with reconnect
  // resync handled by the shared realtime hook.
  useScopedRealtime("staff-notifications", [{
    table: "notifications",
    onChange: () => void queryClient.invalidateQueries({ queryKey: ["notifications-unread"] }),
  }]);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const { user, roleNames } = useAuth();

  // Display density is a personal preference, so it is keyed by the signed-in
  // user and applied to the document once the session is known.
  useEffect(() => {
    hydrateDensity();
    scopeDensityToUser(user?.id ?? null);
  }, [user?.id]);

  // Role names only *recommend* a default while the preference is "auto".
  // They never change permissions, scoping or which records are rendered.
  useEffect(() => {
    setDensityRoleHint(roleNames);
  }, [roleNames]);


  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  // The global keyboard layer lives here, once, so every page inherits it.
  // "/" focuses whichever search the current page exposes; when a page has
  // none, it opens command search rather than doing nothing.
  const focusPageSearch = useCallback(() => {
    const field = document.querySelector<HTMLElement>(
      '[data-page-search] input, input[type="search"], [role="searchbox"]',
    );
    if (field) field.focus();
    else setPaletteOpen(true);
  }, []);
  const shortcuts = useMemo(
    () => ({
      command: () => setPaletteOpen((open) => !open),
      search: focusPageSearch,
    }),
    [focusPageSearch],
  );
  useKeyboardShortcuts(shortcuts);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  // The frame owns the viewport and never scrolls itself: the rail is always
  // exactly one screen tall and reaches the bottom, and an overlay that locks
  // the document can no longer move the shell sideways or vertically. Page
  // scrolling happens inside the content column.
  return (
    <div className="neo-page-canvas neo-shell-frame flex h-dvh overflow-hidden">
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      {/* Desktop rail. Its width comes from the shared shell tokens
          (--neo-sidebar-w / --neo-sidebar-w-collapsed) so the rail, the
          header and the content column can never disagree. Below `lg` no
          width is reserved at all — navigation is the drawer below. */}
      <aside
        data-shell-sidebar
        data-collapsed={collapsed ? "true" : "false"}
        className={cn(
          "hidden h-full shrink-0 border-r border-sidebar-border transition-[width] duration-200 ease-out lg:block",
          collapsed ? "neo-sidebar-rail-collapsed" : "neo-sidebar-rail",
        )}
      >
        <div className="relative h-full">
          <SidebarContent collapsed={collapsed} />
          <button
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            aria-expanded={!collapsed}
            className="absolute -right-3 top-20 z-10 hidden rounded-full border border-border bg-card p-1.5 text-muted-foreground shadow-elegant transition-colors duration-200 hover:text-primary lg:block"
          >
            {collapsed ? (
              <PanelLeftOpen className="size-3.5" />
            ) : (
              <PanelLeftClose className="size-3.5" />
            )}
          </button>
        </div>
      </aside>

      <MobileSidebar open={mobileOpen} onClose={() => setMobileOpen(false)} />

      <div data-shell-main className="neo-shell-main flex min-h-0 flex-1 flex-col overflow-hidden">
        <Topbar onOpenSidebar={() => setMobileOpen(true)} />
        {/* One gutter for the whole staff app: content never touches the
            screen edge on a phone, and the inset grows with the viewport.
            Data-heavy staff pages use the full shell width — no narrow
            website column — while the gutter keeps them off the edge. */}
        <div data-shell-scroll className="neo-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
          <PullToRefresh scrollTarget={() => document.querySelector<HTMLElement>("[data-shell-scroll]")}>
          <main className="neo-content-shell flex-1">
          <div className="neo-shell-bleed">
            <ConfigurationContextBar />
            <RouteAccessGate>
              <Outlet />
            </RouteAccessGate>
          </div>
          </main>
          </PullToRefresh>
        </div>

        {/* Footer chrome sits outside the scroll column, so the signature and
            the creator credit stay pinned to the bottom of the frame on every
            page instead of drifting with long content. */}
        <footer className="neo-safe-b neo-page-gutter shrink-0 border-t border-border bg-background/95 py-3 backdrop-blur">
          <div className="neo-shell-bleed flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <PoweredByNeoSignature />
            <CreatorCredit className="text-[0.7rem] opacity-70" />
          </div>
        </footer>
        <WorkMobileBar
          onOpenNav={() => setMobileOpen(true)}
          onOpenSearch={() => setPaletteOpen(true)}
        />
      </div>
    </div>
  );
}
