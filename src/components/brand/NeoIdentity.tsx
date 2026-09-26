import { cn } from "@/lib/utils";
import neoSymbolSrc from "@/assets/neo-symbol.png";

/**
 * NEØ canonical brand assets.
 *
 * The logo and the standalone Ø are the supplied, approved artwork — they are
 * never redrawn in code. Everything here simply places those two files.
 *
 * - `NeoSymbol`  — standalone Ø mark (app icon, favicon, compact use)
 * - `NeoWordmark`— full NEØ logo
 * - `NeoLockup`  — logo + "NEXT-GENERATION ENTERPRISE OPERATIONS" + tagline
 */

export const NEO_WORDMARK_SRC = "/neo-wordmark.png";
export const NEO_SYMBOL_SRC = neoSymbolSrc;

export function NeoSymbol({
  className,
  animate = false,
  title = "NEØ",
}: {
  className?: string;
  animate?: boolean;
  title?: string;
}) {
  return (
    <img
      src={NEO_SYMBOL_SRC}
      alt={title}
      className={cn("size-12 object-contain", animate && "neo-seq-ring", className)}
      draggable={false}
    />
  );
}

export function NeoWordmark({
  className,
  animate = false,
}: {
  className?: string;
  animate?: boolean;
}) {
  return (
    <img
      src={NEO_WORDMARK_SRC}
      alt="NEØ"
      className={cn("h-[1em] w-auto object-contain", animate && "neo-seq-letters", className)}
      draggable={false}
    />
  );
}

export function NeoLockup({
  className,
  animate = false,
  size = "lg",
}: {
  className?: string;
  animate?: boolean;
  size?: "sm" | "lg";
}) {
  return (
    <div className={cn("flex flex-col items-center text-center", className)}>
      <div className="relative">
        <div
          aria-hidden
          className={cn(
            "absolute -inset-10 rounded-full blur-3xl",
            animate ? "neo-seq-glow" : "opacity-40",
          )}
          style={{ background: "radial-gradient(circle, rgba(24,196,200,0.55) 0%, transparent 70%)" }}
        />
        <NeoWordmark
          animate={animate}
          className={cn("relative", size === "lg" ? "h-24 sm:h-28" : "h-14")}
        />
      </div>

      <p
        className={cn(
          "mt-6 text-[0.6rem] font-medium uppercase tracking-[0.32em] text-neo-mist/85 sm:text-[0.72rem]",
          animate && "neo-seq-line1",
        )}
      >
        Next-Generation <span className="text-neo-turquoise">Enterprise</span> Operations
      </p>

      <div className={cn("mt-4 flex items-center gap-3", animate && "neo-seq-line2")}>
        <span className="h-px w-8 bg-gradient-to-r from-transparent to-neo-gold/70" />
        <p className="text-[0.58rem] uppercase tracking-[0.28em] text-neo-gold sm:text-[0.68rem]">
          One System. Endless Solutions.
        </p>
        <span className="h-px w-8 bg-gradient-to-l from-transparent to-neo-gold/70" />
      </div>
    </div>
  );
}

/**
 * Platform signature: "Powered by" + the full NEØ wordmark (never the glyph
 * alone). The wordmark sits directly on the footer background — no chip or
 * rectangle — with a subtle dark drop shadow so the light artwork stays
 * legible on light surfaces.
 */
export function PoweredByNeoSignature({
  className,
  height = "h-4",
}: {
  className?: string;
  height?: string;
}) {
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-2 gap-y-1", className)}>
      <span className="text-[0.62rem] uppercase tracking-[0.22em] text-muted-foreground">
        Powered by
      </span>
      <img
        src={NEO_WORDMARK_SRC}
        alt="NEØ"
        className={cn("w-auto shrink-0 object-contain", height)}
        style={{ filter: "drop-shadow(0 1px 1.5px rgba(2,10,28,0.55)) drop-shadow(0 0 1px rgba(2,10,28,0.35))" }}
        draggable={false}
      />
    </span>
  );
}


export const CREATOR_URL =
  "https://www.instagram.com/aidataandmarketingwithwambui?igsh=MThybzBzenhmNzgzdg%3D%3D&utm_source=qr";

