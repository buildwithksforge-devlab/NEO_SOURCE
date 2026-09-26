import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  Building2,
  CheckSquare,
  ClipboardCheck,
  LayoutDashboard,
  LogOut,
  Repeat,
  UserRound,
  Menu,
  Moon,
  MoreHorizontal,
  ShieldCheck,
  Sparkles,
  Sun,
  User as UserIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { NeoGlyph, CreatorCredit } from "@/components/brand/NeoGlyph";
import { RefreshButton } from "@/components/common/RefreshButton";
import { LiveClock } from "./LiveClock";
import { PropertySelector } from "./PropertySelector";
import { WorkspaceSelector } from "./WorkspaceSelector";
import { useBranchScope } from "@/lib/branches";
import { useTenant } from "@/lib/tenant";
import { supabase } from "@/integrations/supabase/client";
import { reportQueryError } from "@/lib/query-telemetry";
import { useAuth } from "@/lib/auth";
import { useNeoSwitchAccount } from "@/lib/session-exit";
import { useNotificationInbox } from "@/lib/notifications-inbox";
import { useBranding } from "@/lib/branding";
import { Avatar } from "@/components/common/AvatarDisplay";
import { usePagePermitted } from "@/components/common/PermittedLink";
import { ReportProblemDialog } from "@/components/common/ReportProblemDialog";
import { LiveStatus } from "@/components/common/LiveStatus";

/** Consistent 44px-friendly icon button with a quiet branded hover state. */
function IconAction({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          asChild
          className={
            "size-10 shrink-0 rounded-xl text-muted-foreground transition-colors hover:bg-primary-soft/60 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring " +
            (className ?? "")
          }
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function Topbar({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const { theme, toggleTheme } = useBranding();
  const { profile, organizationId, roleNames, signOut, isAdmin } = useAuth();
  const switchAccount = useNeoSwitchAccount();
  const { activeBranch, canManage } = useBranchScope();
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { tenant } = useTenant();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  /**
   * Header quick actions obey the same page-visibility contract as the sidebar
   * and the route guard: an action a reader cannot open is never offered.
   */
  const permitted = usePagePermitted();

  const segment = pathname.split("/").filter(Boolean)[0];
  const CONTEXT_LABELS: Record<string, string> = {
    pms: "Front Office",
    pos: "Restaurant & POS",
    crm: "Guest CRM",
    hr: "Human Resources",
    "ai-insights": "NEØ Intelligence",
    lpos: "Local Purchase Orders",
  };
  const context = segment
    ? (CONTEXT_LABELS[segment] ??
      segment.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()))
    : "Dashboard";

  // The badge reads the same scoped inbox the notifications page renders, so
  // the count and the list can never disagree.
  const inbox = useNotificationInbox();
  const unread = { data: inbox.unreadCount };


  const hasName = Boolean(profile?.full_name?.trim());
  const name = hasName ? profile!.full_name : "Profile setup incomplete";
  const primaryRole = roleNames[0] ?? profile?.job_title ?? "No role assigned";

  return (
    <TooltipProvider delayDuration={150}>
      <header className="sticky top-0 z-30 w-full border-b border-border bg-background/85 backdrop-blur-md">
        {/* Full-bleed chrome: the row spans the whole staff frame beside the
            sidebar and only its contents are inset by the shared gutter. */}
        <div className="neo-page-gutter neo-shell-bleed flex h-16 items-center gap-2 overflow-hidden md:gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="size-10 shrink-0 rounded-xl lg:hidden"
            onClick={onOpenSidebar}
          >
            <Menu className="size-5" />
            <span className="sr-only">Open navigation</span>
          </Button>

          {/* Permanent product identity: the square NEØ Ø symbol only, at a
              protected 28×28px. It is `shrink-0` with `object-contain` so a
              crowded header can never squeeze or distort it — the module label
              beside it absorbs the pressure by truncating. The full wordmark
              lives in the shell footer. */}
          <Link
            to="/workspace"
            aria-label="NEØ home"
            data-brand-identity
            className="flex min-w-0 items-center gap-1.5 rounded-xl px-1 py-1 transition-colors hover:bg-primary-soft/50 sm:gap-2"
          >
            <NeoGlyph className="size-7 min-h-7 min-w-7 shrink-0 object-contain" />
            <span
              data-module-label
              className="neo-module-label text-foreground"
              title={context}
            >
              {context}
            </span>
          </Link>

          <span className="hidden h-5 w-px shrink-0 bg-border md:block" aria-hidden />

          <LiveClock />

          <div
            data-action-cluster
            className="ml-auto flex min-w-0 shrink-0 items-center gap-0.5 md:gap-1"
          >
            {/* Shows only when the open screen is receiving live changes, so
                staff are told when figures have stopped updating rather than
                reading stale numbers as current. */}
            <LiveStatus className="hidden md:flex" />

            {/* The keyboard and mouse equivalent of the swipe-down gesture,
                since a desk machine never sees the pull indicator. */}
            <RefreshButton className="hidden size-10 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-primary-soft/60 hover:text-primary md:inline-flex" />

            {/* Clocking in/out lives in the floating dock, not the header. */}


            {/* Shown only to a person who belongs to more than one group. */}
            <WorkspaceSelector className="hidden lg:flex" />

            {/* Which hotel am I in? A phone must answer that too, so the
                property control stays in the header at every width and only
                becomes narrower — it is never hidden behind a menu. */}
            <PropertySelector className="flex w-auto max-w-[8.5rem] sm:max-w-[15rem]" />

            {/* Density is NOT a header control. It lives in the dashboard
                filter toolbar's own stable right-hand slot, so the header
                keeps identity, property and navigation only. */}

            {/* Lower-priority actions: visible from lg, collapsed into More below. */}
            {permitted("/tasks") ? (
              <IconAction label="Tasks" className="hidden lg:inline-flex">
                <Link to="/tasks">
                  <CheckSquare className="size-5" />
                </Link>
              </IconAction>
            ) : null}

            {permitted("/approvals") ? (
              <IconAction label="Approvals" className="hidden md:inline-flex">
                <Link to="/approvals">
                  <ClipboardCheck className="size-5" />
                </Link>
              </IconAction>
            ) : null}

            {/* On the narrowest phones the module name outranks Intelligence,
                which moves into More rather than squeezing the identity. */}
            {permitted("/ai-insights") ? (
              <IconAction label="NEØ Intelligence" className="hidden text-primary sm:inline-flex">
                <Link to="/ai-insights">
                  <Sparkles className="size-5" />
                </Link>
              </IconAction>
            ) : null}


            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Notifications"
                  className="relative size-10 shrink-0 rounded-xl text-muted-foreground hover:bg-primary-soft/60 hover:text-primary"
                  asChild
                >
                  <Link to="/notifications">
                    <Bell className="size-5" />
                    {(unread.data ?? 0) > 0 ? (
                      <span className="absolute right-1 top-1 min-w-4 max-w-8 overflow-hidden rounded-full bg-primary px-1 text-[0.6rem] font-bold leading-4 text-primary-foreground">
                        {unread.data! > 99 ? "99+" : unread.data}
                      </span>
                    ) : null}
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Notifications</TooltipContent>
            </Tooltip>

            <div className="hidden lg:flex lg:items-center lg:gap-0.5">
              <ReportProblemDialog />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={toggleTheme}
                    aria-label="Toggle theme"
                    className="size-10 shrink-0 rounded-xl text-muted-foreground hover:bg-primary-soft/60 hover:text-primary"
                  >
                    {theme === "dark" ? <Sun className="size-5" /> : <Moon className="size-5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Toggle theme</TooltipContent>
              </Tooltip>
            </div>

            {/* Progressive disclosure: nothing is removed on small screens, it
                moves here. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="More actions"
                  data-header-overflow
                  className="size-10 shrink-0 rounded-xl text-muted-foreground hover:bg-primary-soft/60 hover:text-primary lg:hidden"
                >
                  <MoreHorizontal className="size-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {permitted("/ai-insights") ? (
                  <DropdownMenuItem asChild className="sm:hidden">
                    <Link to="/ai-insights">
                      <Sparkles className="size-4" /> NEØ Intelligence
                    </Link>
                  </DropdownMenuItem>
                ) : null}
                {permitted("/tasks") ? (
                  <DropdownMenuItem asChild className="lg:hidden">
                    <Link to="/tasks">
                      <CheckSquare className="size-4" /> Tasks
                    </Link>
                  </DropdownMenuItem>
                ) : null}
                {permitted("/approvals") ? (
                  <DropdownMenuItem asChild className="md:hidden">
                    <Link to="/approvals">
                      <ClipboardCheck className="size-4" /> Approvals
                    </Link>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                  <ReportProblemDialog variant="menu" />
                </DropdownMenuItem>
                <DropdownMenuItem onClick={toggleTheme}>
                  {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
                  Toggle theme
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  data-profile-trigger
                  className="flex h-10 min-w-0 max-w-[13rem] shrink-0 items-center gap-2 rounded-xl border border-border bg-background/60 px-1.5 text-left transition-colors duration-200 hover:border-primary/50 sm:pr-2.5"
                >
                  <Avatar path={profile?.avatar_url} name={hasName ? name : null} size={28} />
                  <span className="hidden min-w-0 text-xs leading-tight md:block">
                    <span className="block truncate font-semibold">{name}</span>
                    <span className="block truncate text-[0.68rem] text-muted-foreground">
                      {primaryRole}
                    </span>
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[min(16rem,calc(100vw-1.5rem))]">
                <DropdownMenuLabel className="min-w-0">
                  <span className="block truncate">{name}</span>
                  <span className="block truncate text-xs font-normal text-muted-foreground">
                    {profile?.email}
                  </span>
                  <span className="mt-1 block truncate text-xs font-normal text-muted-foreground">
                    {primaryRole} · {tenant.organization.name || "Organization"}
                  </span>
                  <span className="block truncate text-xs font-normal text-muted-foreground">
                    {activeBranch?.name ?? "All Properties"} ·{" "}
                    {profile?.account_status ?? "unknown status"}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <div className="px-2 pb-1 sm:hidden">
                  <PropertySelector className="w-full max-w-none" />
                </div>
                <DropdownMenuItem asChild>
                  <Link to="/profile">
                    <UserIcon className="size-4" /> My profile
                  </Link>
                </DropdownMenuItem>
                {permitted("/hr/me") ? (
                  <DropdownMenuItem asChild>
                    <Link to="/hr/me">
                      <CheckSquare className="size-4" /> My HR &amp; attendance
                    </Link>
                  </DropdownMenuItem>
                ) : null}
                {permitted("/my-engagement") ? (
                  <DropdownMenuItem asChild>
                    <Link to="/my-engagement">
                      <LayoutDashboard className="size-4" /> My workspace
                    </Link>
                  </DropdownMenuItem>
                ) : null}
                {canManage && permitted("/admin/branches") ? (
                  <DropdownMenuItem asChild>
                    <Link to="/admin/branches">
                      <Building2 className="size-4" /> Switch or manage properties
                    </Link>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem asChild>
                  <Link to={isAdmin && permitted("/settings") ? "/settings" : "/notifications"}>
                    <ShieldCheck className="size-4" /> Account security
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {/* One identity, several legitimate relationships: context
                    switching never asks for another login. */}
                <DropdownMenuItem asChild>
                  <a href="/continue?choose=1">
                    <Repeat className="size-4" /> Switch context
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void switchAccount()}>
                  <UserRound className="size-4" /> Switch account
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void signOut()}>
                  <LogOut className="size-4" /> Sign out
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <div className="px-2 py-1.5">
                  <CreatorCredit className="text-[0.7rem]" />
                </div>

              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>
    </TooltipProvider>
  );
}
