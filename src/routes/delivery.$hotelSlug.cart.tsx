import { createFileRoute, Link } from "@tanstack/react-router";
import { Loader2, Minus, Plus, ShoppingBag, Trash2, ArrowRight } from "lucide-react";
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
  const cartId = cart.data?.["id"] as string | undefined;
  const branchId = (cart.data?.["branch_id"] as string | null) ?? ws.branch_id;
  const menu = usePublicMenu(ws.organization_id, branchId);
  const quote = usePublicQuote(cartId);
  const updateItem = usePublicUpdateCartItem();
  const menuById = new Map(((menu.data ?? []) as Row[]).map((row) => [String(row["id"]), row]));
  const items = (cart.data?.["cart_items"] as Row[] | undefined) ?? [];

  if (!loading && !user) return <PublicAppShell homeTo={{to:"/delivery/$hotelSlug",params:{hotelSlug}}}><GuestSignInPrompt hotelSlug={hotelSlug} title="Sign in to see your cart" description="Your cart follows your account securely across this hotel app." /></PublicAppShell>;

  return <PublicAppShell homeTo={{to:"/delivery/$hotelSlug",params:{hotelSlug}}}>
    <div className="neo-commerce-hero">
      <span className="neo-commerce-icon"><ShoppingBag className="size-5" /></span>
      <div><p className="neo-commerce-eyebrow">Your selection</p><h1 className="neo-commerce-title">Cart</h1><p className="neo-commerce-copy">Review quantities here. Delivery details and payment belong on Checkout.</p></div>
    </div>
    {cart.isLoading ? <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-white/80" /></div> : items.length===0 ?
      <PublicEmptyState title="Your cart is empty" description="Save favourites for later or add something from the menu." action={<Link to="/delivery/$hotelSlug" params={{hotelSlug}} className="neo-commerce-primary">Browse menu</Link>} /> :
      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="neo-commerce-surface divide-y divide-black/5">
          {items.map(item=>{ const mi=(item["menu_items"] as Row|null)??menuById.get(String(item["menu_item_id"]))??{}; const qty=Number(item["quantity"]??1); return <article key={String(item["id"])} className="flex items-center gap-4 p-4 sm:p-5">
            <div className="min-w-0 flex-1"><h2 className="truncate font-semibold text-slate-950">{String(mi["name"]??"Item")}</h2><p className="mt-1 text-sm text-slate-600">{money(mi["base_price"])} each</p></div>
            <div className="neo-quantity-control"><button aria-label="Decrease quantity" onClick={()=>updateItem.mutate({id:String(item["id"]),quantity:qty-1})}>{qty===1?<Trash2 className="size-4"/>:<Minus className="size-4"/>}</button><strong>{qty}</strong><button aria-label="Increase quantity" onClick={()=>updateItem.mutate({id:String(item["id"]),quantity:qty+1})}><Plus className="size-4"/></button></div>
          </article>})}
        </section>
        <aside className="neo-commerce-summary lg:sticky lg:top-24 lg:self-start"><p className="neo-commerce-eyebrow text-slate-500">Order summary</p><div className="mt-4 space-y-2 text-sm text-slate-600"><div className="flex justify-between"><span>Items</span><span>{items.length}</span></div>{quote.data ? <><div className="flex justify-between"><span>Subtotal</span><span>{money(quote.data.subtotal)}</span></div><div className="flex justify-between border-t border-black/5 pt-3 text-base font-bold text-slate-950"><span>Estimated total</span><span>{money(quote.data.grand_total)}</span></div></>:null}</div>
          <Link to="/delivery/$hotelSlug/checkout" params={{hotelSlug}} className="neo-commerce-primary mt-5 w-full">Continue to checkout <ArrowRight className="size-4"/></Link>
          <Link to="/delivery/$hotelSlug" params={{hotelSlug}} className="mt-3 block text-center text-sm font-semibold text-slate-600 hover:text-slate-950">Continue browsing</Link>
        </aside>
      </div>}
  </PublicAppShell>;
}
