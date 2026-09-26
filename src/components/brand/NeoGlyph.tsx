import { cn } from "@/lib/utils";
import { NEO_SYMBOL_SRC, NEO_WORDMARK_SRC } from "@/components/brand/NeoIdentity";

/**
 * Standalone NEØ Ø mark (supplied artwork). Used in the sidebar, mobile header
 * and anywhere the platform identity must stay visible alongside hotel branding.
 */
export function NeoGlyph({ className }: { className?: string }) {
  return (
    <img
      src={NEO_SYMBOL_SRC}
      alt="NEØ"
      className={cn("size-8 object-contain", className)}
      draggable={false}
    />
  );
}

/** Compact horizontal NEØ logo (supplied artwork). */
export function NeoWordmark({ className }: { className?: string }) {
  return (
    <img
      src={NEO_WORDMARK_SRC}
      alt="NEØ"
      className={cn("h-5 w-auto object-contain", className)}
      draggable={false}
    />
  );
}

export const CREATOR_CREDIT_URL =
  "https://www.instagram.com/aidataandmarketingwithwambui?igsh=MThybzBzenhmNzgzdg%3D%3D&utm_source=qr";

/** The real full-colour Instagram glyph, drawn from the brand gradient. */
export function InstagramMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("size-4 shrink-0", className)}>
      <defs>
        <radialGradient id="neo-ig-gradient" cx="30%" cy="107%" r="150%">
          <stop offset="0%" stopColor="#FDF497" />
          <stop offset="5%" stopColor="#FDF497" />
          <stop offset="45%" stopColor="#FD5949" />
          <stop offset="60%" stopColor="#D6249F" />
          <stop offset="90%" stopColor="#285AEB" />
        </radialGradient>
      </defs>
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="url(#neo-ig-gradient)" />
      <rect
        x="5.75"
        y="5.75"
        width="12.5"
        height="12.5"
        rx="4"
        fill="none"
        stroke="#ffffff"
        strokeWidth="1.6"
      />
      <circle cx="12" cy="12" r="3.1" fill="none" stroke="#ffffff" strokeWidth="1.6" />
      <circle cx="16.6" cy="7.4" r="1.05" fill="#ffffff" />
    </svg>
  );
}

export function CreatorCredit({ className }: { className?: string }) {
  return (
    <a
      href={CREATOR_CREDIT_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Built by AI, Data & Marketing by Wambui — opens Instagram in a new tab"
      className={cn(
        "inline-flex items-baseline gap-1.5 text-xs text-muted-foreground transition-colors duration-200 hover:text-primary",
        className,
      )}
    >
      {/* The Instagram mark sits immediately before the text, on the same baseline. */}
      <InstagramMark className="translate-y-[0.15em] self-baseline" />
      <span>Built by AI, Data &amp; Marketing by Wambui</span>
    </a>
  );
}
