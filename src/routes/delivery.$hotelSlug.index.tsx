import { useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, Loader2, Search, UtensilsCrossed } from "lucide-react";
import {
  BrandButton,
  PublicAppShell,
  PublicEmptyState,
  useWorkspace,
} from "@/components/public/PublicAppShell";
import { DeliveryItemSheet } from "@/components/public/DeliveryItemSheet";
import { Input } from "@/components/ui/input";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import {
  money,
  useMyPublicCart,
  useMyPublicCustomer,
  usePublicAddToCart,
  usePublicBranches,
  usePublicMenu,
} from "@/lib/public-delivery";

export const Route = createFileRoute("/delivery/$hotelSlug/")({
  validateSearch: (search): { item?: string } =>
    typeof search["item"] === "string" ? { item: search["item"] } : {},
  component: DeliveryHome,
});

type Row = Record<string, unknown>;

function DeliveryHome() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { item: selectedItemId } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { user, loading } = useCustomerSession();
  const customer = useMyPublicCustomer(ws.organization_id, user?.id);
  const customerId = customer.data?.["id"] as string | undefined;

  const branches = usePublicBranches(ws.organization_id, ws.branch_id);
  const [branchId, setBranchId] = useState<string | null>(ws.branch_id);
  const activeBranch = branchId ?? (branches.data?.[0]?.["id"] as string | undefined) ?? null;

  const cart = useMyPublicCart(ws.organization_id, customerId);
  const fulfilment = cart.data?.["fulfilment_type"] === "pickup" ? "pickup" : "delivery";
  const menu = usePublicMenu(ws.organization_id, activeBranch, fulfilment);
  const addToCart = usePublicAddToCart(ws.organization_id, customerId);

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const selectedItem = selectedItemId ? menu.data?.find((item) => item["id"] === selectedItemId) : undefined;
  const changeSelectedItem = (item?: string) => void navigate({ search: item ? { item } : {}, replace: true, resetScroll: false });

  const categories = useMemo(() => ["All", ...new Set(((menu.data ?? []) as Row[]).map(
    (item) => String((item["menu_categories"] as Row | null)?.["name"] ?? "Menu"),
  ))].sort((a, b) => a === "All" ? -1 : b === "All" ? 1 : a.localeCompare(b)), [menu.data]);

  const grouped = useMemo(() => {
    const items = (menu.data ?? []) as Row[];
    const filtered = items.filter((i) => {
      const itemCategory = String((i["menu_categories"] as Row | null)?.["name"] ?? "Menu");
      const term = query.trim().toLowerCase();
      return (category === "All" || category === itemCategory) && (!term ||
        `${String(i["name"] ?? "")} ${String(i["description"] ?? "")}`.toLowerCase().includes(term));
    });
    const map = new Map<string, Row[]>();
    for (const item of filtered) {
      const cat =
        ((item["menu_categories"] as Row | null)?.["name"] as string | undefined) ?? "Menu";
      map.set(cat, [...(map.get(cat) ?? []), item]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [menu.data, query, category]);

  const cartCount = ((cart.data?.["cart_items"] as Row[] | undefined) ?? []).reduce(
    (sum, i) => sum + Number(i["quantity"] ?? 0),
    0,
  );
  const roomServiceCart = cartCount > 0 && cart.data?.["fulfilment_type"] === "room-service";
  const otherBranchCart = cartCount > 0 && Boolean(cart.data?.["branch_id"]) && cart.data?.["branch_id"] !== activeBranch;
  const cannotAdd = loading || Boolean(user && !customerId) || cart.isLoading || cart.isError || roomServiceCart || otherBranchCart;

  return (
    <PublicAppShell
      homeTo={{ to: "/delivery/$hotelSlug", params: { hotelSlug } }}
      cartCount={otherBranchCart || roomServiceCart ? 0 : cartCount}
    >
      <section className="neo-commerce-hero neo-delivery-cover relative overflow-hidden">
        {ws.hero_url ? <img src={ws.hero_url} alt="" fetchPriority="high" className="absolute inset-y-0 right-0 h-full w-full object-cover sm:w-3/5" /> : null}
        {ws.hero_url ? <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-slate-950 via-slate-950/90 to-slate-950/55 sm:to-slate-950/10" /> : null}
        <div className="relative z-10 max-w-2xl">
        <h1 className="neo-commerce-title">
          {ws.welcome_title || `Order from ${ws.hotel_name}`}
        </h1>
        <p className="neo-commerce-copy mt-3">
          {ws.welcome_message || "Choose delivery or collection and track your order."}
        </p>
        </div>
        {!ws.hero_url ? <UtensilsCrossed className="pointer-events-none absolute -bottom-12 -right-8 size-56 rotate-12 text-white/[0.08]" aria-hidden /> : null}
      </section>

      <section className="mt-5 space-y-3" aria-label="Find food">

        {(branches.data?.length ?? 0) > 1 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {(branches.data ?? []).map((b) => {
              const id = b["id"] as string;
              const active = id === activeBranch;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setBranchId(id)}
                  aria-pressed={active}
                  className="min-h-11 rounded-full border px-3 py-1.5 text-sm"
                  style={{
                    borderColor: active ? ws.primary_color : brandFallback.mist,
                    color: active ? "var(--pa-accent-ink)" : brandFallback.steel,
                    background: active ? `${ws.primary_color}14` : "transparent",
                  }}
                >
                  {String(b["name"] ?? "Branch")}
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="relative">
          <Search
            className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-slate-600"
            style={{ color: brandFallback.steel }}
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the menu"
            aria-label="Search the menu"
            type="search"
            className="min-h-12 rounded-2xl border-0 bg-white pr-4 pl-11 text-base text-slate-950"
          />
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Menu categories">
          {categories.map((name) => (
            <button key={name} type="button" onClick={() => setCategory(name)}
              aria-pressed={category === name}
              className={`min-h-11 shrink-0 rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${category === name ? "border-transparent bg-[var(--pa-primary)] text-[var(--pa-on-primary)]" : "border-white/25 bg-white/10 text-white hover:bg-white/20"}`}>
              {name}
            </button>
          ))}
        </div>
      </section>

      {roomServiceCart || otherBranchCart ? <div className="mt-5">
        <PublicEmptyState title={roomServiceCart ? "You have a room-service basket" : "You have a basket at another branch"}
          description="Finish or clear that basket before adding items from this menu."
          action={roomServiceCart
            ? <Link to="/guest/$hotelSlug/order" params={{ hotelSlug: ws.guest_slug ?? hotelSlug }} search={{ item: undefined }} className="neo-commerce-primary">Open room service</Link>
            : <Link to="/delivery/$hotelSlug/cart" params={{ hotelSlug }} className="neo-commerce-primary">Review cart</Link>} />
      </div> : null}

      <section className="mt-6 space-y-6">
        {menu.isLoading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="size-5 animate-spin" style={{ color: brandFallback.steel }} />
          </div>
        ) : menu.isError ? (
          <PublicEmptyState
            title="Menu unavailable"
            description="We could not load the menu right now."
            action={<BrandButton onClick={() => void menu.refetch()}>Retry menu</BrandButton>}
          />
        ) : grouped.length === 0 ? (
          <PublicEmptyState
            title={query || category !== "All" ? "No matching dishes" : "No items published yet"}
            description={query || category !== "All" ? "Try another search or category." : "This restaurant has not published any delivery items for this branch."}
            action={query || category !== "All" ? <BrandButton variant="outline" onClick={() => { setQuery(""); setCategory("All"); }}>Show all dishes</BrandButton> : undefined}
          />
        ) : (
          grouped.map(([category, items]) => (
            <div key={category}>
              <h2 className="mb-3 text-xl font-bold tracking-tight text-white">
                {category}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {items.map((item) => {
                  const available = String(item["availability"] ?? "available") === "available";
                  return (
                    <button
                      key={String(item["id"])}
                      type="button"
                      aria-haspopup="dialog"
                      onClick={() => changeSelectedItem(String(item["id"]))}
                      className="neo-delivery-dish group grid min-w-0 grid-cols-[minmax(0,1fr)_33%] overflow-hidden rounded-2xl bg-white text-left sm:flex sm:flex-col-reverse"
                    >
                      <span className="flex min-w-0 flex-1 flex-col p-4">
                        <span className="break-words text-base font-bold leading-tight text-slate-950">
                          {String(item["name"] ?? "")}
                        </span>
                        {item["description"] ? (
                          <span className="mt-1 line-clamp-2 text-sm text-slate-600">
                            {String(item["description"])}
                          </span>
                        ) : null}
                        <span className="mt-auto flex min-w-0 flex-wrap items-center justify-between gap-2 pt-3 text-sm font-semibold text-slate-900">
                          <span>{money(item["base_price"], ws.currency ?? "KES")}</span>
                          {available ? <ChevronRight className="size-4 text-slate-600" aria-hidden /> : <span className="text-xs text-slate-600">Unavailable</span>}
                        </span>
                      </span>
                      {item["image_url"] ? (
                        <img
                          src={String(item["image_url"])}
                          alt=""
                          loading="lazy"
                          className="size-full min-h-24 object-cover sm:aspect-[4/3] sm:h-auto"
                        />
                      ) : <span className="neo-delivery-dish-placeholder grid min-h-24 w-full place-items-center sm:aspect-[4/3]" aria-hidden><UtensilsCrossed className="size-7" /></span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </section>
      {selectedItem ? <DeliveryItemSheet
        key={String(selectedItem["id"])}
        item={{
          id: String(selectedItem["id"]), name: String(selectedItem["name"]),
          description: String(selectedItem["description"] ?? ""), price: Number(selectedItem["base_price"]),
          image: typeof selectedItem["image_url"] === "string" ? selectedItem["image_url"] : null,
          currency: ws.currency ?? "KES",
        }}
        pending={addToCart.isPending}
        disabled={cannotAdd}
        available={String(selectedItem["availability"] ?? "available") === "available"}
        onSignIn={!user && !loading ? () => {
          const next = `/delivery/${encodeURIComponent(hotelSlug)}?${new URLSearchParams({ item: String(selectedItem["id"]) })}`;
          void navigate({ to: "/guest/$hotelSlug/signin", params: { hotelSlug: ws.guest_slug ?? hotelSlug }, search: { next, mode: undefined } });
        } : undefined}
        onClose={() => changeSelectedItem()}
        onAdd={(options) => addToCart.mutate({
          ...options, branchId: activeBranch, menuItemId: String(selectedItem["id"]),
          fulfilment,
        }, { onSuccess: () => changeSelectedItem() })}
      /> : null}
    </PublicAppShell>
  );
}
