import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Heart, Loader2, Minus, Plus, UtensilsCrossed } from "lucide-react";
import { toast } from "sonner";
import { GuestScreen, GuestSection } from "@/components/public/GuestScreen";
import { PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import { money } from "@/lib/public-delivery";
import { useGuestProfile, useGuestScreenView } from "@/lib/guest-app";
import { isPreviewMode } from "@/lib/preview-mode";
import {
  fulfilmentLabels,
  useGuestActiveStay,
  useGuestCart,
  useGuestCartMutations,
  useGuestFavourites,
  useGuestMenu,
  useGuestQuote,
  usePlaceDeliveryOrder,
  usePlaceRoomServiceOrder,
  useGuestMenuModifiers,
  useToggleFavourite,
  type FulfilmentType,
  type GuestModifierGroup,
  type PublicMenuItem,
} from "@/lib/guest-ordering";

export const Route = createFileRoute("/guest/$hotelSlug/order")({
  validateSearch: (search: Record<string, unknown>) => ({
    item: typeof search["item"] === "string" ? search["item"] : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Order Food — NEØ Guest" },
      { name: "description", content: "Order room service, collection or delivery from the property's live kitchen menu." },
      { property: "og:title", content: "Order Food — NEØ Guest" },
      { property: "og:description", content: "Order room service, collection or delivery from the property's live kitchen menu." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: OrderPage,
});

function OrderPage() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { item: requestedItem } = Route.useSearch();
  const navigate = useNavigate();
  const preview = isPreviewMode();
  const { user, loading } = useCustomerSession();
  const profile = useGuestProfile(ws.organization_id, user?.id, ws.branch_id);
  const customerId = profile.data?.["id"] as string | undefined;

  const stay = useGuestActiveStay(ws.organization_id, Boolean(customerId));
  const inHouse = Boolean(stay.data?.reservation_id);
  const [fulfilment, setFulfilment] = useState<FulfilmentType | null>(null);
  const activeFulfilment: FulfilmentType = fulfilment ?? (inHouse ? "room-service" : "delivery");

  const menu = useGuestMenu(ws.organization_id, ws.branch_id ?? null, activeFulfilment);
  const cart = useGuestCart(ws.organization_id, customerId);
  const cartId = cart.data?.["id"] as string | undefined;
  const cartItems = (cart.data?.["cart_items"] as Record<string, unknown>[] | undefined) ?? [];
  const quote = useGuestQuote(cartId);
  const { addItem, setQuantity } = useGuestCartMutations(ws.organization_id, customerId, ws.branch_id ?? null);
  const menuItemIds = (menu.data ?? []).map((m) => m.id);
  const modifiers = useGuestMenuModifiers(ws.organization_id, menuItemIds);
  const [customising, setCustomising] = useState<string | null>(null);
  const favourites = useGuestFavourites(ws.organization_id, customerId);
  const toggleFavourite = useToggleFavourite(ws.organization_id, customerId);
  const placeRoomService = usePlaceRoomServiceOrder();
  const placeDelivery = usePlaceDeliveryOrder();
  useGuestScreenView(ws.organization_id, "order", Boolean(customerId));

  const selectedItem = requestedItem && menu.data?.some((entry) => entry.id === requestedItem)
    ? requestedItem
    : null;
  const activeCustomiser = customising ?? selectedItem;

  const [paymentIntent, setPaymentIntent] = useState<"room-charge" | "pay-at-property">("room-charge");
  const busy = placeRoomService.isPending || placeDelivery.isPending;

  const grouped = new Map<string, PublicMenuItem[]>();
  for (const item of menu.data ?? []) {
    const key = item.category_name ?? "Menu";
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  const itemById = new Map((menu.data ?? []).map((i) => [i.id, i]));
  const favouriteByItem = new Map(
    (favourites.data ?? []).map((f) => [String(f["menu_item_id"]), String(f["id"])]),
  );

  async function checkout() {
    if (!cartId) return;
    try {
      if (activeFulfilment === "room-service") {
        const result = await placeRoomService.mutateAsync({ cartId, paymentIntent });
        toast.success(
          result.charged_to_room
            ? `Order ${result.order_number} sent to the kitchen and charged to your room`
            : `Order ${result.order_number} sent to the kitchen`,
        );
        void navigate({
          to: "/guest/$hotelSlug/orders/$orderReference",
          params: { hotelSlug, orderReference: result.order_number },
        });
        return;
      }
      const result = await placeDelivery.mutateAsync({
        cartId,
        paymentMethod: activeFulfilment === "pickup" ? "pay-on-collection" : "cash",
      });
      toast.success(`Order ${result.order_number} placed`);
      void navigate({
        to: "/guest/$hotelSlug/orders/$orderReference",
        params: { hotelSlug, orderReference: result.order_number },
      });
    } catch {
      /* surfaced by the mutation's error toast */
    }
  }

  return (
    <GuestScreen hotelSlug={hotelSlug} active="explore">
      <section className="rounded-2xl bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold" style={{ color: brandFallback.secondary }}>
          Order food
        </h1>
        <p className="mt-2 text-sm" style={{ color: brandFallback.steel }}>
          Straight to {ws.hotel_name}'s kitchen — the same order the chefs and cashiers see.
        </p>
      </section>

      {!loading && !user ? (
        <GuestSignInPrompt
          hotelSlug={hotelSlug}
          title="Sign in to order"
          description="Your basket, saved dishes, checkout and live order updates stay with your hotel account."
        />
      ) : (
        <>
          <GuestSection title="How would you like it?">
            <div className="flex flex-wrap gap-2">
              {(["room-service", "pickup", "delivery"] as FulfilmentType[]).map((option) => {
                const disabled = option === "room-service" && !inHouse;
                const isActive = option === activeFulfilment;
                return (
                  <button
                    key={option}
                    type="button"
                    disabled={disabled}
                    onClick={() => setFulfilment(option)}
                    className="rounded-full border px-3.5 py-2 text-xs font-medium disabled:opacity-40"
                    style={{
                      borderColor: isActive ? ws.primary_color : "rgba(0,0,0,0.1)",
                      color: isActive ? ws.primary_color : brandFallback.steel,
                    }}
                  >
                    {fulfilmentLabels[option]}
                  </button>
                );
              })}
            </div>
            {activeFulfilment === "room-service" ? (
              <p className="mt-3 text-xs" style={{ color: brandFallback.steel }}>
                {inHouse
                  ? `Room ${stay.data?.room_number ?? "—"} · stay ${stay.data?.confirmation_number}`
                  : "Room service is available once you are checked in."}
              </p>
            ) : null}
          </GuestSection>

          <GuestSection title="Menu" description="Published, currently available items only.">
            {menu.isLoading ? (
              <div className="flex justify-center py-6">
                <Loader2 className="size-5 animate-spin" style={{ color: brandFallback.steel }} />
              </div>
            ) : (menu.data?.length ?? 0) === 0 ? (
              <PublicEmptyState
                title="Nothing available for this option"
                description="The property has not published items for this fulfilment type."
              />
            ) : (
              <div className="space-y-6">
                {[...grouped.entries()].map(([category, items]) => (
                  <div key={category}>
                    <p
                      className="text-xs font-semibold uppercase tracking-wide"
                      style={{ color: brandFallback.steel }}
                    >
                      {category}
                    </p>
                    <ul className="mt-2 space-y-2">
                      {items.map((item) => {
                        const favouriteId = favouriteByItem.get(item.id) ?? null;
                        return (
                          <li key={item.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-black/5 p-3">
                            {item.image_url ? (
                              <img src={item.image_url} alt={item.name} className="size-14 rounded-lg object-cover" />
                            ) : (
                              <span className="flex size-14 items-center justify-center rounded-lg bg-black/5">
                                <UtensilsCrossed className="size-5" style={{ color: brandFallback.steel }} />
                              </span>
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-medium" style={{ color: brandFallback.secondary }}>
                                {item.name}
                              </span>
                              <span className="block truncate text-xs" style={{ color: brandFallback.steel }}>
                                {item.description ?? ""}
                              </span>
                              <span className="mt-1 block text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                                {money(item.base_price)}
                              </span>
                            </span>
                            <span className="flex items-center gap-1">
                              <button
                                type="button"
                                aria-label={favouriteId ? "Remove favourite" : "Save as favourite"}
                                onClick={() => toggleFavourite.mutate({ menuItemId: item.id, favouriteId })}
                                className="rounded-full p-2"
                              >
                                <Heart
                                  className="size-4"
                                  style={{ color: favouriteId ? ws.primary_color : brandFallback.steel }}
                                  fill={favouriteId ? ws.primary_color : "none"}
                                  aria-hidden
                                />
                              </button>
                              <button
                                type="button"
                                 onClick={() => setCustomising(activeCustomiser === item.id ? null : item.id)}
                                disabled={addItem.isPending}
                                className="rounded-full px-3 py-1.5 text-xs font-semibold text-white"
                                style={{ background: ws.primary_color || brandFallback.primary }}
                              >
                                Add
                              </button>
                            </span>
                             {activeCustomiser === item.id ? (
                              <ItemCustomiser
                                groups={(modifiers.data ?? {})[item.id] ?? []}
                                accent={ws.primary_color || brandFallback.primary}
                                busy={addItem.isPending}
                                onCancel={() => setCustomising(null)}
                                onAdd={(payload) => {
                                  addItem.mutate(
                                    { fulfilment: activeFulfilment, menuItemId: item.id, ...payload },
                                    { onSuccess: () => setCustomising(null) },
                                  );
                                }}
                              />
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </GuestSection>

          <GuestSection title="Your order">
            {cartItems.length === 0 ? (
              <PublicEmptyState title="Your basket is empty" description="Add something from the menu above." />
            ) : (
              <>
                <ul className="divide-y divide-black/5">
                  {cartItems.map((line) => {
                    const item = itemById.get(String(line["menu_item_id"]));
                    const quantity = Number(line["quantity"] ?? 1);
                    return (
                      <li key={String(line["id"])} className="flex items-center justify-between gap-3 py-3">
                        <span className="min-w-0">
                          <span className="block text-sm font-medium" style={{ color: brandFallback.secondary }}>
                            {item?.name ?? "Item"}
                          </span>
                          {line["special_instructions"] ? (
                            <span className="block text-xs" style={{ color: brandFallback.steel }}>
                              {String(line["special_instructions"])}
                            </span>
                          ) : null}
                          {line["allergy_note"] ? (
                            <span className="block text-xs font-semibold" style={{ color: "#B3261E" }}>
                              Allergy: {String(line["allergy_note"])}
                            </span>
                          ) : null}
                        </span>
                        <span className="flex items-center gap-2">
                          <button
                            type="button"
                            aria-label="Decrease quantity"
                            onClick={() => setQuantity.mutate({ id: String(line["id"]), quantity: quantity - 1 })}
                            className="rounded-full border border-black/10 p-1.5"
                          >
                            <Minus className="size-3.5" style={{ color: brandFallback.steel }} aria-hidden />
                          </button>
                          <span className="w-5 text-center text-sm">{quantity}</span>
                          <button
                            type="button"
                            aria-label="Increase quantity"
                            onClick={() => setQuantity.mutate({ id: String(line["id"]), quantity: quantity + 1 })}
                            className="rounded-full border border-black/10 p-1.5"
                          >
                            <Plus className="size-3.5" style={{ color: brandFallback.steel }} aria-hidden />
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ul>

                {quote.data ? (
                  <dl className="mt-4 space-y-1.5 text-sm">
                    <Line label="Subtotal" value={money(quote.data.subtotal)} />
                    <Line label="Tax" value={money(quote.data.tax_total)} />
                    {quote.data.service_charge ? (
                      <Line label="Service charge" value={money(quote.data.service_charge)} />
                    ) : null}
                    {quote.data.discount_total ? (
                      <Line label="Discount" value={`- ${money(quote.data.discount_total)}`} />
                    ) : null}
                    {quote.data.delivery_fee ? (
                      <Line label="Delivery" value={money(quote.data.delivery_fee)} />
                    ) : null}
                    <Line label="Total" value={money(quote.data.grand_total)} strong />
                  </dl>
                ) : null}

                {quote.data?.issues?.length ? (
                  <ul className="mt-3 space-y-1 text-xs text-amber-700">
                    {quote.data.issues.map((issue) => (
                      <li key={issue}>{issue.replace(/-/g, " ")}</li>
                    ))}
                  </ul>
                ) : null}

                {activeFulfilment === "room-service" ? (
                  <div className="mt-4 space-y-2">
                    <p className="text-xs font-medium" style={{ color: brandFallback.steel }}>
                      Payment
                    </p>
                    {(
                      [
                        { value: "room-charge", label: "Charge to my room" },
                        { value: "pay-at-property", label: "Pay on delivery / at the desk" },
                      ] as const
                    ).map((option) => (
                      <label key={option.value} className="flex items-center gap-2 text-sm">
                        <input
                          type="radio"
                          name="payment-intent"
                          value={option.value}
                          checked={paymentIntent === option.value}
                          onChange={() => setPaymentIntent(option.value)}
                          disabled={option.value === "room-charge" && !stay.data?.can_charge_to_room}
                        />
                        <span style={{ color: brandFallback.secondary }}>{option.label}</span>
                      </label>
                    ))}
                    {!stay.data?.can_charge_to_room ? (
                      <p className="text-xs" style={{ color: brandFallback.steel }}>
                        Room charging is not open on your folio — the property will settle this order at the desk.
                      </p>
                    ) : null}
                  </div>
                ) : null}

                <button
                  type="button"
                  onClick={() => void checkout()}
                  disabled={busy || preview || quote.data?.can_checkout === false}
                  className="mt-5 w-full rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
                  style={{ background: ws.primary_color || brandFallback.primary }}
                >
                  {busy ? "Sending to the kitchen…" : preview ? "Preview only" : "Place order"}
                </button>
              </>
            )}
          </GuestSection>
        </>
      )}
    </GuestScreen>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <dt style={{ color: brandFallback.steel }}>{label}</dt>
      <dd className={strong ? "font-semibold" : ""} style={{ color: brandFallback.secondary }}>
        {value}
      </dd>
    </div>
  );
}

/**
 * Per-item customisation. Options come from the property's published option
 * groups; the guest never states a price, so the extra charges shown here are
 * repriced by the database when the line is added.
 */
function ItemCustomiser({
  groups,
  accent,
  busy,
  onAdd,
  onCancel,
}: {
  groups: GuestModifierGroup[];
  accent: string;
  busy: boolean;
  onAdd: (payload: { optionIds: string[]; specialInstructions?: string | undefined; allergyNote?: string | undefined }) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [instructions, setInstructions] = useState("");
  const [allergy, setAllergy] = useState("");

  const toggle = (group: GuestModifierGroup, optionId: string) => {
    setSelected((prev) => {
      const ids = new Set(group.options.map((o) => o.option_id));
      if (group.multi_select) {
        return prev.includes(optionId) ? prev.filter((x) => x !== optionId) : [...prev, optionId];
      }
      return [...prev.filter((x) => !ids.has(x)), optionId];
    });
  };

  const missing = groups.filter(
    (g) => g.required && !g.options.some((o) => selected.includes(o.option_id)),
  );

  return (
    <div className="mt-3 w-full space-y-3 rounded-xl bg-black/[0.03] p-3">
      {groups.map((group) => (
        <fieldset key={group.group_id}>
          <legend className="text-xs font-semibold" style={{ color: brandFallback.secondary }}>
            {group.name}
            {group.required ? " · required" : ""}
          </legend>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {group.options.map((option) => {
              const on = selected.includes(option.option_id);
              return (
                <button
                  key={option.option_id}
                  type="button"
                  onClick={() => toggle(group, option.option_id)}
                  className="rounded-full border px-3 py-1 text-xs"
                  style={{
                    borderColor: on ? accent : "rgba(0,0,0,0.12)",
                    color: on ? accent : brandFallback.steel,
                    fontWeight: on ? 600 : 400,
                  }}
                >
                  {option.name}
                  {option.extra_charge ? ` +${money(option.extra_charge)}` : ""}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}

      <label className="block text-xs" style={{ color: brandFallback.steel }}>
        Special instructions
        <input
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="e.g. no onions, extra hot"
          className="mt-1 w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm"
        />
      </label>

      <label className="block text-xs" style={{ color: brandFallback.steel }}>
        Allergy note — the kitchen sees this on the ticket
        <input
          value={allergy}
          onChange={(e) => setAllergy(e.target.value)}
          placeholder="e.g. severe nut allergy"
          className="mt-1 w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm"
        />
      </label>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || missing.length > 0}
          onClick={() =>
            onAdd({
              optionIds: selected,
              specialInstructions: instructions.trim() || undefined,
              allergyNote: allergy.trim() || undefined,
            })
          }
          className="rounded-full px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          style={{ background: accent }}
        >
          {busy ? "Adding…" : "Add to basket"}
        </button>
        <button type="button" onClick={onCancel} className="text-xs" style={{ color: brandFallback.steel }}>
          Cancel
        </button>
        {missing.length ? (
          <span className="text-xs" style={{ color: brandFallback.steel }}>
            Choose {missing.map((g) => g.name).join(", ")}
          </span>
        ) : null}
      </div>
    </div>
  );
}
