/**
 * Protected guest state — a prompt, never a second sign-in form.
 *
 * Content pages say what is behind the door and offer one way through it. The
 * email and password fields live on the hotel's own sign-in page, which returns
 * the guest to exactly the page they were trying to open.
 */
import { Link, useRouterState } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { useWorkspace } from "@/components/public/PublicAppShell";
import { brandFallback, buttonRadius } from "@/lib/public-apps";

export function GuestSignInPrompt({
  hotelSlug,
  title,
  description,
}: {
  hotelSlug: string;
  title: string;
  description: string;
}) {
  const ws = useWorkspace();
  const next = useRouterState({ select: (s) => s.location.pathname });
  const primary = ws.primary_color || brandFallback.primary;

  return (
    <section className="neo-rider-card mt-5 grid min-w-0 items-center gap-4 p-5 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:p-6">
      <span
        className="grid size-11 shrink-0 place-items-center rounded-xl"
        style={{ background: `${primary}1a`, color: primary }}
        aria-hidden
      >
        <Lock className="size-5" />
      </span>
      <div className="min-w-0">
        <h2 className="text-base font-semibold" style={{ color: brandFallback.secondary }}>
          {title}
        </h2>
        <p className="neo-public-copy mt-1 text-sm" style={{ color: brandFallback.steel }}>
          {description}
        </p>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2" data-public-actions>
        <Link
          to="/guest/$hotelSlug/signin"
          params={{ hotelSlug }}
          search={{ next, mode: undefined }}
          className="inline-flex min-h-11 items-center px-4 text-sm font-semibold text-white"
          style={{ background: primary, borderRadius: buttonRadius(ws.button_style) }}
        >
          Sign in
        </Link>
        <Link
          to="/guest/$hotelSlug/signin"
          params={{ hotelSlug }}
          search={{ next, mode: "register" }}
          className="inline-flex min-h-11 items-center px-3 text-sm font-medium"
          style={{ color: primary }}
        >
          Create account
        </Link>
      </div>
    </section>
  );
}
