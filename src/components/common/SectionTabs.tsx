import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronDown, type LucideIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type SectionTab = {
  label: string;
  to: string;
  /** Optional leading glyph. Icons stay quiet — they never gain a filled chip. */
  icon?: LucideIcon;
};

/** Beyond this many views a module folds the remainder into a "More" menu. */
const DEFAULT_MAX_VISIBLE = 9;

/**
 * The one top-of-section navigation control.
 *
 * Level-1 module navigation reads as quiet text labels with a turquoise
 * underline on the current view; level-2 sub-sections use a soft segmented
 * control. Neither fills a tab with a solid slab, so navigation never looks
 * like a row of buttons and the selected label always keeps document contrast.
 *
 * This component is presentation only — callers keep owning which tabs exist
 * and which of them the current user may see.
 */
export function SectionTabs({
  tabs,
  variant = "underline",
  rootPath,
  className,
  maxVisible = DEFAULT_MAX_VISIBLE,
}: {
  tabs: readonly SectionTab[];
  variant?: "underline" | "segmented";
  /** Path that must match exactly rather than by prefix (usually tabs[0].to). */
  rootPath?: string;
  className?: string;
  /** Tabs past this count are grouped into an overflow menu. */
  maxVisible?: number;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const root = rootPath ?? tabs[0]?.to;

  if (tabs.length === 0) return null;

  const isActive = (to: string) => (to === root ? pathname === to : pathname.startsWith(to));

  // Group the tail into a "More" menu rather than squeezing twenty tiny labels
  // onto one line. The current view is always pulled into the visible row.
  let visible = tabs.slice(0, maxVisible);
  let overflow = tabs.slice(maxVisible);
  if (overflow.length > 0) {
    const activeIndex = overflow.findIndex((t) => isActive(t.to));
    const activeTab = overflow[activeIndex];
    if (activeIndex >= 0 && activeTab) {
      visible = [...visible.slice(0, maxVisible - 1), activeTab];

      overflow = [
        ...tabs.slice(maxVisible - 1, maxVisible),
        ...overflow.filter((_, i) => i !== activeIndex),
      ];
    }
  }
  const overflowActive = overflow.some((t) => isActive(t.to));

  if (variant === "segmented") {
    return (
      <nav className={cn("neo-scroll-x mb-6 -mx-1 px-1", className)}>
        <div className="neo-segment">
          {tabs.map((tab) => {
            const active = isActive(tab.to);
            return (
              <Link
                key={tab.to}
                to={tab.to}
                data-touch-target
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex items-center whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-chip-selected font-semibold text-chip-selected-foreground shadow-[var(--elevation-1)]"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
      </nav>
    );
  }

  return (
    <nav
      aria-label="Section navigation"
      className={cn(
        "neo-scroll-x -mx-1 mb-6 flex items-stretch gap-1 border-b border-outline-subtle px-1",
        className,
      )}
    >
      {visible.map((tab) => {
        const active = isActive(tab.to);
        return (
          <Link
            key={tab.to}
            to={tab.to}
            data-touch-target
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative inline-flex items-center gap-2 whitespace-nowrap rounded-t-md px-3 py-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              active
                ? "font-semibold text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary"
                : "font-medium text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.icon ? (
              <tab.icon
                aria-hidden
                className={cn("size-4 shrink-0", active ? "text-primary" : "opacity-70")}
              />
            ) : null}
            {tab.label}
          </Link>
        );
      })}

      {overflow.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            data-touch-target
            className={cn(
              "relative inline-flex items-center gap-1 whitespace-nowrap px-3 py-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              overflowActive
                ? "font-semibold text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary"
                : "font-medium text-muted-foreground hover:text-foreground",
            )}
          >
            More
            <ChevronDown className="size-3.5" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto">
            {overflow.map((tab) => (
              <DropdownMenuItem key={tab.to} asChild>
                <Link to={tab.to} aria-current={isActive(tab.to) ? "page" : undefined}>
                  {tab.icon ? <tab.icon aria-hidden className="size-4 opacity-70" /> : null}
                  {tab.label}
                </Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </nav>
  );
}

/**
 * Quiet in-page navigation for related destinations that are not module tabs
 * (for example "detailed module reports"). Links read as text, never as a row
 * of outlined buttons.
 */
export function QuietLinkRow({
  label,
  links,
  className,
}: {
  label?: string;
  links: readonly SectionTab[];
  className?: string;
}) {
  return (
    <nav className={cn("flex flex-wrap items-center gap-x-5 gap-y-2", className)}>
      {label ? <span className="text-sm text-muted-foreground">{label}</span> : null}
      {links.map((l) => (
        <Link
          key={l.to}
          to={l.to}
          className="text-sm font-medium text-foreground underline-offset-4 transition-colors hover:text-primary hover:underline"
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

export type NavRailItem = {
  key: string;
  label: string;
  icon?: LucideIcon;
  /** Quiet right-aligned count — metadata, never a badge. */
  meta?: string | number;
};

/**
 * Vertical section selector for two-pane modules (Configuration Centre).
 *
 * Reads as a navigation rail: quiet rows, a hairline turquoise marker on the
 * current section and a tint that never becomes a filled button. On phone and
 * tablet the same items scroll horizontally rather than stacking into a wall.
 */
export function NavRail({
  items,
  activeKey,
  onSelect,
  ariaLabel,
  className,
}: {
  items: readonly NavRailItem[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <nav aria-label={ariaLabel} className={className}>
      <ul className="neo-scroll-x -mx-1 flex gap-1 px-1 lg:mx-0 lg:block lg:space-y-0.5 lg:px-0">
        {items.map((item) => {
          const active = item.key === activeKey;
          return (
            <li key={item.key} className="shrink-0 lg:shrink">
              <button
                type="button"
                onClick={() => onSelect(item.key)}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "relative flex w-full items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2.5 text-left text-sm transition-colors lg:whitespace-normal",
                  active
                    ? "bg-chip-selected font-semibold text-chip-selected-foreground lg:before:absolute lg:before:inset-y-2 lg:before:left-0 lg:before:w-0.5 lg:before:rounded-full lg:before:bg-primary"
                    : "font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                {item.icon ? (
                  <item.icon
                    aria-hidden
                    className={cn("size-4 shrink-0", active ? "text-primary" : "opacity-70")}
                  />
                ) : null}
                <span className="min-w-0 flex-1 truncate lg:truncate">{item.label}</span>
                {item.meta !== undefined ? (
                  <span className="numeric shrink-0 text-xs tabular-nums text-muted-foreground">
                    {item.meta}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
