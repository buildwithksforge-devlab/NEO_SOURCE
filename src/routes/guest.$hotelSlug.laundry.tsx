import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2, Shirt } from "lucide-react";
import { toast } from "sonner";
import { GuestScreen, GuestSection } from "@/components/public/GuestScreen";
import { BrandButton, PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { GuestSignInPrompt } from "@/components/public/GuestSignInPrompt";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import { money } from "@/lib/public-delivery";
import { useGuestProfile, useGuestScreenView, useMyStays } from "@/lib/guest-app";
import {
  handoverLabels,
  laundryRefusals,
  laundryStatusLabels,
  useLaundryOffering,
  useMyLaundry,
  usePlaceLaundryOrder,
  type HandoverMode,
} from "@/lib/guest-laundry";

export const Route = createFileRoute("/guest/$hotelSlug/laundry")({
  head: () => ({
    meta: [
      { title: "Laundry — NEØ Guest" },
      {
        name: "description",
        content: "Send laundry to the hotel's laundry team, from your room or as a walk-in customer.",
      },
      { property: "og:title", content: "Laundry — NEØ Guest" },
      {
        property: "og:description",
        content: "Send laundry to the hotel's laundry team, from your room or as a walk-in customer.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuestLaundryPage,
});

function GuestLaundryPage() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { user, loading } = useCustomerSession();
  const profile = useGuestProfile(ws.organization_id, user?.id, ws.branch_id);
  const customerId = profile.data?.["id"] as string | undefined;
  const offering = useLaundryOffering(ws.organization_id, ws.branch_id);
  const stays = useMyStays(ws.organization_id, Boolean(customerId));
  const mine = useMyLaundry(ws.organization_id, Boolean(customerId));
  const place = usePlaceLaundryOrder(ws.organization_id);
  useGuestScreenView(ws.organization_id, "laundry", Boolean(customerId));

  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [express, setExpress] = useState(false);
  const [handover, setHandover] = useState<HandoverMode>("drop_off");
  const [reservationId, setReservationId] = useState<string>("");
  const [instructions, setInstructions] = useState("");

  const items = offering.data?.items ?? [];
  const activeStays = (stays.data ?? []).filter((s) =>
    ["confirmed", "checked_in", "in_house"].includes(String(s["status"])),
  );

  const estimate = useMemo(
    () =>
      items.reduce((total, item) => {
        const qty = quantities[item.id] ?? 0;
        if (qty <= 0) return total;
        const unit = express && item.express_price > 0 ? item.express_price : item.normal_price;
        const line = qty * unit;
        return total + line + (line * (item.tax_rate ?? 0)) / 100;
      }, 0),
    [items, quantities, express],
  );

  const chosen = items
    .filter((item) => (quantities[item.id] ?? 0) > 0)
    .map((item) => ({ price_item_id: item.id, quantity: quantities[item.id] as number }));

  async function submit() {
    if (!ws.branch_id || chosen.length === 0) return;
    try {
      const result = await place.mutateAsync({
        branchId: ws.branch_id,
        items: chosen,
        express,
        handover,
        reservationId: reservationId || null,
        instructions,
        channel: "NEO_APP",
      });
      if (!result.ok) {
        toast.error(laundryRefusals[result.reason] ?? "We could not place that laundry order.");
        return;
      }
      setQuantities({});
      setInstructions("");
      toast.success(
        result.payment_intent === "charge_to_room"
          ? `Laundry ${result.laundry_number} sent — it will be charged to your room.`
          : `Laundry ${result.laundry_number} sent — ${money(result.total)} payable to the hotel.`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not place that laundry order.");
    }
  }

  if (!loading && !user) {
    return (
      <GuestScreen hotelSlug={hotelSlug} active="trips">
        <GuestSignInPrompt hotelSlug={hotelSlug} title="Sign in to use laundry" description="See the hotel's live price list and keep every request with your stay history." />
      </GuestScreen>
    );
  }

  return (
    <GuestScreen hotelSlug={hotelSlug} active="trips">
      <section className="rounded-2xl bg-white p-6 shadow-sm">
        <h1 className="flex items-center gap-2 text-2xl font-semibold" style={{ color: brandFallback.secondary }}>
          <Shirt className="size-6" aria-hidden /> Laundry
        </h1>
        <p className="mt-2 text-sm" style={{ color: brandFallback.steel }}>
          Your items go straight to this hotel's laundry team and follow their normal washing, quality-check and
          return process.
        </p>
      </section>

      {offering.isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin" style={{ color: brandFallback.steel }} />
        </div>
      ) : !offering.data?.enabled ? (
        <GuestSection title="Not available yet">
          <PublicEmptyState
            title="Laundry is not offered here"
            description="This hotel has not switched on customer laundry."
          />
        </GuestSection>
      ) : items.length === 0 ? (
        <GuestSection title="Price list not published">
          <PublicEmptyState
            title="No laundry prices configured"
            description="The hotel still has to publish its laundry price list."
          />
        </GuestSection>
      ) : (
        <>
          <GuestSection title="What are you sending?" description="Prices are the hotel's published laundry rates.">
            <ul className="space-y-2">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-black/5 p-3"
                >
                  <div>
                    <p className="text-sm font-medium" style={{ color: brandFallback.secondary }}>
                      {item.name}
                    </p>
                    <p className="text-xs" style={{ color: brandFallback.steel }}>
                      {item.service_type} · {money(express && item.express_price > 0 ? item.express_price : item.normal_price)} ·{" "}
                      {item.turnaround_hours}h
                    </p>
                  </div>
                  <Input
                    type="number"
                    min={0}
                    className="w-20"
                    value={quantities[item.id] ?? 0}
                    onChange={(e) =>
                      setQuantities((prev) => ({ ...prev, [item.id]: Math.max(0, Number(e.target.value) || 0) }))
                    }
                    aria-label={`Quantity for ${item.name}`}
                  />
                </li>
              ))}
            </ul>
          </GuestSection>

          <GuestSection title="How should it be handled?">
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {(["drop_off", "collection", "delivery"] as HandoverMode[])
                  .filter(
                    (mode) =>
                      mode === "drop_off" ||
                      (mode === "collection" && (offering.data?.collection || activeStays.length > 0)) ||
                      (mode === "delivery" && offering.data?.delivery),
                  )
                  .map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setHandover(mode)}
                      className="rounded-full border px-3 py-1.5 text-xs font-medium"
                      style={{
                        borderColor: handover === mode ? ws.primary_color : "rgba(0,0,0,0.1)",
                        color: handover === mode ? ws.primary_color : brandFallback.steel,
                      }}
                    >
                      {handoverLabels[mode]}
                    </button>
                  ))}
              </div>

              <label className="flex items-center gap-2 text-sm" style={{ color: brandFallback.secondary }}>
                <input type="checkbox" checked={express} onChange={(e) => setExpress(e.target.checked)} />
                Express service
              </label>

              {activeStays.length > 0 ? (
                <div>
                  <p className="text-xs font-medium" style={{ color: brandFallback.steel }}>
                    Charge to a stay
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setReservationId("")}
                      className="rounded-full border px-3 py-1.5 text-xs"
                      style={{
                        borderColor: reservationId === "" ? ws.primary_color : "rgba(0,0,0,0.1)",
                        color: reservationId === "" ? ws.primary_color : brandFallback.steel,
                      }}
                    >
                      Pay at the hotel
                    </button>
                    {activeStays.map((stay) => {
                      const id = String(stay["id"]);
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setReservationId(id)}
                          className="rounded-full border px-3 py-1.5 text-xs"
                          style={{
                            borderColor: reservationId === id ? ws.primary_color : "rgba(0,0,0,0.1)",
                            color: reservationId === id ? ws.primary_color : brandFallback.steel,
                          }}
                        >
                          Room {String(stay["room_number"] ?? "—")} · {String(stay["confirmation_number"])}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <Textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="Anything the laundry team should know"
                rows={2}
              />

              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                  Estimated {money(estimate)}
                </p>
                <BrandButton onClick={() => void submit()} disabled={place.isPending || chosen.length === 0}>
                  {place.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                  Send laundry
                </BrandButton>
              </div>
            </div>
          </GuestSection>
        </>
      )}

      <GuestSection title="My laundry">
        {mine.isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin" style={{ color: brandFallback.steel }} />
          </div>
        ) : (mine.data?.length ?? 0) === 0 ? (
          <PublicEmptyState title="Nothing sent yet" description="Laundry you send will be tracked here." />
        ) : (
          <ul className="space-y-2">
            {(mine.data ?? []).map((order) => (
              <li key={String(order["id"])} className="rounded-xl border border-black/5 p-3">
                <p className="text-sm font-medium" style={{ color: brandFallback.secondary }}>
                  {String(order["laundry_number"] ?? "Laundry order")} · {money(order["total"])}
                </p>
                <p className="text-xs" style={{ color: brandFallback.steel }}>
                  {laundryStatusLabels[String(order["status"])] ?? String(order["status"])} ·{" "}
                  {String(order["payment_intent"]) === "charge_to_room" ? "Charged to your room" : "Payable at the hotel"} ·{" "}
                  {new Date(String(order["requested_at"])).toLocaleString()}
                </p>
              </li>
            ))}
          </ul>
        )}
      </GuestSection>
    </GuestScreen>
  );
}
