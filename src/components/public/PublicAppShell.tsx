import { createContext, useContext, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  brandFallback,
  brandInitials,
  buttonRadius,
  type PublicWorkspace,
} from "@/lib/public-apps";
import { NEO_WORDMARK_SRC } from "@/components/brand/NeoIdentity";
import { CREATOR_CREDIT_URL, InstagramMark } from "@/components/brand/NeoGlyph";

/** The maker credit, shown beside "Powered by NEØ" on every public surface. */
export function PublicCreatorCredit({ className = "" }: { className?: string }) {
  return (
    <a
      href={CREATOR_CREDIT_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Built by AI, Data & Marketing by Wambui — opens Instagram in a new tab"
      className={`inline-flex max-w-full items-baseline gap-1.5 text-[0.7rem] text-white/75 transition-colors hover:text-white ${className}`}
    >
      <InstagramMark className="size-3.5 translate-y-[0.15em] self-baseline" />
      <span className="min-w-0">Built by AI, Data &amp; Marketing by Wambui</span>
    </a>
  );
}


const WorkspaceContext = createContext<PublicWorkspace | null>(null);

export function PublicWorkspaceProvider({
  workspace,
  children,
}: {
  workspace: PublicWorkspace;
  children: ReactNode;
}) {
  return <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside PublicWorkspaceProvider");
  return ctx;
}

/** Small, always-present platform attribution using the full NEØ wordmark. */
export function PoweredByNeo({ tone = "muted" }: { tone?: "muted" | "light" }) {
  return (
    <span className="inline-flex max-w-full items-center gap-2 whitespace-nowrap">
      <span
        className={
          tone === "light"
            ? "text-[0.7rem] uppercase tracking-[0.18em] text-white/75"
            : "text-[0.7rem] uppercase tracking-[0.18em] text-[color:var(--pa-muted,#8290A6)]"
        }
      >
        Powered by
      </span>
      <span className="inline-flex shrink-0 items-center rounded-md bg-neo-midnight px-2 py-1">
        <img
          src={NEO_WORDMARK_SRC}
          alt="NEØ"
          className="h-3.5 w-auto object-contain"
          draggable={false}
        />
      </span>
    </span>
  );
}


export function BrandMark({
  workspace,
  size = 40,
}: {
  workspace: PublicWorkspace;
  size?: number;
}) {
  const label = workspace.hotel_name || workspace.app_name || "Workspace";
  if (workspace.logo_url) {
    return (
      <img
        src={workspace.logo_url}
        alt={`${label} logo`}
        style={{ height: size }}
        className="w-auto max-w-[160px] object-contain"
      />
    );
  }
  return (
    <span
      className="inline-flex items-center justify-center font-semibold text-white"
      style={{
        width: size,
        height: size,
        borderRadius: buttonRadius(workspace.button_style),
        background: workspace.primary_color || brandFallback.primary,
        fontSize: size * 0.38,
      }}
      aria-hidden
    >
      {brandInitials(label)}
    </span>
  );
}

/**
 * Shared shell for the Guest and Delivery apps. Colours come from the hotel's
 * published branding with clean fallbacks, never a broken image or blank area.
 */
export function PublicAppShell({
  children,
  nav,
  homeTo,
}: {
  children: ReactNode;
  nav?: ReactNode;
  homeTo?: { to: string; params?: Record<string, string> };
}) {
  const ws = useWorkspace();
  const primary = ws.primary_color || brandFallback.primary;
  const secondary = ws.secondary_color || brandFallback.secondary;
  const background = ws.background_color || brandFallback.background;

  const brand = (
    <span className="flex min-w-0 items-center gap-3">
      <span className="shrink-0"><BrandMark workspace={ws} /></span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-sm font-semibold text-white">
          {ws.hotel_name || ws.app_name}
        </span>
        <span className="truncate text-xs text-white/75">
          {ws.app_name}
        </span>
      </span>
    </span>
  );

  return (
    <div
      className="neo-public-app flex min-h-screen flex-col"
      style={
        {
          background,
          "--pa-primary": primary,
          "--pa-secondary": secondary,
          "--pa-muted": brandFallback.steel,
          "--pa-radius": buttonRadius(ws.button_style),
        } as React.CSSProperties
      }
    >
      <header className="neo-pub-header">
        <div className="neo-public-wrap grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-4">
          {homeTo ? (
             <Link to={homeTo.to} params={homeTo.params ?? {}} className="min-w-0 overflow-hidden">
              {brand}
            </Link>
          ) : (
            brand
          )}
          {nav ? <div className="neo-scroll-x min-w-0 max-w-[52vw]">{nav}</div> : null}
        </div>
      </header>

      <main className="neo-public-wrap flex-1 py-7 sm:py-10">{children}</main>

      <footer className="neo-pub-footer">
        <div className="neo-public-wrap flex flex-col gap-3 py-8 text-xs sm:flex-row sm:items-center sm:justify-between">
          <div className="neo-public-copy space-y-0.5 text-white/75">
            {ws.contact_phone ? <p>Call {ws.contact_phone}</p> : null}
            {ws.contact_email ? <p>{ws.contact_email}</p> : null}
            {ws.contact_address ? <p>{ws.contact_address}</p> : null}
            {!ws.contact_phone && !ws.contact_email && !ws.contact_address ? (
              <p>Contact details have not been published yet.</p>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-col items-start gap-2 sm:items-end">
            <PoweredByNeo />
            <PublicCreatorCredit />
          </div>
        </div>
      </footer>
    </div>
  );
}

/** Branded primary action that follows the hotel's colour and button style. */
export function BrandButton({
  children,
  onClick,
  type = "button",
  disabled,
  className = "",
  variant = "solid",
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  className?: string;
  variant?: "solid" | "outline";
}) {
  const ws = useWorkspace();
  const primary = ws.primary_color || brandFallback.primary;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-w-0 max-w-full items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold transition-opacity disabled:opacity-50 ${className}`}
      style={{
        borderRadius: buttonRadius(ws.button_style),
        background: variant === "solid" ? primary : "transparent",
        color: variant === "solid" ? "#ffffff" : primary,
        border: `1px solid ${primary}`,
      }}
    >
      {children}
    </button>
  );
}

/** Shown for an unknown, unpublished or misspelled workspace link. */
export function WorkspaceNotFound({ appLabel }: { appLabel: string }) {
  return (
    <div className="neo-public-app flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <div className="neo-public-panel w-full max-w-md p-9">
        <h1 className="neo-public-title text-white">
          Hotel workspace not found
        </h1>
        <p className="neo-public-copy mt-3 text-sm text-white/80">
          This {appLabel} link is not active. Check the address with the hotel, or scan their
          official QR code again.
        </p>
        <p className="mt-6">
          <PoweredByNeo />
        </p>
      </div>
    </div>
  );
}

/**
 * A compact "not here yet" note that keeps the page rhythm.
 *
 * It says what is unavailable and points somewhere useful, in guest language,
 * without swallowing the screen in a large empty container.
 */
export function PublicEmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="grid min-w-0 items-center gap-3 rounded-2xl border border-dashed border-black/10 bg-white/60 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:p-5">
      <div className="min-w-0">
        <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
          {title}
        </p>
        <p className="neo-public-copy mt-1 text-sm" style={{ color: brandFallback.steel }}>
          {description}
        </p>
      </div>
      {action ? <div data-public-actions>{action}</div> : null}
    </div>
  );
}
