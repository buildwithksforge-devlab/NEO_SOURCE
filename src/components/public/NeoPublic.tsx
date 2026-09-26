/**
 * NEØ public design language.
 *
 * Shared presentation for every surface a person meets outside the staff
 * workspace: discovery, a hotel's front page, Stay & Dine, Partner and Rider.
 * Deep navy ground, editorial serif headlines, minimal chrome, floating
 * navigation and cards that read as destinations rather than table rows.
 *
 * Presentation only — it never decides what a person may see or do.
 */
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { NEO_WORDMARK_SRC } from "@/components/brand/NeoIdentity";
import { GUEST_HERO_WIDTHS, responsiveSrcSet } from "@/lib/responsive-image";

/** The full-height public ground. */
export function PublicSurface({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`neo-pub ${className}`}>{children}</div>;
}

/** Minimal top chrome: the NEØ mark, and at most one action. */
export function PublicTopBar({
  homeTo = "/",
  right,
  width = "max-w-5xl",
}: {
  homeTo?: string;
  right?: ReactNode;
  width?: string;
}) {
  return (
    <header
      className={`mx-auto flex w-full ${width} items-center justify-between gap-4 px-5 pt-7 sm:pt-9`}
    >
      <Link to={homeTo} aria-label="NEØ home" className="shrink-0">
        <img src={NEO_WORDMARK_SRC} alt="NEØ" className="h-5 w-auto object-contain" />
      </Link>
      {right ? <div className="flex min-w-0 items-center gap-3">{right}</div> : null}
    </header>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="neo-pub-eyebrow">{children}</p>;
}

/** Editorial headline. Serif, tight, deliberately large on phones too. */
export function Display({
  children,
  className = "",
  as: Tag = "h1",
}: {
  children: ReactNode;
  className?: string;
  as?: "h1" | "h2" | "h3";
}) {
  return <Tag className={`neo-pub-display text-white ${className}`}>{children}</Tag>;
}

/**
 * Cover media for a property card or hero.
 *
 * Shows the hotel's own photograph when it has published one. When it has
 * not, it shows an honest branded field with the hotel's initials — never a
 * borrowed or invented photograph.
 */
export function CoverMedia({
  src,
  alt,
  initials,
  className = "",
  children,
  priority = false,
  sizes = "100vw",
}: {
  src?: string | null;
  alt?: string;
  initials?: string;
  className?: string;
  children?: ReactNode;
  /** True for the single hero image a visitor sees first. */
  priority?: boolean;
  sizes?: string;
}) {
  const srcSet = responsiveSrcSet(src, GUEST_HERO_WIDTHS);
  return (
    <div className={`neo-pub-cover ${className}`}>
      {src ? (
        <img
          src={src}
          {...(srcSet ? { srcSet, sizes } : {})}
          alt={alt ?? ""}
          loading={priority ? "eager" : "lazy"}
          decoding={priority ? "sync" : "async"}
          {...(priority ? { fetchPriority: "high" as const } : {})}
          className="absolute inset-0 size-full object-cover"
        />
      ) : initials ? (
        <span
          className="neo-pub-display absolute inset-0 flex items-center justify-center text-4xl text-white/25"
          aria-hidden
        >
          {initials}
        </span>
      ) : null}
      <div className="neo-pub-scrim absolute inset-0" aria-hidden />
      {children}
    </div>
  );
}

export function Chip({ children }: { children: ReactNode }) {
  return <span className="neo-pub-chip">{children}</span>;
}

/** A quiet panel for text, states and forms on the public ground. */
export function PublicPanel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`neo-pub-card p-5 sm:p-6 ${className}`}>{children}</div>;
}

/** Floating navigation pill — the only persistent chrome on phones. */
export function FloatingNav({ children }: { children: ReactNode }) {
  return (
    <nav className="neo-pub-float flex items-center gap-1 px-2 py-2" aria-label="Sections">
      {children}
    </nav>
  );
}

export function PublicFooterNote({ children }: { children: ReactNode }) {
  return <p className="mt-10 text-xs leading-relaxed text-white/65">{children}</p>;
}
