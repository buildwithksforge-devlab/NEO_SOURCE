import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Banknote, Loader2, Minus, Plus, Smartphone, Store, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  BrandButton,
  PublicAppShell,
  PublicEmptyState,
  useWorkspace,
} from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import {
  money,
  useMyPublicAddresses,
  useMyPublicCart,
  useMyPublicCustomer,
  useDeliveryMpesaCharge,
  usePublicDeliverySettings,
  usePublicMenu,
  usePublicPlaceOrder,
  usePublicQuote,
  usePublicUpdateCart,
  usePublicUpdateCartItem,
  usePublicZones,
  useSavePublicAddress,
} from "@/lib/public-delivery";
import { DELIVERY_CHECKOUT_METHODS, deliveryPaymentLabel } from "@/lib/payment-methods";
import { mpesaSupportsTotal } from "@/lib/mpesa-application-result";

export const Route = createFileRoute("/delivery/$hotelSlug/checkout")({
  component: CheckoutPage,
});

type Row = Record<string, unknown>;

function CheckoutPage() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const navigate = useNavigate();
  const { user, loading } = useCustomerSession();
  const customer = useMyPublicCustomer(ws.organization_id, user?.id);
  const customerId = customer.data?.["id"] as string | undefined;

  const cart = useMyPublicCart(ws.organization_id, customerId);
  const cartBranch = cart.data?.["branch_id"] as string | null | undefined;
  const differentProperty = Boolean(ws.branch_id && cartBranch && cartBranch !== ws.branch_id);
  const cartId = differentProperty ? undefined : cart.data?.["id"] as string | undefined;
  const branchId = ws.branch_id ?? cartBranch ?? null;
  const fulfilment = String(cart.data?.["fulfilment_type"] ?? "delivery");

  const zones = usePublicZones(ws.organization_id, branchId);
  const addresses = useMyPublicAddresses(ws.organization_id, customerId);
  const quote = usePublicQuote(cartId);
  const settings = usePublicDeliverySettings(ws.organization_id, branchId);
  // A customer cannot read the menu table directly — only the public menu
  // contract. Without this the cart rendered every line as "Item KES 0.00".
  const menu = usePublicMenu(ws.organization_id, branchId, fulfilment === "pickup" ? "pickup" : "delivery");
  const menuById = new Map(
    ((menu.data ?? []) as Row[]).map((row) => [String(row["id"]), row]),
  );

  const updateItem = usePublicUpdateCartItem();
  const updateCart = usePublicUpdateCart();
  const saveAddress = useSavePublicAddress(ws.organization_id, customerId);
  const placeOrder = usePublicPlaceOrder();

  const enabledModes = (["delivery", "pickup"] as const).filter(
    (mode) => settings.isSuccess && settings.data?.[mode === "pickup" ? "pickup_enabled" : "delivery_enabled"] === true,
  );
  const zoneById = new Map((zones.data ?? []).map((zone) => [String(zone["id"]), zone]));
  const deliveryAddressReady = zones.isSuccess && addresses.isSuccess &&
    zoneById.has(String(cart.data?.["zone_id"])) &&
    (addresses.data ?? []).some((address) => address["id"] === cart.data?.["address_id"] &&
      address["zone_id"] === cart.data?.["zone_id"]);

  // How the customer pays is the property's decision, not this screen's: the
  // list comes from what this property accepts for delivery, and cash only
  // appears where cash on delivery is switched on. Hotel bank or till accounts
  // are never shown to a customer — the account behind the method is resolved
  // in Finance.
  const methods = settings.data?.["allowed_payment_methods"];
  const configuredMethods = !settings.isError && !settings.isPending
    ? [
      ...(fulfilment === "pickup" ? ["pay-on-collection"] : []),
      ...DELIVERY_CHECKOUT_METHODS.filter(({ value }) => Array.isArray(methods) && methods.includes(value)
        && (value !== "cash" || (fulfilment === "delivery" && settings.data?.["cod_enabled"] === true
          && Number(quote.data?.grand_total) <= Number(settings.data?.["cod_limit"] ?? 0)))).map(({ value }) => value),
    ] : [];
  const [paymentMethod, setPaymentMethod] = useState("");
  const mpesaAmountReady = mpesaSupportsTotal(quote.data?.grand_total, quote.data?.currency ?? "KES");
  const availableMethods = configuredMethods.filter((method) => method !== "mpesa" || mpesaAmountReady);
  const activeMethod = availableMethods.includes(paymentMethod) ? paymentMethod : availableMethods.length === 1 ? availableMethods[0] : "";
  const [mpesaPhone, setMpesaPhone] = useState("");
  const charge = useDeliveryMpesaCharge();
  const [newAddress, setNewAddress] = useState({
    label: "Home",
    address_line: "",
    city: "",
    landmark: "",
    phone: "",
    zone_id: "",
  });
  const selectedZone = zoneById.get(newAddress.zone_id);
  const servedAreas = Array.isArray(selectedZone?.["areas"]) ? selectedZone["areas"].join(", ") : "";
  const [addressFormOpen, setAddressFormOpen] = useState(false);

  useEffect(() => {
    if (!newAddress.phone && customer.data?.["phone"]) {
      setNewAddress((a) => ({ ...a, phone: String(customer.data?.["phone"] ?? "") }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer.data]);

  const items = (cart.data?.["cart_items"] as Row[] | undefined) ?? [];

  if (!loading && !user) {
    return (
      <PublicAppShell deliveryTab="cart" homeTo={{ to: "/delivery/$hotelSlug", params: { hotelSlug } }}>
        <GuestSignInPrompt
          hotelSlug={hotelSlug}
          title="Sign in to continue"
          description="Sign in to securely review delivery details, payment and place your order."
        />
      </PublicAppShell>
    );
  }

  return (
    <PublicAppShell deliveryTab="cart" homeTo={{ to: "/delivery/$hotelSlug", params: { hotelSlug } }}>
      <div className="neo-delivery-page-heading">
        <div>
          <Link to="/delivery/$hotelSlug/cart" params={{ hotelSlug }} className="inline-flex min-h-11 items-center text-sm font-semibold text-white/90">← Back to cart</Link>
          <h1 className="neo-commerce-title">Checkout</h1>
          <p className="neo-commerce-copy">Confirm fulfilment, address and payment.</p>
        </div>
      </div>

      {loading || customer.isLoading || cart.isLoading ? (
        <div className="flex justify-center py-10 text-white" role="status">
          <Loader2 className="size-5 animate-spin" aria-hidden /><span className="sr-only">Loading checkout</span>
        </div>
      ) : customer.isError || cart.isError ? (
        <PublicEmptyState title="Checkout could not load" description="Your order has not been submitted here."
          action={<button className="neo-commerce-primary" onClick={() => void (customer.isError ? customer.refetch() : cart.refetch())}>Retry</button>} />
      ) : differentProperty && items.length > 0 ? (
        <PublicEmptyState title="This cart is at another property" description="Open the Delivery link for the property where you started this cart to continue." />
      ) : fulfilment === "room-service" && items.length > 0 ? (
        <PublicEmptyState title="Your basket is for room service" description="Review and submit it in Stay & Dine."
          action={<Link to="/guest/$hotelSlug/order" params={{ hotelSlug: ws.guest_slug ?? hotelSlug }} search={{ item: undefined }} className="neo-commerce-primary">Open room service</Link>} />
      ) : items.length === 0 ? (
        <div className="mt-4">
          <PublicEmptyState
            title="Your cart is empty"
            description="Add something from the menu to get started."
            action={
              <Link to="/delivery/$hotelSlug" params={{ hotelSlug }} className="neo-commerce-primary">Browse the menu</Link>
            }
          />
        </div>
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_340px]">
          <div className="space-y-4">
            <section className="rounded-2xl bg-white p-4 shadow-sm">
              {items.map((item) => {
                const quotedLine = quote.data?.lines.find((line) => line["cart_item_id"] === item["id"]);
                const menuItem =
                  (item["menu_items"] as Row | null) ??
                  menuById.get(String(item["menu_item_id"])) ??
                  {};
                const qty = Number(item["quantity"] ?? 1);
                return (
                  <div
                    key={String(item["id"])}
                    className="flex items-center gap-3 border-b border-black/5 py-3 last:border-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p
                        className="truncate text-sm font-medium"
                        style={{ color: brandFallback.secondary }}
                      >
                        {String(menuItem["name"] ?? "Item")}
                      </p>
                      <p className="text-xs" style={{ color: brandFallback.steel }}>
                        {quotedLine ? money(quotedLine["line_total"], quote.data?.currency ?? ws.currency ?? "KES") : menuItem["base_price"] != null ? `${money(menuItem["base_price"], ws.currency ?? "KES")} each` : "Pricing with your order"}
                      </p>
                      {((item["cart_item_modifiers"] as Row[] | undefined) ?? []).map((option) => (
                        <p key={String(option["id"] ?? option["option_id"])} className="text-xs text-slate-600">{String(option["option_name"] ?? "")}</p>
                      ))}
                      {item["special_instructions"] ? <p className="text-xs text-slate-600">{String(item["special_instructions"])}</p> : null}
                      {item["allergy_note"] ? <p className="text-xs font-medium text-slate-800">Allergy note: {String(item["allergy_note"])}</p> : null}
                    </div>
                    <div className="neo-quantity-control">
                      <button
                        type="button"
                        aria-label="Decrease quantity"
                        disabled={updateItem.isPending}
                        className="rounded-full border border-black/10 p-1.5"
                        onClick={() =>
                          updateItem.mutate({ id: String(item["id"]), quantity: qty - 1 })
                        }
                      >
                        {qty === 1 ? <Trash2 className="size-3.5" /> : <Minus className="size-3.5" />}
                      </button>
                      <span className="w-6 text-center text-sm">{qty}</span>
                      <button
                        type="button"
                        aria-label="Increase quantity"
                        disabled={updateItem.isPending}
                        className="rounded-full border border-black/10 p-1.5"
                        onClick={() =>
                          updateItem.mutate({ id: String(item["id"]), quantity: qty + 1 })
                        }
                      >
                        <Plus className="size-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </section>

            <section className="rounded-2xl bg-white p-4 shadow-sm">
              <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                How would you like it?
              </p>
              <div className="mt-3 flex gap-2">
                {(["delivery", "pickup"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={fulfilment === mode}
                    disabled={!enabledModes.includes(mode) || updateCart.isPending || settings.isFetching}
                    onClick={() => cartId && updateCart.mutate({
                      id: cartId,
                      fulfilment_type: mode,
                      ...(mode === "pickup" ? { address_id: null, zone_id: null } : {}),
                    })}
                    className="min-h-11 rounded-full border px-4 py-1.5 text-sm capitalize disabled:opacity-50"
                    style={{
                      borderColor: fulfilment === mode ? ws.primary_color : brandFallback.mist,
                      color: fulfilment === mode ? "var(--pa-accent-ink)" : brandFallback.steel,
                    }}
                  >
                    {mode === "pickup" ? "Collection" : "Delivery"}
                  </button>
                ))}
              </div>
              {settings.isSuccess && !enabledModes.some((mode) => mode === fulfilment) ? (
                <p role="status" className="mt-2 text-sm text-amber-800">
                  {enabledModes.length > 0 ? "Choose an available fulfilment method to continue." : "This property hasn’t enabled delivery or collection."}
                </p>
              ) : null}

              {fulfilment === "delivery" ? (
                <div className="mt-4 space-y-3">
                  {addresses.isError ? (
                    <button className="min-h-11 text-sm font-semibold underline" onClick={() => void addresses.refetch()}>
                      Saved addresses couldn’t load. Retry
                    </button>
                  ) : null}
                  {(addresses.data ?? []).map((address) => {
                    const id = String(address["id"]);
                    const selected = cart.data?.["address_id"] === id;
                    const zone = zoneById.get(String(address["zone_id"]));
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={selected}
                        disabled={!zones.isSuccess || !zone || updateCart.isPending}
                        onClick={() =>
                          cartId &&
                          updateCart.mutate({
                            id: cartId,
                            address_id: id,
                            zone_id: address["zone_id"] ?? null,
                          })
                        }
                        className="min-h-11 w-full rounded-xl border px-3 py-2 text-left text-sm disabled:opacity-70"
                        style={{
                          borderColor: selected ? ws.primary_color : brandFallback.mist,
                          color: brandFallback.secondary,
                        }}
                      >
                        <span className="font-medium">{String(address["label"] ?? "Address")}</span>
                        <span className="block text-xs" style={{ color: brandFallback.steel }}>
                          {String(address["address_line"] ?? "")} {String(address["landmark"] ?? "")}
                        </span>
                        {zones.isSuccess ? (
                          <span className="mt-1 block text-xs text-slate-600">
                            {zone ? String(zone["name"]) : "This saved address has no active zone for this property. Add it with a current zone."}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}

                  <details className="rounded-xl border border-black/5 px-3" open={addressFormOpen}
                    onToggle={(event) => setAddressFormOpen(event.currentTarget.open)}>
                    <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">
                      Add a delivery address
                    </summary>
                    <div className="grid gap-3 pb-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor="checkout-address-label">Label</Label>
                        <Input
                          id="checkout-address-label"
                          value={newAddress.label}
                          onChange={(e) => setNewAddress({ ...newAddress, label: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="checkout-address-phone">Phone</Label>
                        <Input
                          id="checkout-address-phone"
                          type="tel"
                          autoComplete="tel"
                          value={newAddress.phone}
                          onChange={(e) => setNewAddress({ ...newAddress, phone: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1 sm:col-span-2">
                        <Label htmlFor="checkout-address-line">Address</Label>
                        <Textarea
                          id="checkout-address-line"
                          autoComplete="street-address"
                          rows={2}
                          value={newAddress.address_line}
                          onChange={(e) =>
                            setNewAddress({ ...newAddress, address_line: e.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="checkout-address-city">Town or city</Label>
                        <Input
                          id="checkout-address-city"
                          autoComplete="address-level2"
                          value={newAddress.city}
                          placeholder="e.g. Nairobi"
                          onChange={(e) => setNewAddress({ ...newAddress, city: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="checkout-address-landmark">Landmark</Label>
                        <Input
                          id="checkout-address-landmark"
                          value={newAddress.landmark}
                          onChange={(e) =>
                            setNewAddress({ ...newAddress, landmark: e.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1 sm:col-span-2">
                        <Label htmlFor="checkout-zone">Delivery zone</Label>
                        <select
                          id="checkout-zone"
                          className="min-h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-base"
                          value={newAddress.zone_id}
                          onChange={(e) =>
                            setNewAddress({ ...newAddress, zone_id: e.target.value })
                          }
                        >
                          <option value="">Select a zone</option>
                          {(zones.data ?? []).map((z) => (
                            <option key={String(z["id"])} value={String(z["id"])}>
                              {String(z["name"])}{z["base_fee"] != null ? ` · from ${money(z["base_fee"], quote.data?.currency ?? ws.currency ?? "KES")}` : ""}{Number(z["eta_minutes"]) > 0 ? ` · ~${String(z["eta_minutes"])} min` : ""}
                            </option>
                          ))}
                        </select>
                        {zones.isError ? <button className="min-h-11 text-sm underline" onClick={() => void zones.refetch()}>Zones couldn’t load. Retry</button> :
                          <div className="space-y-1 text-sm text-slate-600">
                            {servedAreas ? <p>Areas served include {servedAreas}.</p> : null}
                            {selectedZone?.["description"] ? <p>{String(selectedZone["description"])}</p> : null}
                            <p>{zones.isSuccess && zoneById.size === 0
                              ? "This property has no active delivery zones."
                              : "Choose the zone that covers your address. Check the final delivery fee in your total."}</p>
                          </div>}
                      </div>
                      <div className="sm:col-span-2">
                        <BrandButton
                          disabled={
                            saveAddress.isPending || updateCart.isPending || !cartId ||
                            !zones.isSuccess || !selectedZone ||
                            !newAddress.address_line.trim() ||
                            !newAddress.city.trim()
                          }
                          onClick={async () => {
                            if (!cartId || !selectedZone) return;
                            try {
                              const id = await saveAddress.mutateAsync({
                                ...newAddress,
                                address_line: newAddress.address_line.trim(),
                                city: newAddress.city.trim(),
                                recipient_name: String(customer.data?.["full_name"] ?? ""),
                              });
                              setAddressFormOpen(false);
                              await updateCart.mutateAsync({
                                id: cartId,
                                address_id: id,
                                zone_id: newAddress.zone_id,
                              });
                              toast.success("Delivery address selected");
                            } catch {
                              // Each mutation reports the error. A saved address remains selectable.
                            }
                          }}
                        >
                          Save address
                        </BrandButton>
                      </div>
                    </div>
                  </details>
                </div>
              ) : (
                <p className="mt-3 text-xs" style={{ color: brandFallback.steel }}>
                  Collect your order at the restaurant counter. We will let you know when it is
                  ready.
                </p>
              )}

              <div className="mt-4 space-y-1">
                <Label htmlFor="checkout-kitchen-notes">Notes for the kitchen</Label>
                <Textarea
                  id="checkout-kitchen-notes"
                  rows={2}
                  defaultValue={String(cart.data?.["notes"] ?? "")}
                  onBlur={(e) => cartId && updateCart.mutate({ id: cartId, notes: e.target.value })}
                />
              </div>
            </section>
          </div>

          <aside className="h-fit rounded-2xl bg-white p-4 shadow-sm">
            <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
              Summary
            </p>
            {quote.isError ? (
              <div className="mt-3 space-y-3 text-sm text-slate-700" role="alert">
                <p>We couldn’t refresh your total.</p>
                <button className="neo-commerce-primary" onClick={() => void quote.refetch()}>Retry pricing</button>
              </div>
            ) : quote.isLoading ? (
              <div className="flex justify-center py-6">
                <Loader2 className="size-4 animate-spin" />
              </div>
            ) : quote.data ? (
              <div className="mt-3 space-y-2 text-sm" style={{ color: brandFallback.steel }}>
                <Line label="Subtotal" value={money(quote.data.subtotal, quote.data.currency ?? "KES")} />
                {quote.data.tax_breakdown?.map((tax) =>
                  <Line key={tax.label} label={tax.label} value={money(tax.amount, quote.data.currency ?? "KES")} />
                ) ?? (quote.data.tax_total > 0 ? <Line label="Tax included in subtotal" value={money(quote.data.tax_total, quote.data.currency ?? "KES")} /> : null)}
                {quote.data.service_charge ? (
                  <Line label="Service charge" value={money(quote.data.service_charge, quote.data.currency ?? "KES")} />
                ) : null}
                {fulfilment === "delivery" ? (
                  <Line label="Delivery fee" value={money(quote.data.delivery_fee, quote.data.currency ?? "KES")} />
                ) : null}
                {quote.data.discount_total ? (
                  <Line label="Discount" value={`- ${money(quote.data.discount_total, quote.data.currency ?? "KES")}`} />
                ) : null}
                {quote.data.tip_amount > 0 ? <Line label="Tip" value={money(quote.data.tip_amount, quote.data.currency ?? "KES")} /> : null}
                <div
                  className="flex items-center justify-between border-t border-black/5 pt-2 text-base font-semibold"
                  style={{ color: brandFallback.secondary }}
                >
                  <span>Total</span>
                  <span>{money(quote.data.grand_total, quote.data.currency ?? "KES")}</span>
                </div>
                {quote.data.eta_minutes ? (
                  <p className="text-xs">Estimated {quote.data.eta_minutes} minutes</p>
                ) : null}
                {quote.data.issues?.length ? (
                  <ul className="space-y-1 text-xs text-amber-700">
                    {quote.data.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                ) : null}

                <fieldset className="neo-delivery-payment">
                  <legend className="text-sm font-semibold text-slate-950">Payment method</legend>
                  {settings.isError ? (
                    <button className="mt-1 block min-h-11 text-sm font-semibold underline" onClick={() => void settings.refetch()}>Payment options couldn’t load. Retry</button>
                  ) : settings.isPending ? (
                    <p role="status" className="mt-1">Checking payment options…</p>
                  ) : configuredMethods.length ? (
                    <div className="neo-delivery-payment-options">
                      {configuredMethods.map((method) => {
                        const Icon = method === "mpesa" ? Smartphone : method === "cash" ? Banknote : Store;
                        const disabled = !availableMethods.includes(method);
                        return <label key={method} className="neo-delivery-payment-option" data-selected={method === activeMethod}>
                          <Icon className="size-5 shrink-0" aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block font-semibold">{deliveryPaymentLabel(method)}</span>
                            <span className="block text-xs text-slate-600">{disabled ? "Requires a positive whole KES total" : method === "mpesa" ? "Approve a prompt on your phone" : method === "cash" ? "Pay the rider on arrival" : "Pay at the counter"}</span>
                          </span>
                          <input type="radio" name="delivery-payment-method" value={method} checked={method === activeMethod} disabled={disabled} onChange={() => setPaymentMethod(method)} />
                        </label>;
                      })}
                    </div>
                  ) : (
                    <p className="mt-1 text-xs text-amber-700">
                      No payment method is available for this order.
                    </p>
                  )}
                </fieldset>


                {activeMethod === "mpesa" ? (
                  <div className="pt-3">
                    <Label htmlFor="mpesa-phone">M-Pesa number</Label>
                    <Input
                      id="mpesa-phone"
                      inputMode="tel"
                      autoComplete="tel"
                      placeholder="07xx xxx xxx"
                      className="mt-1"
                      value={mpesaPhone}
                      onChange={(e) => setMpesaPhone(e.target.value)}
                    />
                    <p className="mt-1 text-xs" style={{ color: brandFallback.steel }}>
                      We send the payment request to this number. Your order is only confirmed once
                      you approve it on your phone.
                    </p>
                  </div>
                ) : null}

                <BrandButton
                  className="mt-3 w-full"
                  disabled={
                    !quote.data.can_checkout || quote.isFetching || settings.isFetching ||
                    !enabledModes.some((mode) => mode === fulfilment) ||
                    (fulfilment === "delivery" && (!deliveryAddressReady || zones.isFetching || addresses.isFetching)) ||
                    updateCart.isPending || updateItem.isPending ||
                    placeOrder.isPending ||
                    charge.isPending ||
                    !cartId ||
                    !activeMethod ||
                    (activeMethod === "mpesa" && (!mpesaAmountReady || mpesaPhone.replace(/\D/g, "").length < 9))
                  }
                  onClick={async () => {
                    if (!cartId || !activeMethod) return;
                    let res;
                    try {
                      res = await placeOrder.mutateAsync({ cartId, paymentMethod: activeMethod });
                    } catch {
                      return; // The mutation reports the saved-order error.
                    }
                    if (activeMethod === "mpesa") {
                      // The order already exists, so a failed or broken payment
                      // request must still land the guest on the order page —
                      // that is where they can send the request again.
                      try {
                        const result = await charge.mutateAsync({
                          orderId: res.delivery_order_id,
                          msisdn: mpesaPhone,
                        });
                        if (result.ok) {
                          toast.success(result.detail);
                        } else {
                          toast.error(`${result.detail} Check the saved attempt on your order page before starting another prompt.`);
                        }
                      } catch {
                        toast.error(
                          "The prompt outcome could not be confirmed. Check the saved attempt on your order page before starting another prompt.",
                        );
                      }
                    } else {
                      toast.success(`Order ${res.order_number} placed`);
                    }
                    void navigate({
                      to: "/delivery/$hotelSlug/track/$orderReference",
                      params: { hotelSlug, orderReference: res.order_number },
                    });
                  }}
                >
                  {placeOrder.isPending || charge.isPending
                    ? activeMethod === "mpesa"
                      ? "Sending payment request…"
                      : "Placing order…"
                    : activeMethod === "mpesa"
                      ? "Place order and pay"
                      : "Place order"}
                </BrandButton>
              </div>
            ) : (
              <p className="mt-3 text-xs" style={{ color: brandFallback.steel }}>
                Totals appear once your order can be priced.
              </p>
            )}
          </aside>
        </div>
      )}
    </PublicAppShell>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
