import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Layout-stable loading chrome.
 *
 * Every skeleton here reserves the *same* geometry as the content it stands
 * in for — the shell rail uses the shared `--neo-sidebar-w` token, the header
 * band is 4rem, cards keep their radius and padding — so nothing shifts,
 * jumps or shakes when the real data arrives.
 */

export function SidebarNavSkeleton({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div data-skeleton="sidebar" className="space-y-6 px-3 py-4" aria-hidden>
      {[4, 3, 3].map((count, group) => (
        <div key={group} className="space-y-2">
          {!collapsed ? <Skeleton className="h-3 w-24 rounded" /> : null}
          {Array.from({ length: count }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="size-8 shrink-0 rounded-lg" />
              {!collapsed ? <Skeleton className="h-3.5 w-full rounded" /> : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div
      data-skeleton="card"
      aria-hidden
      className={cn("neo-card-pad rounded-2xl border border-border bg-card", className)}
    >
      <Skeleton className="h-4 w-40 rounded" />
      <Skeleton className="mt-2 h-3 w-56 rounded" />
      <div className="mt-4 space-y-2">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className={cn("h-9 w-full rounded-lg", i === lines - 1 && "w-2/3")} />
        ))}
      </div>
    </div>
  );
}

/** Metric strip placeholder that matches the real KPI grid geometry. */
export function MetricStripSkeleton({ tiles = 4 }: { tiles?: number }) {
  return (
    <div data-skeleton="metrics" aria-hidden className="neo-metric-grid">
      {Array.from({ length: tiles }).map((_, i) => (
        <Skeleton key={i} className="h-28 w-full rounded-2xl" />
      ))}
    </div>
  );
}

/**
 * Whole-workspace placeholder used while the session, access contract and
 * first workspace queries resolve. It renders the same three-part frame as
 * the live shell (rail, header, content column), so the transition into the
 * real workspace is a fade of content, not a re-layout.
 */
export function WorkspaceShellSkeleton({ label }: { label?: string }) {
  return (
    <div
      data-skeleton="workspace-shell"
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="neo-page-canvas neo-shell-frame flex min-h-dvh"
    >
      <span className="sr-only">{label ?? "Opening your workspace"}</span>
      <aside
        aria-hidden
        className="neo-sidebar-rail sticky top-0 hidden h-screen shrink-0 border-r border-sidebar-border lg:block"
      >
        <div className="flex items-center gap-3 border-b border-sidebar-border px-4 py-4">
          <Skeleton className="size-9 shrink-0 rounded-xl" />
          <Skeleton className="h-3.5 w-28 rounded" />
        </div>
        <SidebarNavSkeleton />
      </aside>

      <div className="neo-shell-main flex min-w-0 flex-col">
        <div
          aria-hidden
          className="neo-page-gutter flex h-16 items-center gap-3 overflow-hidden border-b border-border"
        >
          <Skeleton className="size-9 shrink-0 rounded-xl" />
          <Skeleton className="h-3.5 w-32 rounded" />
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Skeleton className="hidden h-9 w-40 rounded-full md:block" />
            <Skeleton className="size-9 rounded-xl" />
            <Skeleton className="size-9 rounded-xl" />
          </div>
        </div>

        <main className="neo-content-shell flex-1">
          <div className="neo-shell-bleed space-y-5">
            <div className="space-y-2">
              <Skeleton className="h-6 w-56 rounded" />
              <Skeleton className="h-3.5 w-80 max-w-full rounded" />
            </div>
            <MetricStripSkeleton />
            <div className="grid gap-4 lg:grid-cols-2">
              <CardSkeleton />
              <CardSkeleton />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
