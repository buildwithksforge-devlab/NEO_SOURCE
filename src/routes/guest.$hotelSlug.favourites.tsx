import { createFileRoute, Link } from "@tanstack/react-router";
import { Heart, Loader2, UtensilsCrossed } from "lucide-react";
import { GuestScreen } from "@/components/public/GuestScreen";
import { PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { useCustomerSession } from "@/lib/public-session";
import { useGuestProfile } from "@/lib/guest-app";
import { useGuestFavourites, useToggleFavourite } from "@/lib/guest-ordering";
import { money, usePublicMenu } from "@/lib/public-delivery";

type Row=Record<string,unknown>;
export const Route=createFileRoute("/guest/$hotelSlug/favourites")({component:FavouritesPage});
function FavouritesPage(){
 const ws=useWorkspace(); const {hotelSlug}=Route.useParams(); const {user}=useCustomerSession();
 const profile=useGuestProfile(ws.organization_id,user?.id,ws.branch_id); const customerId=profile.data?.["id"] as string|undefined;
 const fav=useGuestFavourites(ws.organization_id,customerId); const toggle=useToggleFavourite(ws.organization_id,customerId); const menu=usePublicMenu(ws.organization_id,ws.branch_id);
 const ids=new Set((fav.data??[]).map(x=>String(x["menu_item_id"]))); const items=((menu.data??[]) as Row[]).filter(x=>ids.has(String(x["id"])));
 return <GuestScreen hotelSlug={hotelSlug} active="explore"><div className="neo-commerce-hero"><span className="neo-commerce-icon"><Heart className="size-5"/></span><div><p className="neo-commerce-eyebrow">Saved for you</p><h1 className="neo-commerce-title">Favourites</h1><p className="neo-commerce-copy">Keep the dishes you love close, then order when you are ready.</p></div></div>
 {fav.isLoading||menu.isLoading?<div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-white/80"/></div>:items.length===0?<div className="mt-6"><PublicEmptyState title="No favourites yet" description="Tap the heart on a dish to save it here." action={<Link to="/guest/$hotelSlug/explore" params={{hotelSlug}} search={{}} className="neo-commerce-primary">Explore dining</Link>}/></div>:<div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{items.map(item=><article key={String(item["id"])} className="neo-commerce-surface p-5"><div className="flex items-start justify-between gap-3"><span className="grid size-11 place-items-center rounded-2xl bg-slate-100 text-slate-700"><UtensilsCrossed className="size-5"/></span><button aria-label="Remove favourite" className="grid size-10 place-items-center rounded-full bg-rose-50 text-rose-600" onClick={()=>toggle.mutate({menuItemId:String(item["id"])})}><Heart className="size-4" fill="currentColor"/></button></div><h2 className="mt-5 font-semibold text-slate-950">{String(item["name"]??"Dish")}</h2><p className="mt-1 line-clamp-2 text-sm text-slate-600">{String(item["description"]??"")}</p><div className="mt-5 flex items-center justify-between gap-3"><strong className="text-slate-950">{money(item["base_price"])}</strong><Link to="/guest/$hotelSlug/order" params={{hotelSlug}} search={{item:String(item["id"])}} className="rounded-full border border-slate-200 px-4 py-2 text-sm font-bold text-slate-800">Order</Link></div></article>)}</div>}
 </GuestScreen>;
}
