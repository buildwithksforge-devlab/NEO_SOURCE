/**
 * Explore — everything this hotel actually publishes, in one place.
 *
 * Rooms come from the same availability engine the front office uses, dishes
 * from the kitchen catalogue, services from the configured laundry price list
 * and transport products. Nothing is illustrative: a section that the property
 * has not configured says so instead of showing an example.
 */
import { useState } from "react";
import { canonicalLink, canonicalUrl, robotsDirective } from "@/lib/route-visibility";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BedDouble, Bike, Heart, Shirt, Sparkles, UtensilsCrossed } from "lucide-react";
import { GuestScreen, GuestSection } from "@/components/public/GuestScreen";
import { PublicEmptyState, useWorkspace } from "@/components/public/PublicAppShell";
import { GuestImage } from "@/components/public/GuestImage";
import { GuestRowsSkeleton } from "@/components/public/GuestSkeleton";
import { GUEST_CARD_WIDTHS } from "@/lib/responsive-image";
import { brandFallback, buttonRadius } from "@/lib/public-apps";
import { money, usePublicMenu } from "@/lib/public-delivery";
import { useGuestScreenView } from "@/lib/guest-app";
import { useCustomerSession } from "@/lib/public-session";
import { useGuestFavourites, useToggleFavourite, useTransportProducts } from "@/lib/guest-ordering";
import { useGuestProfile } from "@/lib/guest-app";
import { useLaundryOffering } from "@/lib/guest-laundry";
import { nightsBetween, useRoomOffers } from "@/lib/guest-booking";
import {
  experienceBasis,
  experienceGuests,
  usePublicExperiences,
} from "@/lib/guest-experiences";

export const Route = createFileRoute("/guest/$hotelSlug/explore")({
  head: ({ params }) => ({
    meta: [
      { title: "Explore the hotel — NEØ Guest" },
      {
        name: "description",
        content: "Rooms, dining, services and experiences published by the hotel, with real prices.",
      },
      { property: "og:title", content: "Explore the hotel — NEØ Guest" },
      {
        property: "og:description",
        content: "Rooms, dining, services and experiences published by the hotel, with real prices.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: canonicalUrl(`/guest/${params.hotelSlug}/explore`) },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: robotsDirective(`/guest/${params.hotelSlug}/explore`) },
    ],
    links: [canonicalLink(`/guest/${params.hotelSlug}/explore`)],
  }),
  component: ExplorePage,
});

type TabKey = "rooms" | "dining" | "services" | "experiences";

const tabs: { key: TabKey; label: string; icon: typeof BedDouble }[] = [
  { key: "rooms", label: "Rooms", icon: BedDouble },
  { key: "dining", label: "Dining", icon: UtensilsCrossed },
  { key: "services", label: "Services", icon: Shirt },
  { key: "experiences", label: "Experiences", icon: Sparkles },
];

function isoDay(offset: number) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A dish with no photograph gets the property's own colour, not a stock icon. */
function DishArtwork({ name, tint }: { name: string; tint: string }) {
  return (
    <span
      className="flex size-full items-center justify-center"
      style={{ background: `linear-gradient(140deg, ${tint}26, ${tint}0d)`, color: tint }}
    >
      <span className="flex flex-col items-center gap-1">
        <UtensilsCrossed className="size-5" aria-hidden />
        <span className="max-w-[7rem] truncate text-[0.6rem] uppercase tracking-[0.16em]">
          {name}
        </span>
      </span>
    </span>
  );
}

function Pill({
  active,
  tint,
  onClick,
  children,
}: {
  active: boolean;
  tint: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="inline-flex min-h-9 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium"
      style={{
        borderColor: active ? tint : "rgba(0,0,0,0.1)",
        color: active ? "#ffffff" : brandFallback.secondary,
        background: active ? tint : "#ffffff",
      }}
    >
      {children}
    </button>
  );
}

function ExplorePage() {
  const ws = useWorkspace();
  const { hotelSlug } = Route.useParams();
  const { user } = useCustomerSession();
  const profile = useGuestProfile(ws.organization_id, user?.id, ws.branch_id);
  const customerId = profile.data?.["id"] as string | undefined;

  const [tab, setTab] = useState<TabKey>("rooms");
  const [category, setCategory] = useState<string | null>(null);
  const primary = ws.primary_color || brandFallback.primary;
  const radius = buttonRadius(ws.button_style);

  useGuestScreenView(ws.organization_id, "explore");

  const arrival = isoDay(1);
  const departure = isoDay(2);
  const rooms = useRoomOffers(
    {
      organizationId: ws.organization_id,
      branchId: ws.branch_id,
      arrival,
      departure,
      adults: 2,
      children: 0,
    },
    tab === "rooms" && Boolean(user),
  );

  const menu = usePublicMenu(ws.organization_id, ws.branch_id, "room-service");
  const favourites = useGuestFavourites(ws.organization_id, customerId);
  const toggleFavourite = useToggleFavourite(ws.organization_id, customerId);
  const favouriteByItem = new Map(
    (favourites.data ?? []).map((row) => [String(row["menu_item_id"]), String(row["id"])]),
  );

  // Both of these lists are released by the hotel to signed-in guests only.
  const laundry = useLaundryOffering(ws.organization_id, user ? ws.branch_id : null);
  const transport = useTransportProducts(ws.organization_id);

  // Experiences are published marketing content: readable before sign-in.
  const experiences = usePublicExperiences(ws.branch_id ?? undefined);

  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const item of menu.data ?? []) {
    const name =
      ((item["menu_categories"] as { name?: string } | null)?.name as string | undefined) ?? "Menu";
    grouped.set(name, [...(grouped.get(name) ?? []), item]);
  }
  const categories = [...grouped.keys()];
  const shown = category && grouped.has(category) ? [category] : categories;
  const nights = nightsBetween(arrival, departure);

  return (
    <GuestScreen hotelSlug={hotelSlug} active="explore">
      <section className="grid min-w-0 items-end gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <h1 className="neo-pub-display text-3xl sm:text-4xl" style={{ color: brandFallback.secondary }}>
            Explore {ws.hotel_name}
          </h1>
          <p className="neo-public-copy mt-2 max-w-xl text-sm" style={{ color: brandFallback.steel }}>
            Rooms, dining, services and experiences — prices and availability exactly as the
            property publishes them.
          </p>
        </div>
      </section>

      <div className="neo-scroll-x mt-6 flex gap-2">
        {tabs.map((entry) => {
          const Icon = entry.icon;
          return (
            <Pill key={entry.key} active={tab === entry.key} tint={primary} onClick={() => setTab(entry.key)}>
              <Icon className="size-4" aria-hidden />
              {entry.label}
            </Pill>
          );
        })}
      </div>

      {/* --------------------------------------------------------- rooms */}
      {tab === "rooms" ? (
        <GuestSection
          title="Rooms available"
          description={`Live availability for ${arrival} → ${departure} (${nights} night, 2 adults). Pick your own dates when you book.`}
          action={
            <Link
              to="/guest/$hotelSlug/book"
              params={{ hotelSlug }}
              className="inline-flex min-h-11 items-center px-5 text-sm font-semibold text-white"
              style={{ background: primary, borderRadius: radius }}
            >
              Choose dates
            </Link>
          }
        >
          {!user ? (
            <PublicEmptyState
              title="Sign in to see live room rates"
              description="This hotel releases live availability and pricing to signed-in guests. You can still open the booking screen to choose dates."
            />
          ) : rooms.isLoading ? (
            <GuestRowsSkeleton rows={3} label="Checking availability" />
          ) : rooms.isError ? (
            <PublicEmptyState
              title="Sign in to see live room rates"
              description="This hotel releases live availability and pricing to signed-in guests. You can still open the booking screen to choose dates."
            />
          ) : (rooms.data ?? []).length === 0 ? (
            <PublicEmptyState
              title="No rooms are open for these dates"
              description="Try other dates on the booking screen, or call reception to check what is held."
            />
          ) : (
            <ul className="grid gap-4 lg:grid-cols-2">
              {(rooms.data ?? []).map((offer) => (
                <li
                  key={offer.room_type_id}
                  className="flex min-w-0 flex-col gap-2 rounded-2xl border border-black/5 bg-white p-5"
                >
                  <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                    <div className="min-w-0">
                      <p className="text-base font-semibold" style={{ color: brandFallback.secondary }}>
                        {offer.room_type_name}
                      </p>
                      {offer.description ? (
                        <p className="neo-line-2 text-xs" style={{ color: brandFallback.steel }}>
                          {offer.description}
                        </p>
                      ) : null}
                      <p className="mt-1 text-xs" style={{ color: brandFallback.steel }}>
                        {offer.rooms_available} available
                        {offer.max_occupancy ? ` · sleeps ${offer.max_occupancy}` : ""}
                        {offer.rate_plan_name ? ` · ${offer.rate_plan_name}` : ""}
                      </p>
                    </div>
                    <div className="min-w-0 sm:text-right">
                      <p className="text-base font-semibold" style={{ color: brandFallback.secondary }}>
                        {money(offer.nightly_rate, offer.currency)}
                      </p>
                      <p className="text-xs" style={{ color: brandFallback.steel }}>
                        per night
                      </p>
                    </div>
                  </div>
                  <div className="mt-auto pt-3" data-public-actions>
                    <Link
                      to="/guest/$hotelSlug/book"
                      params={{ hotelSlug }}
                      className="inline-flex min-h-10 items-center px-4 text-sm font-semibold text-white"
                      style={{ background: primary, borderRadius: radius }}
                    >
                      Book this room
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </GuestSection>
      ) : null}

      {/* -------------------------------------------------------- dining */}
      {tab === "dining" ? (
        <>
          {categories.length > 1 ? (
            <div className="neo-scroll-x mt-6 flex gap-2">
              <Pill active={category === null} tint={primary} onClick={() => setCategory(null)}>
                All
              </Pill>
              {categories.map((name) => (
                <Pill
                  key={name}
                  active={category === name}
                  tint={primary}
                  onClick={() => setCategory(name)}
                >
                  {name}
                </Pill>
              ))}
            </div>
          ) : null}

          {menu.isLoading ? (
            <div className="mt-6">
              <GuestRowsSkeleton rows={5} label="Loading the menu" />
            </div>
          ) : categories.length === 0 ? (
            <div className="mt-6">
              <PublicEmptyState
                title="The menu is not published yet"
                description="Dining opens here as soon as the kitchen publishes its dishes. Reception can take your order in the meantime."
              />
            </div>
          ) : (
            shown.map((name) => (
              <GuestSection key={name} title={name}>
                <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {(grouped.get(name) ?? []).map((item) => (
                    <li
                      key={String(item["id"])}
                      className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-black/5 bg-white"
                    >
                      <GuestImage
                        src={item["image_url"] ? String(item["image_url"]) : null}
                        alt=""
                        width={480}
                        height={320}
                        widths={GUEST_CARD_WIDTHS}
                        sizes="(min-width: 1280px) 22rem, (min-width: 640px) 45vw, 90vw"
                        rounded="rounded-none"
                        className="w-full"
                        fallback={<DishArtwork name={name} tint={primary} />}
                      />
                      <div className="flex min-w-0 flex-1 flex-col gap-1 p-4">
                        <p className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                          {String(item["name"])}
                        </p>
                        {item["description"] ? (
                          <p className="neo-line-2 text-xs" style={{ color: brandFallback.steel }}>
                            {String(item["description"])}
                          </p>
                        ) : null}
                        <div className="mt-auto grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 pt-3">
                          <span className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                            {money(item["base_price"])}
                          </span>
                          <span className="flex min-w-0 items-center gap-1">
                            {customerId ? (
                              <button
                                type="button"
                                aria-label={
                                  favouriteByItem.has(String(item["id"]))
                                    ? "Remove favourite"
                                    : "Save favourite"
                                }
                                onClick={() =>
                                  toggleFavourite.mutate({
                                    menuItemId: String(item["id"]),
                                    favouriteId: favouriteByItem.get(String(item["id"])) ?? null,
                                  })
                                }
                                className="grid min-h-9 min-w-9 place-items-center rounded-full"
                                style={{ color: primary }}
                              >
                                <Heart
                                  className="size-4"
                                  fill={favouriteByItem.has(String(item["id"])) ? primary : "none"}
                                />
                              </button>
                            ) : null}
                            <Link
                              to="/guest/$hotelSlug/order"
                              params={{ hotelSlug }}
                              search={{ item: String(item["id"]) }}
                              className="inline-flex min-h-9 items-center px-3 text-xs font-semibold"
                              style={{ color: primary, border: `1px solid ${primary}`, borderRadius: radius }}
                            >
                              Order
                            </Link>
                          </span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </GuestSection>
            ))
          )}
        </>
      ) : null}

      {/* ------------------------------------------------------ services */}
      {tab === "services" ? (
        <>
          <GuestSection
            title="Laundry"
            description="The hotel's own price list, charged to your room or paid on collection."
            action={
              laundry.data?.enabled ? (
                <Link
                  to="/guest/$hotelSlug/laundry"
                  params={{ hotelSlug }}
                  className="inline-flex min-h-11 items-center px-5 text-sm font-semibold text-white"
                  style={{ background: primary, borderRadius: radius }}
                >
                  Send laundry
                </Link>
              ) : undefined
            }
          >
            {!user ? (
              <PublicEmptyState
                title="Sign in to see laundry prices"
                description="This hotel publishes its laundry list to signed-in guests."
              />
            ) : laundry.isLoading ? (
              <GuestRowsSkeleton rows={3} label="Loading laundry prices" />
            ) : laundry.isError ? (
              <PublicEmptyState
                title="Sign in to see laundry prices"
                description="This hotel publishes its laundry list to signed-in guests."
              />
            ) : !laundry.data?.enabled || (laundry.data.items ?? []).length === 0 ? (
              <PublicEmptyState
                title="Laundry is not published here yet"
                description="Reception can still arrange laundry for you during your stay."
              />
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {laundry.data.items.map((item) => (
                  <li
                    key={item.id}
                    className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-2xl border border-black/5 bg-white p-4"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                        {item.name}
                      </p>
                      <p className="text-xs" style={{ color: brandFallback.steel }}>
                        Express {money(item.express_price)} · {item.turnaround_hours}h
                      </p>
                    </div>
                    <span className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                      {money(item.normal_price)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </GuestSection>

          <GuestSection
            title="Transport"
            description="Transfers the property runs or arranges."
            action={
              (transport.data ?? []).length > 0 ? (
                <Link
                  to="/guest/$hotelSlug/transport"
                  params={{ hotelSlug }}
                  className="inline-flex min-h-11 items-center border px-5 text-sm font-semibold"
                  style={{ color: primary, borderColor: primary, borderRadius: radius }}
                >
                  Request a transfer
                </Link>
              ) : undefined
            }
          >
            {transport.isLoading ? (
              <GuestRowsSkeleton rows={2} label="Loading transfers" />
            ) : (transport.data ?? []).length === 0 ? (
              <PublicEmptyState
                title="No transfers are published"
                description="Ask reception and they will quote a transfer for you."
              />
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {(transport.data ?? []).map((product) => (
                  <li
                    key={String(product["id"])}
                    className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-2xl border border-black/5 bg-white p-4"
                  >
                    <Bike className="size-4 shrink-0" style={{ color: primary }} aria-hidden />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                        {String(product["name"])}
                      </p>
                      <p className="truncate text-xs" style={{ color: brandFallback.steel }}>
                        {String(product["category"] ?? "Transfer")}
                        {product["max_passengers"] ? ` · up to ${String(product["max_passengers"])}` : ""}
                      </p>
                    </div>
                    <span className="text-sm font-semibold" style={{ color: brandFallback.secondary }}>
                      {money(product["base_price"], String(product["currency"] ?? "KES"))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </GuestSection>

          <GuestSection
            title="Anything else"
            description="Housekeeping, maintenance and concierge requests go straight to the department that handles them."
          >
            <div data-public-actions>
              <Link
                to="/guest/$hotelSlug/trips"
                params={{ hotelSlug }}
                className="inline-flex min-h-11 items-center px-5 text-sm font-semibold text-white"
                style={{ background: primary, borderRadius: radius }}
              >
                Make a request
              </Link>
            </div>
          </GuestSection>
        </>
      ) : null}

      {/* --------------------------------------------------- experiences */}
      {tab === "experiences" ? (
        <GuestSection
          title="Wellness and experiences"
          description="Packages this hotel publishes, at the price it charges."
        >
          {experiences.isLoading ? (
            <GuestRowsSkeleton rows={3} label="Loading experiences" />
          ) : (experiences.data ?? []).length === 0 ? (
            <PublicEmptyState
              title="No experiences are published yet"
              description={`${ws.hotel_name} has not published spa, wellness or excursion packages in the app. Reception can tell you what is running today.`}
            />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {(experiences.data ?? []).map((item) => {
                const guests = experienceGuests(item.min_guests, item.max_guests);
                const basis = experienceBasis(item.price_basis);
                return (
                  <li
                    key={item.id}
                    className="flex min-w-0 flex-col gap-2 rounded-2xl border border-black/5 bg-white p-4"
                  >
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p
                          className="break-words text-sm font-semibold"
                          style={{ color: brandFallback.secondary }}
                        >
                          {item.name}
                        </p>
                        {item.event_type ? (
                          <p
                            className="truncate text-[0.68rem] uppercase tracking-[0.16em]"
                            style={{ color: brandFallback.steel }}
                          >
                            {item.event_type}
                          </p>
                        ) : null}
                      </div>
                      <span
                        className="shrink-0 text-sm font-semibold"
                        style={{ color: brandFallback.secondary }}
                      >
                        {money(item.price, "KES")}
                      </span>
                    </div>
                    {item.description ? (
                      <p className="break-words text-xs" style={{ color: brandFallback.steel }}>
                        {item.description}
                      </p>
                    ) : null}
                    <p className="text-xs" style={{ color: brandFallback.steel }}>
                      {[basis, guests, item.valid_to ? `Available until ${item.valid_to}` : null]
                        .filter(Boolean)
                        .join(" · ") || "Ask reception for today's availability."}
                    </p>
                    <Link
                      to="/guest/$hotelSlug/trips"
                      params={{ hotelSlug }}
                      className="inline-flex min-h-11 w-fit items-center px-4 text-sm font-semibold"
                      style={{ color: primary, border: `1px solid ${primary}`, borderRadius: radius }}
                    >
                      Enquire
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </GuestSection>
      ) : null}
    </GuestScreen>
  );
}
