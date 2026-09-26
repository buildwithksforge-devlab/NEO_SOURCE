import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Loader2, Minus, Plus, Trash2 } from "lucide-react";
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
import { paymentMethodLabel } from "@/lib/payment-methods";

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
  const cartId = cart.data?.["id"] as string | undefined;
  const branchId = (cart.data?.["branch_id"] as string | null) ?? ws.branch_id;

  const zones = usePublicZones(ws.organization_id, branchId);
  const addresses = useMyPublicAddresses(ws.organization_id, customerId);
  const quote = usePublicQuote(cartId);
  const settings = usePublicDeliverySettings(ws.organization_id, branchId);
  // A customer cannot read the menu table directly — only the public menu
  // contract. Without this the cart rendered every line as "Item KES 0.00".
  const menu = usePublicMenu(ws.organization_id, branchId);
  const menuById = new Map(
    ((menu.data ?? []) as Row[]).map((row) => [String(row["id"]), row]),
  );

  const updateItem = usePublicUpdateCartItem();
  const updateCart = usePublicUpdateCart();
  const saveAddress = useSavePublicAddress(ws.organization_id, customerId);
  const placeOrder = usePublicPlaceOrder();

  const fulfilment = String(cart.data?.["fulfilment_type"] ?? "delivery");

  // How the customer pays is the property's decision, not this screen's: the
  // list comes from what this property accepts for delivery, and cash only
  // appears where cash on delivery is switched on. Hotel bank or till accounts
  // are never shown to a customer — the account behind the method is resolved
  // in Finance.
  const configuredMethods = ((settings.data?.["allowed_payment_methods"] as string[] | null) ?? [
    "cash",
  ]).filter((m) => m !== "cash" || settings.data?.["cod_enabled"] !== false);
  const [paymentMethod, setPaymentMethod] = useState("");
  const activeMethod = paymentMethod || configuredMethods[0] || "";
  const [mpesaPhone, setMpesaPhone] = useState("");
  const charge = useDeliveryMpesaCharge();
  const [newAddress, setNewAddress] = useState({
    label: "Home",
    address_line: "",
    house_number: "",
    city: "",
    landmark: "",
    phone: "",
    zone_id: "",
  });

  useEffect(() => {
    if (!newAddress.phone && customer.data?.["phone"]) {
      setNewAddress((a) => ({ ...a, phone: String(customer.data?.["phone"] ?? "") }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer.data]);

  const items = (cart.data?.["cart_items"] as Row[] | undefined) ?? [];

  if (!loading && !user) {
    return (
      <PublicAppShell homeTo={{ to: "/delivery/$hotelSlug", params: { hotelSlug } }}>
        <GuestSignInPrompt
          hotelSlug={hotelSlug}
          title="Sign in to continue"
          description="Sign in to securely review delivery details, payment and place your order."
        />
      </PublicAppShell>
    );
  }

  return (
    <PublicAppShell homeTo={{ to: "/delivery/$hotelSlug", params: { hotelSlug } }}>
      <div className="neo-commerce-hero">
        <div>
          <p className="neo-commerce-eyebrow">Secure order</p>
          <h1 className="neo-commerce-title">Checkout</h1>
          <p className="neo-commerce-copy">Confirm fulfilment, address and payment. Your order is created once; payment retries never duplicate it.</p>
          <ol className="mt-4 flex flex-wrap gap-2 text-xs font-bold text-white/80" aria-label="Checkout progress">
            <li className="rounded-full bg-white/15 px-3 py-1.5">1 · Details</li><li className="rounded-full bg-white/15 px-3 py-1.5">2 · Payment</li><li className="rounded-full bg-white/15 px-3 py-1.5">3 · Confirmation</li>
          </ol>
        </div>
      </div>

      {cart.isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin" style={{ color: brandFallback.steel }} />
        </div>
      ) : items.length === 0 ? (
        <div className="mt-4">
          <PublicEmptyState
            title="Your cart is empty"
            description="Add something from the menu to get started."
            action={
              <Link to="/delivery/$hotelSlug" params={{ hotelSlug }}>
                <BrandButton>Browse the menu</BrandButton>
              </Link>
            }
          />
        </div>
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_340px]">
          <div className="space-y-4">
            <section className="rounded-2xl bg-white p-4 shadow-sm">
              {items.map((item) => {
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
                        {money(menuItem["base_price"])} each
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-label="Decrease quantity"
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
                    onClick={() => cartId && updateCart.mutate({ id: cartId, fulfilment_type: mode })}
                    className="rounded-full border px-4 py-1.5 text-sm capitalize"
                    style={{
                      borderColor: fulfilment === mode ? ws.primary_color : brandFallback.mist,
                      color: fulfilment === mode ? ws.primary_color : brandFallback.steel,
                    }}
                  >
                    {mode === "pickup" ? "Collection" : "Delivery"}
                  </button>
                ))}
              </div>

              {fulfilment === "delivery" ? (
                <div className="mt-4 space-y-3">
                  {(addresses.data ?? []).map((address) => {
                    const id = String(address["id"]);
                    const selected = cart.data?.["address_id"] === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() =>
                          cartId &&
                          updateCart.mutate({
                            id: cartId,
                            address_id: id,
                            zone_id: address["zone_id"] ?? null,
                          })
                        }
                        className="w-full rounded-xl border px-3 py-2 text-left text-sm"
                        style={{
                          borderColor: selected ? ws.primary_color : brandFallback.mist,
                          color: brandFallback.secondary,
                        }}
                      >
                        <span className="font-medium">{String(address["label"] ?? "Address")}</span>
                        <span className="block text-xs" style={{ color: brandFallback.steel }}>
                          {String(address["address_line"] ?? "")} {String(address["landmark"] ?? "")}
                        </span>
                      </button>
                    );
                  })}

                  <details className="rounded-xl border border-black/5 p-3">
                    <summary className="cursor-pointer text-sm font-medium">
                      Add a delivery address
                    </summary>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label>Label</Label>
                        <Input
                          value={newAddress.label}
                          onChange={(e) => setNewAddress({ ...newAddress, label: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label>Phone</Label>
                        <Input
                          value={newAddress.phone}
                          onChange={(e) => setNewAddress({ ...newAddress, phone: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1 sm:col-span-2">
                        <Label>Address</Label>
                        <Textarea
                          rows={2}
                          value={newAddress.address_line}
                          onChange={(e) =>
                            setNewAddress({ ...newAddress, address_line: e.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label>Town or city</Label>
                        <Input
                          value={newAddress.city}
                          placeholder="e.g. Nairobi"
                          onChange={(e) => setNewAddress({ ...newAddress, city: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label>Landmark</Label>
                        <Input
                          value={newAddress.landmark}
                          onChange={(e) =>
                            setNewAddress({ ...newAddress, landmark: e.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label>Delivery zone</Label>
                        <select
                          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                          value={newAddress.zone_id}
                          onChange={(e) =>
                            setNewAddress({ ...newAddress, zone_id: e.target.value })
                          }
                        >
                          <option value="">Select a zone</option>
                          {(zones.data ?? []).map((z) => (
                            <option key={String(z["id"])} value={String(z["id"])}>
                              {String(z["name"])}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="sm:col-span-2">
                        <BrandButton
                          disabled={
                            saveAddress.isPending ||
                            !newAddress.address_line.trim() ||
                            !newAddress.city.trim()
                          }
                          onClick={async () => {
                            const id = await saveAddress.mutateAsync({
                              label: newAddress.label,
                              address_line: newAddress.address_line,
                              city: newAddress.city.trim(),
                              landmark: newAddress.landmark,
                              phone: newAddress.phone,
                              recipient_name: String(customer.data?.["full_name"] ?? ""),
                              zone_id: newAddress.zone_id || null,
                            });
                            if (cartId) {
                              updateCart.mutate({
                                id: cartId,
                                address_id: id,
                                zone_id: newAddress.zone_id || null,
                              });
                            }
                            toast.success("Address saved");
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
                <Label>Notes for the kitchen</Label>
                <Textarea
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
            {quote.isLoading ? (
              <div className="flex justify-center py-6">
                <Loader2 className="size-4 animate-spin" />
              </div>
            ) : quote.data ? (
              <div className="mt-3 space-y-2 text-sm" style={{ color: brandFallback.steel }}>
                <Line label="Subtotal" value={money(quote.data.subtotal)} />
                <Line label="Tax" value={money(quote.data.tax_total)} />
                {quote.data.service_charge ? (
                  <Line label="Service charge" value={money(quote.data.service_charge)} />
                ) : null}
                {fulfilment === "delivery" ? (
                  <Line label="Delivery fee" value={money(quote.data.delivery_fee)} />
                ) : null}
                {quote.data.discount_total ? (
                  <Line label="Discount" value={`- ${money(quote.data.discount_total)}`} />
                ) : null}
                <div
                  className="flex items-center justify-between border-t border-black/5 pt-2 text-base font-semibold"
                  style={{ color: brandFallback.secondary }}
                >
                  <span>Total</span>
                  <span>{money(quote.data.grand_total)}</span>
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

                <div className="pt-3">
                  <Label>Payment</Label>
                  {configuredMethods.length ? (
                    <select
                      className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={activeMethod}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                    >
                      {configuredMethods.map((m) => (
                        <option key={m} value={m}>
                          {m === "cash" ? "Cash on delivery" : paymentMethodLabel(m)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="mt-1 text-xs text-amber-700">
                      This property has not set up a way to pay online yet.
                    </p>
                  )}
                </div>


                {activeMethod === "mpesa" ? (
                  <div className="pt-3">
                    <Label htmlFor="mpesa-phone">M-Pesa number</Label>
                    <Input
                      id="mpesa-phone"
                      inputMode="tel"
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
                    !quote.data.can_checkout ||
                    placeOrder.isPending ||
                    charge.isPending ||
                    !cartId ||
                    !activeMethod ||
                    (activeMethod === "mpesa" && mpesaPhone.replace(/\D/g, "").length < 9)
                  }
                  onClick={async () => {
                    if (!cartId) return;
                    const res = await placeOrder.mutateAsync({ cartId, paymentMethod: activeMethod });
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
                          toast.error(`${result.detail} You can try again on your order page.`);
                        }
                      } catch {
                        toast.error(
                          "We could not send the payment request. You can try again on your order page.",
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
