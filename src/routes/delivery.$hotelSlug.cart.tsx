import { createFileRoute, Link } from "@tanstack/react-router";
import { Loader2, Minus, Plus, ShoppingBag, Trash2, ArrowRight, Utensils } from "lucide-react";
import { PublicAppShell, PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { useCustomerSession } from "@/lib/public-session";
import { money, useMyPublicCart, useMyPublicCustomer, usePublicMenu, usePublicQuote, usePublicUpdateCartItem } from "@/lib/public-delivery";

export const Route = createFileRoute("/delivery/$hotelSlug/cart")({ component: CartPage });
type Row = Record<string, unknown>;

function CartPage() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { user, loading } = useCustomerSession();
  const customer = useMyPublicCustomer(ws.organization_id, user?.id);
  const customerId = customer.data?.["id"] as string | undefined;
  const cart = useMyPublicCart(ws.organization_id, customerId);
  const cartBranch = cart.data?.["branch_id"] as string | null | undefined;
  const differentProperty = Boolean(ws.branch_id && cartBranch && cartBranch !== ws.branch_id);
  const cartId = differentProperty ? undefined : cart.data?.["id"] as string | undefined;
  const menu = usePublicMenu(ws.organization_id, ws.branch_id ?? cartBranch ?? null,
    cart.data?.["fulfilment_type"] === "pickup" ? "pickup" : "delivery");
  const quote = usePublicQuote(cartId);
  const updateItem = usePublicUpdateCartItem();
  const menuById = new Map(((menu.data ?? []) as Row[]).map((row) => [String(row["id"]), row]));
  const items = (cart.data?.["cart_items"] as Row[] | undefined) ?? [];
  const count = items.reduce((sum, item) => sum + Number(item["quantity"] ?? 0), 0);
  const currency = quote.data?.currency ?? String(cart.data?.["currency"] ?? "KES");

  if (!loading && !user) return <PublicAppShell homeTo={{to:"/delivery/$hotelSlug",params:{hotelSlug}}}><GuestSignInPrompt hotelSlug={hotelSlug} title="Sign in to see your cart" description="Your cart follows your account securely across this hotel app." /></PublicAppShell>;

  return <PublicAppShell homeTo={{to:"/delivery/$hotelSlug",params:{hotelSlug}}} cartCount={differentProperty ? 0 : count}>
    <div className="neo-commerce-hero">
      <span className="neo-commerce-icon"><ShoppingBag className="size-5" /></span>
      <div><h1 className="neo-commerce-title">Cart</h1><p className="neo-commerce-copy">Review what you’re ordering from {ws.hotel_name || ws.app_name}.</p></div>
    </div>
    {loading || customer.isLoading || cart.isLoading ? <div className="flex justify-center py-16" role="status"><Loader2 className="size-6 animate-spin text-white/80" aria-hidden /><span className="sr-only">Loading cart</span></div>
      : customer.isError || cart.isError ? <PublicEmptyState title="Your cart couldn’t load" description="Try again to see the items saved to your account."
        action={<button className="neo-commerce-primary" onClick={() => void (customer.isError ? customer.refetch() : cart.refetch())}>Retry</button>} />
      : items.length > 0 && differentProperty ?
      <PublicEmptyState title="Your cart is at another property" description="Open the Delivery link for the property where you started this cart to continue." />
      : items.length > 0 && cart.data?.["fulfilment_type"] === "room-service" ?
      <PublicEmptyState title="Your basket is for room service" description="Review it in Stay & Dine."
        action={<Link to="/guest/$hotelSlug/order" params={{ hotelSlug: ws.guest_slug ?? hotelSlug }} search={{ item: undefined }} className="neo-commerce-primary">Open room service</Link>} />
      : items.length===0 ?
      <PublicEmptyState title="Your cart is empty" description="Save favourites for later or add something from the menu." action={<Link to="/delivery/$hotelSlug" params={{hotelSlug}} className="neo-commerce-primary">Browse menu</Link>} /> :
      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="neo-commerce-surface divide-y divide-black/5">
          {items.map(item=>{ const mi=(item["menu_items"] as Row|null)??menuById.get(String(item["menu_item_id"]))??{}; const qty=Number(item["quantity"]??1); return <article key={String(item["id"])} className="flex flex-wrap items-center gap-4 p-4 sm:p-5">
            <div className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-xl bg-slate-100 text-slate-600">
              {typeof mi["image_url"] === "string" && mi["image_url"] ? <img src={mi["image_url"]} alt="" loading="lazy" className="size-full object-cover" /> : <Utensils className="size-4" aria-hidden />}
            </div>
            <div className="min-w-0 flex-1"><h2 className="font-semibold text-slate-950">{String(mi["name"]??"Menu item")}</h2>
              {mi["base_price"] != null ? <p className="mt-1 text-sm text-slate-600">{money(mi["base_price"], currency)} base price</p> : null}
              {((item["cart_item_modifiers"] as Row[] | undefined) ?? []).map((option) => (
                <p key={String(option["id"] ?? option["option_id"])} className="text-xs text-slate-600">{String(option["option_name"] ?? "")}{Number(option["extra_charge"]) > 0 ? ` · +${money(option["extra_charge"], currency)}` : ""}</p>
              ))}
            </div>
            <div className="neo-quantity-control"><button disabled={updateItem.isPending} aria-label={qty===1 ? "Remove item" : "Decrease quantity"} onClick={()=>updateItem.mutate({id:String(item["id"]),quantity:qty-1})}>{qty===1?<Trash2 className="size-4"/>:<Minus className="size-4"/>}</button><strong>{qty}</strong><button disabled={updateItem.isPending} aria-label="Increase quantity" onClick={()=>updateItem.mutate({id:String(item["id"]),quantity:qty+1})}><Plus className="size-4"/></button></div>
          </article>})}
        </section>
        <aside className="neo-commerce-summary lg:sticky lg:top-24 lg:self-start"><h2 className="font-semibold text-slate-950">Order summary</h2><div className="mt-4 space-y-2 text-sm text-slate-600"><div className="flex justify-between"><span>Items</span><span>{count}</span></div>{quote.data && !quote.isError ? <><div className="flex justify-between"><span>Subtotal</span><span>{money(quote.data.subtotal, currency)}</span></div><div className="flex justify-between border-t border-black/5 pt-3 text-base font-bold text-slate-950"><span>Estimated total</span><span>{money(quote.data.grand_total, currency)}</span></div></>:quote.isError ? <button className="min-h-11 font-semibold underline" onClick={() => void quote.refetch()}>Total unavailable. Retry pricing</button> : null}</div>
          <Link to="/delivery/$hotelSlug/checkout" params={{hotelSlug}} className="neo-commerce-primary mt-5 w-full">Continue to checkout <ArrowRight className="size-4"/></Link>
          <Link to="/delivery/$hotelSlug" params={{hotelSlug}} className="mt-3 block text-center text-sm font-semibold text-slate-600 hover:text-slate-950">Continue browsing</Link>
        </aside>
      </div>}
  </PublicAppShell>;
}
