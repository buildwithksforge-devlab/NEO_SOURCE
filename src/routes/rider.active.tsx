import { useEffect } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Loader2, MapPin, Phone } from "lucide-react";
import { brandFallback } from "@/lib/public-apps";
import { useCustomerSession } from "@/lib/public-session";
import { money, statusLabel } from "@/lib/public-delivery";
import { useMyDeliveries, useMyRiderProfile, useRiderAdvance } from "@/lib/delivery-data";
import { RiderTabBar, useRiderBrand } from "@/components/public/RiderTabBar";
import { PullToRefresh } from "@/components/common/PullToRefresh";
import { PreviewBanner } from "@/components/public/PreviewBanner";

export const Route = createFileRoute("/rider/active")({
  head: () => ({
    meta: [
      { title: "Active job — NEØ Rider App" },
      { name: "description", content: "The delivery you are carrying right now, with the next step." },
      { property: "og:title", content: "Active job — NEØ Rider App" },
      { property: "og:description", content: "The delivery you are carrying right now, with the next step." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: RiderActiveJob,
});

type Row = Record<string, unknown>;

const NEXT_STEP: Record<string, { to: string; label: string }> = {
  "rider-assigned": { to: "collected", label: "Picked up from restaurant" },
  collected: { to: "en-route", label: "Start delivery" },
};

const ON_ROAD = ["rider-assigned", "collected", "out-for-delivery"];

function RiderActiveJob() {
  const navigate = useNavigate();
  const { user, loading } = useCustomerSession();
  const rider = useMyRiderProfile();
  const brand = useRiderBrand((rider.data?.["branch_id"] as string | null) ?? null, user?.id);
  const riderId = rider.data?.["id"] as string | undefined;
  const deliveries = useMyDeliveries(riderId);
  const advance = useRiderAdvance();

  useEffect(() => {
    if (!loading && !user) void navigate({ to: "/rider/login" });
  }, [loading, user, navigate]);

  const jobs = ((deliveries.data ?? []) as Row[]).filter((o) =>
    ON_ROAD.includes(String(o["order_status"])),
  );

  return (
    <div className="neo-rider-page" style={brand.style}>
      <PreviewBanner experience="Rider" />
      <header className="px-4 py-4" style={{ background: brandFallback.navy }}>
        <div className="mx-auto w-full max-w-md">
          <p className="text-sm font-semibold text-white">Active job</p>
          <p className="text-xs text-white/60">
            {jobs.length === 0 ? "Nothing on the road" : `${jobs.length} on the road`}
          </p>
        </div>
      </header>

      <PullToRefresh>
      <main className="mx-auto w-full max-w-md min-w-0 space-y-4 px-4 pb-28 pt-5">
        <section className="neo-rider-hero">
          <div><h1 className="text-2xl font-bold text-white">Active delivery</h1>{brand.property ? <p className="mt-2 text-sm text-white/80">{brand.property.property_name}</p> : null}</div>
        </section>
        {loading || rider.isLoading || deliveries.isLoading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="size-5 animate-spin" style={{ color: brandFallback.steel }} />
          </div>
        ) : rider.isError || deliveries.isError ? (
          <div className="neo-rider-card p-5 text-slate-800" role="alert">
            <p>Active deliveries couldn’t load.</p>
            <button className="neo-commerce-primary mt-3" onClick={() => void (rider.isError ? rider.refetch() : deliveries.refetch())}>Retry</button>
          </div>
        ) : !rider.data ? (
          <p className="neo-rider-card p-6 text-center text-sm" style={{ color: brandFallback.steel }}>
            This account is not on an active rider roster.
          </p>
        ) : jobs.length === 0 ? (
          <div className="neo-rider-card p-6 text-center">
            <p className="text-sm" style={{ color: brandFallback.steel }}>
              You are not carrying a delivery right now.
            </p>
            <Link to="/rider" className="mt-3 inline-block text-sm font-semibold" style={{ color: brandFallback.primary }}>
              See what is waiting
            </Link>
          </div>
        ) : (
          jobs.map((job) => {
            const status = String(job["order_status"]);
            const next = NEXT_STEP[status];
            const address = (job["address_snapshot"] ?? {}) as Record<string, unknown>;
            const line = [address["address_line"] ?? address["line1"], address["area"], address["city"]]
              .filter(Boolean)
              .map(String)
              .join(", ");
            const phone = String(address["phone"] || job["contact_phone"] || "");
            const instructions = address["delivery_instructions"] ?? address["instructions"];
            const latitude = address["latitude"];
            const longitude = address["longitude"];
            const mapsUrl = typeof latitude === "number" && Math.abs(latitude) <= 90 &&
              typeof longitude === "number" && Math.abs(longitude) <= 180
              ? `https://maps.apple.com/?daddr=${latitude},${longitude}` : null;
            const readyForPickup = status !== "rider-assigned" || ["ready", "completed"].includes(String(job["kitchen_status"]));
            return (
              <section key={String(job["id"])} className="neo-rider-card p-5">
                <div className="neo-public-row">
                  <div className="min-w-0">
                    <p className="text-base font-semibold" style={{ color: brandFallback.secondary }}>
                      <span data-public-id>{String(job["order_number"] ?? "")}</span>
                    </p>
                    <p className="text-xs" style={{ color: brandFallback.steel }}>
                      {statusLabel(status)} · {money(job["grand_total"], String(job["currency"] ?? "KES"))}
                    </p>
                  </div>
                  <span
                    className="max-w-[9rem] truncate rounded-full px-3 py-1 text-xs font-semibold"
                    style={{ background: `${brandFallback.primary}1a`, color: brandFallback.primary }}
                  >
                    {statusLabel(String(job["payment_status"] ?? ""))}
                  </span>
                </div>

                {line ? (
                  <p className="mt-3 flex min-w-0 items-start gap-2 break-words text-sm" style={{ color: brandFallback.secondary }}>
                    <MapPin className="mt-0.5 size-4 shrink-0" style={{ color: brandFallback.primary }} />
                    {line}
                  </p>
                ) : null}
                {instructions ? (
                  <p className="mt-1 text-xs" style={{ color: brandFallback.steel }}>
                    {String(instructions)}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-x-4">
                {phone ? (
                  <a
                    href={`tel:${phone}`}
                    className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-slate-800"
                  >
                    <Phone className="size-4" /> Call the customer
                  </a>
                ) : null}
                {mapsUrl ? <a href={mapsUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-slate-800"><MapPin className="size-4" aria-hidden /> Open drop-off in Maps</a> : null}
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  {next && readyForPickup ? (
                    <button
                      type="button"
                      disabled={advance.isPending}
                      onClick={() => advance.mutate({ orderId: String(job["id"]), to: next.to })}
                      className="neo-commerce-primary w-full"
                    >
                      {advance.isPending ? "Saving…" : next.label}
                    </button>
                  ) : null}
                  {!readyForPickup ? <p className="w-full rounded-xl bg-amber-50 px-3 py-2 text-sm font-medium text-amber-950">Waiting for the kitchen to mark this order ready.</p> : null}
                  {status === "out-for-delivery" ? <Link
                    to="/rider"
                    hash={`job-${String(job["id"])}`}
                    className="neo-commerce-primary w-full"
                  >
                    Confirm delivery
                  </Link> : null}
                </div>
              </section>
            );
          })
        )}
      </main>
      </PullToRefresh>

      <RiderTabBar active="active" />
    </div>
  );
}
