/**
 * The hotel's guest sign-in page — the single place the guest form exists.
 *
 * It returns the guest to the page they were trying to open, and only ever to
 * a path inside this site.
 */
import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { GuestScreen } from "@/components/public/GuestScreen";
import { CustomerAuthPanel } from "@/components/public/CustomerAuthPanel";
import { useWorkspace } from "@/components/public/PublicAppShell";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";

export const Route = createFileRoute("/guest/$hotelSlug/signin")({
  validateSearch: (search: Record<string, unknown>) => {
    const raw = typeof search["next"] === "string" ? (search["next"] as string) : "";
    return {
      next: raw.startsWith("/") && !raw.startsWith("//") ? raw : undefined,
      mode: search["mode"] === "register" ? ("register" as const) : undefined,
    };
  },
  head: () => ({
    meta: [
      { title: "Sign in — NEØ Guest" },
      { name: "description", content: "Sign in to see your stay, orders and charges." },
      { property: "og:title", content: "Sign in — NEØ Guest" },
      { property: "og:description", content: "Sign in to see your stay, orders and charges." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: GuestSignInPage,
});

function GuestSignInPage() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { next, mode } = Route.useSearch();
  const navigate = useNavigate();
  const { user, loading } = useCustomerSession();
  const heading = mode === "register" ? "Create your guest account" : "Sign in to your stay";

  useEffect(() => {
    if (loading || !user) return;
    if (next) navigate({ href: next, replace: true });
    else navigate({ to: "/guest/$hotelSlug", params: { hotelSlug }, replace: true });
  }, [loading, user, next, navigate, hotelSlug]);

  return (
    <GuestScreen hotelSlug={hotelSlug} active="account">
      <div className="mx-auto w-full max-w-md py-6">
        <h1 className="text-2xl font-semibold" style={{ color: brandFallback.secondary }}>
          {heading}
        </h1>
        <p className="mt-2 text-sm" style={{ color: brandFallback.steel }}>
          Your stay, orders and charges with {ws.hotel_name} are kept private to your account.
        </p>
        <div className="neo-rider-card mt-5 p-5 sm:p-6">
          <CustomerAuthPanel initialMode={mode === "register" ? "register" : "signin"} />
        </div>
      </div>
    </GuestScreen>
  );
}
