import { createFileRoute, Link } from "@tanstack/react-router";
import { Heart, Loader2, UtensilsCrossed } from "lucide-react";
import { GuestPageIntro, GuestScreen } from "@/components/public/GuestScreen";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { useCustomerSession } from "@/lib/public-session";
import { useGuestProfile } from "@/lib/guest-app";
import { useGuestFavourites, useToggleFavourite } from "@/lib/guest-ordering";
import { money, usePublicMenu } from "@/lib/public-delivery";

export const Route = createFileRoute("/guest/$hotelSlug/favourites")({ component: FavouritesPage });

function FavouritesPage() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { user, loading } = useCustomerSession();
  const profile = useGuestProfile(ws.organization_id, user?.id, ws.branch_id);
  const customerId = profile.data?.["id"] as string | undefined;
  const favourites = useGuestFavourites(ws.organization_id, customerId);
  const toggle = useToggleFavourite(ws.organization_id, customerId);
  const menu = usePublicMenu(ws.organization_id, ws.branch_id);
  const ids = new Set((favourites.data ?? []).map((entry) => String(entry["menu_item_id"])));
  const items = (menu.data ?? []).filter((item) => ids.has(String(item["id"])));

  return (
    <GuestScreen hotelSlug={hotelSlug} active="favourites">
      <GuestPageIntro title="Favourites" description="Your saved dishes at this hotel.">
        <Link to="/guest/$hotelSlug/explore" params={{ hotelSlug }} search={{ section: "dining" }} className="neo-guest-outline-action">Back to dining</Link>
      </GuestPageIntro>
      {loading || profile.isLoading || favourites.isLoading || (user && menu.isLoading) ? (
        <div role="status" className="flex justify-center py-12"><Loader2 className="size-6 animate-spin" aria-label="Loading favourites" /></div>
      ) : !user ? (
        <GuestSignInPrompt hotelSlug={hotelSlug} title="Sign in for favourites" description="Save dishes for your next order." />
      ) : profile.isError || !customerId || favourites.isError || menu.isError ? (
        <PublicEmptyState title="Favourites could not load" description="Refresh your saved dishes."
          action={<button type="button" className="neo-guest-secondary" onClick={() => void Promise.all([profile.refetch(), favourites.refetch(), menu.refetch()])}>Try again</button>} />
      ) : items.length === 0 ? (
        <PublicEmptyState title="No favourites available" description="Tap the heart on a dish in Dining to save it here." />
      ) : (
        <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <li key={String(item["id"])} className="neo-guest-task-panel">
              <div className="flex items-start justify-between gap-3">
                <UtensilsCrossed className="size-5" aria-hidden />
                <button type="button" aria-label={`Remove ${String(item["name"])} from favourites`}
                  className="grid size-11 place-items-center rounded-full bg-rose-50 text-rose-600"
                  disabled={toggle.isPending} onClick={() => toggle.mutate({ menuItemId: String(item["id"]) })}>
                  <Heart className="size-4" fill="currentColor" aria-hidden />
                </button>
              </div>
              <h2 className="font-semibold">{String(item["name"] ?? "Dish")}</h2>
              <p className="mt-1 text-sm text-[var(--guest-muted)]">{String(item["description"] ?? "")}</p>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <strong>{money(item["base_price"], ws.currency ?? "KES")}</strong>
                <Link to="/guest/$hotelSlug/order" params={{ hotelSlug }} search={{ item: String(item["id"]) }} className="neo-guest-outline-action">Order</Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </GuestScreen>
  );
}
