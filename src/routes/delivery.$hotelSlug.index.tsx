import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Loader2, Search, ShoppingBag, UtensilsCrossed } from "lucide-react";
import {
  BrandButton,
  PublicAppShell,
  PublicEmptyState,
  useWorkspace,
} from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
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
  component: DeliveryHome,
});

type Row = Record<string, unknown>;

function DeliveryHome() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { user, loading } = useCustomerSession();
  const customer = useMyPublicCustomer(ws.organization_id, user?.id);
  const customerId = customer.data?.["id"] as string | undefined;

  const branches = usePublicBranches(ws.organization_id, ws.branch_id);
  const [branchId, setBranchId] = useState<string | null>(ws.branch_id);
  const activeBranch = branchId ?? (branches.data?.[0]?.["id"] as string | undefined) ?? null;

  const menu = usePublicMenu(ws.organization_id, activeBranch);
  const cart = useMyPublicCart(ws.organization_id, customerId);
  const addToCart = usePublicAddToCart(ws.organization_id, customerId);

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");

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

  return (
    <PublicAppShell
      homeTo={{ to: "/delivery/$hotelSlug", params: { hotelSlug } }}
      nav={
        <div className="flex items-center gap-2">
          <Link
            to="/delivery/$hotelSlug/orders"
            params={{ hotelSlug }}
            className="text-sm font-medium"
            style={{ color: brandFallback.steel }}
          >
            My orders
          </Link>
          <Link to="/delivery/$hotelSlug/cart" params={{ hotelSlug }}>
            <BrandButton>
              <ShoppingBag className="size-4" />
              {cartCount > 0 ? cartCount : "Cart"}
            </BrandButton>
          </Link>
        </div>
      }
    >
      <section className="neo-commerce-hero relative overflow-hidden">
        <div className="relative z-10 max-w-2xl">
        <p className="neo-commerce-eyebrow">Fresh from the kitchen</p>
        <h1 className="neo-commerce-title">
          {ws.welcome_title || `Order from ${ws.hotel_name}`}
        </h1>
        <p className="neo-commerce-copy mt-3">
          {ws.welcome_message ||
            "Browse the live kitchen menu, order for delivery or collection, and track it in real time."}
        </p>
        <div className="mt-5 flex flex-wrap gap-2 text-xs font-semibold text-white/90">
          <span className="rounded-full border border-white/25 bg-white/10 px-3 py-1.5">Live menu</span>
          <span className="rounded-full border border-white/25 bg-white/10 px-3 py-1.5">Delivery & collection</span>
          <span className="rounded-full border border-white/25 bg-white/10 px-3 py-1.5">Track your order</span>
        </div>
        </div>
        <UtensilsCrossed className="pointer-events-none absolute -bottom-12 -right-8 size-56 rotate-12 text-white/[0.08]" aria-hidden />
      </section>

      <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5" aria-label="Find food">

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
                  className="rounded-full border px-3 py-1.5 text-sm"
                  style={{
                    borderColor: active ? ws.primary_color : brandFallback.mist,
                    color: active ? ws.primary_color : brandFallback.steel,
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
            className="absolute left-3 top-1/2 size-4 -translate-y-1/2"
            style={{ color: brandFallback.steel }}
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the menu"
            aria-label="Search the menu"
            className="pl-9"
          />
        </div>
        <div className="mt-4 flex gap-2 overflow-x-auto pb-1" aria-label="Menu categories">
          {categories.map((name) => (
            <button key={name} type="button" onClick={() => setCategory(name)}
              aria-pressed={category === name}
              className={`shrink-0 rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${category === name ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"}`}>
              {name}
            </button>
          ))}
        </div>
      </section>

      {!loading && !user ? (
        <GuestSignInPrompt
          hotelSlug={hotelSlug}
          title="Sign in to place an order"
          description="Browse freely, then sign in once so the property can confirm and track your order."
        />
      ) : null}

      <section className="mt-6 space-y-6">
        {menu.isLoading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="size-5 animate-spin" style={{ color: brandFallback.steel }} />
          </div>
        ) : menu.isError ? (
          <PublicEmptyState
            title="Menu unavailable"
            description="We could not load the menu right now. Please refresh in a moment."
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
              <h2 className="mb-3 text-xl font-bold tracking-tight" style={{ color: brandFallback.secondary }}>
                {category}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {items.map((item) => {
                  const available = String(item["availability"] ?? "available") === "available";
                  return (
                    <article
                      key={String(item["id"])}
                      className="group flex min-w-0 gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md"
                    >
                      {item["image_url"] ? (
                        <img
                          src={String(item["image_url"])}
                          alt={String(item["name"] ?? "Menu item")}
                          loading="lazy"
                          className="size-24 shrink-0 rounded-xl object-cover sm:size-28"
                        />
                      ) : <div className="flex size-24 shrink-0 items-center justify-center rounded-xl bg-slate-100 sm:size-28" aria-hidden><UtensilsCrossed className="size-7 text-slate-400" /></div>}
                      <div className="min-w-0 flex-1">
                        <p
                           className="break-words text-base font-bold"
                          style={{ color: brandFallback.secondary }}
                        >
                          {String(item["name"] ?? "")}
                        </p>
                        {item["description"] ? (
                          <p
                            className="mt-1 line-clamp-2 text-xs"
                            style={{ color: brandFallback.steel }}
                          >
                            {String(item["description"])}
                          </p>
                        ) : null}
                        <div className="mt-3 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                          <span
                            className="text-sm font-semibold"
                            style={{ color: brandFallback.secondary }}
                          >
                            {money(item["base_price"])}
                          </span>
                          {available ? (
                            <BrandButton
                              disabled={Boolean(customerId) && addToCart.isPending}
                              onClick={() =>
                                customerId ? addToCart.mutate({
                                  branchId: activeBranch,
                                  menuItemId: String(item["id"]),
                                }) : window.location.assign(`/guest/${encodeURIComponent(hotelSlug)}/signin?next=${encodeURIComponent(`/delivery/${hotelSlug}`)}`)
                              }
                            >
                              {customerId ? "Add" : <><span>Sign in to add</span><ArrowRight className="ml-1 size-4" aria-hidden /></>}
                            </BrandButton>
                          ) : (
                            <span className="text-xs" style={{ color: brandFallback.steel }}>
                              Unavailable
                            </span>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </section>
    </PublicAppShell>
  );
}
