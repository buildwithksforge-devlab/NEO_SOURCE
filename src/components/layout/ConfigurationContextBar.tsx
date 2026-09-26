import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronRight, SlidersHorizontal } from "lucide-react";
import { SETTINGS_CATEGORIES } from "@/lib/settings-catalogue";

/**
 * Breadcrumb rail for deep configuration pages.
 *
 * Configuration pages live under `/admin/*` for historical reasons but they are
 * part of the Configuration Centre, not a separate admin application. This bar
 * keeps that relationship visible and always offers the way back, so no page
 * ever feels like a dead end in a foreign shell.
 */
export function ConfigurationContextBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (!pathname.startsWith("/admin")) return null;

  let categoryLabel: string | null = null;
  let entryLabel: string | null = null;
  for (const category of SETTINGS_CATEGORIES) {
    for (const entry of category.entries) {
      if (entry.to && (pathname === entry.to || pathname.startsWith(`${entry.to}/`))) {
        categoryLabel = category.title;
        entryLabel = entry.label;
      }
    }
  }

  return (
    <nav
      aria-label="Configuration breadcrumb"
      className="mb-6 flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
    >
      <SlidersHorizontal className="size-3.5 text-primary" aria-hidden />
      <Link to="/settings" className="font-medium text-foreground transition-colors hover:text-primary">
        Configuration Centre
      </Link>
      {categoryLabel ? (
        <>
          <ChevronRight className="size-3" aria-hidden />
          <span>{categoryLabel}</span>
        </>
      ) : null}
      {entryLabel ? (
        <>
          <ChevronRight className="size-3" aria-hidden />
          <span className="text-foreground">{entryLabel}</span>
        </>
      ) : null}
    </nav>
  );
}
