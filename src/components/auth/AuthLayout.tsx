import type { ReactNode } from "react";
import { ExternalLink, Instagram } from "lucide-react";
import { CREATOR_URL, NeoLockup, NeoSymbol, PoweredByNeoSignature } from "@/components/brand/NeoIdentity";
import { cn } from "@/lib/utils";

function CreatorCredit({ className }: { className?: string }) {
  return (
    <a
      href={CREATOR_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Built by AI, Data and Marketing by Wambui — opens Instagram in a new tab"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-neo-steel transition-colors hover:text-neo-turquoise focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neo-turquoise",
        className,
      )}
    >
      <Instagram className="size-3.5" aria-hidden />
      <span>
        Built by <span className="text-neo-turquoise/85">AI, Data &amp; Marketing by Wambui</span>
      </span>
      <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}

const brandBackground = {
  backgroundColor: "#020a1c",
  backgroundImage:
    "radial-gradient(ellipse 80% 60% at 50% 12%, rgba(24,196,200,0.16), transparent 70%), linear-gradient(180deg, #020a1c 0%, #07142d 100%)",
};

/** Left (desktop) / top (mobile) brand panel with the approved NEØ identity. */
function BrandPanel({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={cn(
        "relative flex h-full flex-col items-center justify-center overflow-hidden lg:min-h-screen",
        compact ? "px-6 pb-16 pt-10" : "px-10 py-14",
      )}
      style={brandBackground}
    >
      <NeoSymbol
        aria-hidden
        className="pointer-events-none absolute -right-16 top-1/2 size-[520px] -translate-y-1/2 opacity-[0.035]"
      />
      {compact ? (
        <>
          <NeoSymbol animate className="size-14" />
          <NeoLockup animate size="sm" className="mt-4" />
        </>
      ) : (
        <>
          <NeoLockup animate className="relative" />
          <CreatorCredit className="absolute bottom-6" />
        </>
      )}
    </div>
  );
}

/**
 * NEØ authentication shell.
 * Desktop: 48% brand / 52% authentication. Phone: vertical brand band with a
 * floating white panel beneath it.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
  header,
  wide = false,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  header?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="min-h-dvh w-full overflow-x-hidden bg-neo-midnight lg:grid lg:min-h-screen lg:grid-cols-[48fr_52fr]">
      <div className="hidden lg:block lg:h-screen">
        <BrandPanel />
      </div>
      <div className="lg:hidden">
        <BrandPanel compact />
      </div>

      {/* The form sits on a soft tinted field rather than flat white, so the
          card carrying it reads as a real object with an edge and a shadow. */}
      <div className="relative -mt-8 flex flex-1 flex-col items-center rounded-t-[28px] bg-[#eef2f8] px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-8 shadow-[0_-18px_40px_-24px_rgba(2,10,28,0.6)] sm:px-6 lg:mt-0 lg:justify-center lg:rounded-none lg:px-10 lg:py-12 lg:shadow-none">
        <div className={cn("w-full", wide ? "max-w-[780px]" : "max-w-[520px]")}>
          <div className="rounded-3xl border border-neo-mist bg-neo-white p-6 shadow-[0_28px_60px_-32px_rgba(2,10,28,0.45)] sm:p-8">
            {header}
            {title ? (
              <h1 className="font-display text-[1.75rem] leading-tight tracking-tight text-neo-midnight sm:text-[2.1rem]">
                {title}
              </h1>
            ) : null}
            {subtitle ? (
              <p className="mt-2.5 text-[0.9375rem] leading-relaxed text-neo-steel">{subtitle}</p>
            ) : null}
            <div className="mt-7 text-neo-midnight">{children}</div>
            {footer ? (
              <div className="mt-7 border-t border-neo-mist pt-5 text-[0.8125rem] leading-relaxed text-neo-steel">
                {footer}
              </div>
            ) : null}
          </div>

          <div className="mt-8 flex flex-col items-center gap-2 lg:hidden">
            <PoweredByNeoSignature />
            <CreatorCredit className="opacity-100" />
          </div>
        </div>
      </div>
    </div>
  );
}
