/**
 * NEØ ROOT — the public front door.
 *
 * Signed out it is a hospitality discovery product: one editorial hero built
 * from a real hotel's own published photograph, then the destinations and
 * hotels that genuinely exist on the platform. Nothing here is invented —
 * no ratings, no prices, no availability, no borrowed imagery.
 *
 * Signed in it becomes personal: the places this person genuinely belongs to
 * come first, each with only the entrances their real relationship allows.
 * A shortcut remains only a shortcut — every entrance is re-checked on open.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PoweredByNeo, PublicCreatorCredit } from "@/components/public/PublicAppShell";
import {
  ArrowRight,
  Bike,
  Briefcase,
  Handshake,
  MapPin,
  Search,
  UtensilsCrossed,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { neoSignOut } from "@/lib/session-exit";
import {
  fetchMyEntrances,
  fetchPublicDestinations,
  fetchPublicDirectory,
  type Destination,
  type DirectoryProperty,
  type MyEntrance,
} from "@/lib/front-door";
import { brandInitials } from "@/lib/public-apps";
import { NEO_SYMBOL_SRC, NEO_WORDMARK_SRC } from "@/components/brand/NeoIdentity";
import { forgetContext } from "@/lib/continue-context";
import { CoverMedia, Display, Eyebrow, PublicPanel, PublicSurface } from "@/components/public/NeoPublic";

function greeting(at = new Date()): string {
  const h = at.getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

/**
 * The address to open a hotel at. A publicly listed hotel has a public
 * address; an unlisted one is reached by its own portal address, or failing
 * that its identifier — both resolve only for people who belong there.
 */
function propertyKey(c: MyEntrance): string {
  return c.public_slug ?? c.portal_slug ?? c.branch_id;
}

function placeOf(p: DirectoryProperty): string | null {
  const parts = [p.city, p.country].filter(Boolean) as string[];
  return parts.length ? parts.join(", ") : null;
}

/**
 * The hotel's own lowest published nightly rate. Shown only when the property
 * has actually configured an active rate plan — never estimated.
 */
function fromRate(p: DirectoryProperty): string | null {
  if (p.from_rate == null || !Number.isFinite(Number(p.from_rate))) return null;
  const amount = Number(p.from_rate);
  const currency = p.currency ?? "";
  return `From ${currency} ${amount.toLocaleString(undefined, { maximumFractionDigits: 0 })} / night`.trim();
}

function serves(p: DirectoryProperty, keys: string[]): boolean {
  const s = p.services ?? {};
  return keys.some((k) => s[k] === true);
}

/** The services a hotel can actually publish, as stored on its public page. */
const SERVICE_FILTERS: { key: string; label: string }[] = [
  { key: "bookings", label: "Rooms" },
  { key: "room_service", label: "Room service" },
  { key: "restaurant_pickup", label: "Dining" },
  { key: "delivery", label: "Delivery" },
  { key: "laundry_public", label: "Laundry" },
];

export function FrontDoorScreen() {
  const queryClient = useQueryClient();
  const [term, setTerm] = useState("");
  const [search, setSearch] = useState("");
  const [place, setPlace] = useState<string | null>(null);
  const [service, setService] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    const id = window.setTimeout(() => setSearch(term.trim()), 300);
    return () => window.clearTimeout(id);
  }, [term]);

  useEffect(() => {
    let live = true;
    void supabase.auth.getUser().then(({ data }) => {
      if (!live) return;
      const user = data.user;
      const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
      const display =
        (typeof meta["full_name"] === "string" && meta["full_name"]) ||
        (typeof meta["name"] === "string" && meta["name"]) ||
        user?.email ||
        null;
      setName(display ? String(display) : null);
      setSignedIn(Boolean(user));
    });
    return () => {
      live = false;
    };
  }, []);

  const directory = useQuery({
    queryKey: ["neo-front-door", search, place, service],
    queryFn: () => fetchPublicDirectory({ search, place, service }),
    staleTime: 60_000,
  });
  /**
   * Discover represents properties, not join rows.
   *
   * The public directory RPC may legitimately join rooms, services, rates or
   * publishing records. Even if an upstream join ever returns the same branch
   * more than once, the front door must render that hotel exactly once.
   *
   * branch_id is the canonical property identity; never dedupe by display
   * name because different hotels may share a brand or similar name.
   */
  const results = useMemo(() => {
    const unique = new Map<string, DirectoryProperty>();

    for (const property of directory.data ?? []) {
      if (!unique.has(property.branch_id)) {
        unique.set(property.branch_id, property);
      }
    }

    return [...unique.values()];
  }, [directory.data]);

  const mine = useQuery({
    queryKey: ["neo-my-entrances"],
    queryFn: fetchMyEntrances,
    enabled: signedIn,
    staleTime: 60_000,
  });
  const places = (mine.data ?? []).filter((c) => c.work || c.rider || c.partner);

  /** The hero picture is a real hotel's own published photograph, credited. */
  const feature = useMemo(
    () => results.find((p) => Boolean(p.cover_image_url)) ?? results[0] ?? null,
    [results],
  );
  const rest = useMemo(
    () => results.filter((p) => p.branch_id !== feature?.branch_id),
    [results, feature],
  );
  /** Every destination on the platform, not only those in this page of results. */
  const destinationQuery = useQuery({
    queryKey: ["neo-front-door-destinations"],
    queryFn: fetchPublicDestinations,
    staleTime: 300_000,
  });
  /**
   * Destination identity is case-insensitive.
   *
   * Hotels may have legacy city values such as "Nairobi" and "NAIROBI".
   * Those are the same destination and must never appear as separate chips.
   * Preserve the better human-readable spelling and combine hotel counts;
   * do not mutate the hotel's stored address.
   */
  const destinations = useMemo(() => {
    const unique = new Map<string, Destination>();

    for (const destination of destinationQuery.data ?? []) {
      const key = destination.place.trim().toLocaleLowerCase();

      if (!key) continue;

      const existing = unique.get(key);

      if (!existing) {
        unique.set(key, destination);
        continue;
      }

      const existingIsAllCaps =
        existing.place === existing.place.toLocaleUpperCase() &&
        existing.place !== existing.place.toLocaleLowerCase();

      const candidateIsAllCaps =
        destination.place === destination.place.toLocaleUpperCase() &&
        destination.place !== destination.place.toLocaleLowerCase();

      unique.set(key, {
        place:
          existingIsAllCaps && !candidateIsAllCaps
            ? destination.place
            : existing.place,
        hotels: existing.hotels + destination.hotels,
      });
    }

    return [...unique.values()].slice(0, 10);
  }, [destinationQuery.data]);
  const dining = useMemo(
    () => results.filter((p) => serves(p, ["dining", "restaurant", "delivery", "room_service"])),
    [results],
  );

  const searchField = (
    <div className="relative w-full">
      <Search
        className="pointer-events-none absolute left-5 top-1/2 size-4 -translate-y-1/2 text-white/70"
        aria-hidden
      />
      <input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Search hotels, destinations & dining"
        aria-label="Search hotels, destinations and dining"
        className="neo-pub-field h-14 w-full pl-12 pr-5 text-sm outline-none placeholder:text-white/60 focus-visible:ring-2 focus-visible:ring-neo-turquoise"
      />
    </div>
  );

  return (
    <PublicSurface className="pb-0">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="neo-pub-header">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-4 px-5">
          <Link to="/" aria-label="NEØ home" className="shrink-0">
            <img src={NEO_WORDMARK_SRC} alt="NEØ" className="h-5 w-auto object-contain" />
          </Link>
          <nav aria-label="Sections" className="ml-2 hidden items-center gap-1 md:flex">
            <a className="neo-pub-navlink" href="#discover">
              Discover
            </a>
            <a className="neo-pub-navlink" href="#stays">
              Stays
            </a>
            {dining.length ? (
              <a className="neo-pub-navlink" href="#dining">
                Dine
              </a>
            ) : null}
            {signedIn && places.length ? (
              <a className="neo-pub-navlink" href="#yours">
                Yours
              </a>
            ) : null}
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <a
              href="#discover"
              aria-label="Search hotels"
              className="grid size-11 place-items-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white md:hidden"
            >
              <Search className="size-4" aria-hidden />
            </a>
            {signedIn ? (
              <>
                <span className="hidden max-w-[9rem] truncate text-xs text-white/60 sm:inline sm:max-w-[14rem]">
                  {name}
                </span>
                {/* Continue is the canonical resolver: it decides work, guest,
                    partner or rider from real relationships, never from the
                    mere fact of being signed in. */}
                <Link
                  to="/continue"
                  search={{ choose: "1" }}
                  className="inline-flex h-11 items-center rounded-full bg-white px-5 text-xs font-semibold text-[#020A1C] transition-colors hover:bg-white/90"
                >
                  Continue
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    void neoSignOut(queryClient, { to: "/" });
                  }}
                  className="inline-flex h-11 items-center rounded-full border border-white/20 px-4 text-xs font-semibold text-white/80 transition-colors hover:bg-white/10 hover:text-white"
                >
                  Sign out
                </button>
              </>
            ) : (
              <Link
                to="/auth"
                className="inline-flex h-11 items-center rounded-full bg-white px-5 text-xs font-semibold text-[#020A1C] transition-colors hover:bg-white/90"
              >
                Sign in
              </Link>
            )}
          </div>
        </div>
      </header>

      {/* ── Hero ───────────────────────────────────────────────── */}
      <section className="relative isolate">
        <div className="neo-pub-hero-media">
          {feature?.cover_image_url ? (
            <CoverMedia
              src={feature.cover_image_url}
              alt=""
              priority
              sizes="100vw"
              className="absolute inset-0 size-full"
            />
          ) : (
            <div className="neo-pub-cover absolute inset-0 size-full" aria-hidden />
          )}
          <div className="neo-pub-hero-veil absolute inset-0" aria-hidden />
          {/* Our own mark, held large and quiet behind the words, so the page
              reads as NEØ before a single line is read. Decoration only — the
              supplied artwork, never redrawn. */}
          <img
            src={NEO_SYMBOL_SRC}
            alt=""
            aria-hidden
            draggable={false}
            className="neo-pub-hero-mark"
          />
        </div>

        <div className="relative mx-auto w-full max-w-6xl px-5 pb-14 pt-16 sm:pb-20 sm:pt-24">
          {signedIn ? (
            <>
              <Eyebrow>{greeting()}</Eyebrow>
              <Display className="mt-4 max-w-3xl text-[2.6rem] sm:text-6xl">
                {name ? name.split("@")[0] : "Welcome back"}
              </Display>
              <p className="mt-5 max-w-xl text-base leading-relaxed text-white/70">
                Your hotels are below, with the entrances your relationship allows. Everywhere else
                on NEØ stays open to browse.
              </p>
            </>
          ) : (
            <>
              <Eyebrow>Hospitality, connected</Eyebrow>
              <Display className="mt-4 max-w-4xl text-[2.9rem] sm:text-7xl lg:text-8xl">
                Find somewhere to stay,
                <span className="block text-white/70">dine or experience.</span>
              </Display>
              <p className="mt-6 max-w-xl text-base leading-relaxed text-white/70">
                Every hotel here runs its rooms, restaurants and services on NEØ. Browse freely —
                you only sign in when something becomes personal.
              </p>
            </>
          )}

          <div className="mt-9 max-w-xl" id="discover">
            {searchField}
          </div>

          {destinations.length > 0 ? (
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase tracking-[0.18em] text-white/70">Destinations</span>
              {destinations.map((d) => {
                const on = place === d.place;
                return (
                  <button
                    key={d.place}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setPlace(on ? null : d.place)}
                    className={
                      on
                        ? "inline-flex min-h-9 items-center gap-1.5 rounded-full bg-neo-turquoise px-3.5 text-xs font-semibold text-neo-navy"
                        : "inline-flex min-h-9 items-center gap-1.5 rounded-full bg-white/8 px-3.5 text-xs font-semibold text-white/80 transition-colors hover:bg-white/16 hover:text-white"
                    }
                  >
                    <MapPin className="size-3.5" aria-hidden /> {d.place}
                    <span className={on ? "text-neo-navy/60" : "text-white/70"}>{d.hotels}</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-[0.18em] text-white/70">Looking for</span>
            {SERVICE_FILTERS.map((f) => {
              const on = service === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setService(on ? null : f.key)}
                  className={
                    on
                      ? "inline-flex min-h-9 items-center rounded-full bg-neo-gold px-3.5 text-xs font-semibold text-neo-navy"
                      : "inline-flex min-h-9 items-center rounded-full bg-white/8 px-3.5 text-xs font-semibold text-white/80 transition-colors hover:bg-white/16 hover:text-white"
                  }
                >
                  {f.label}
                </button>
              );
            })}
            {place || service || search ? (
              <button
                type="button"
                onClick={() => {
                  setPlace(null);
                  setService(null);
                  setTerm("");
                }}
                className="inline-flex min-h-9 items-center rounded-full px-3 text-xs font-semibold text-white/75 underline-offset-4 hover:text-white hover:underline"
              >
                Clear filters
              </button>
            ) : null}
          </div>

        </div>
      </section>

      <main className="mx-auto w-full max-w-6xl px-5">
        {/* ── Yours ────────────────────────────────────────────── */}
        {signedIn ? (
          <section className="pt-16" id="yours">
            <Eyebrow>Your places</Eyebrow>
            {mine.isLoading ? (
              <div className="mt-6 grid gap-5 lg:grid-cols-2">
                <div className="neo-pub-card h-36 animate-pulse" />
                <div className="neo-pub-card hidden h-36 animate-pulse lg:block" />
              </div>
            ) : places.length === 0 ? (
              <PublicPanel className="mt-6">
                <p className="text-sm leading-relaxed text-white/70">
                  Nothing is linked to this account yet. Open a hotel below to stay or dine, or ask
                  your hotel to add you.
                </p>
              </PublicPanel>
            ) : (
              <div className="mt-6 grid gap-5 lg:grid-cols-2">
                {places.map((c) => (
                  <article key={c.branch_id} className="neo-pub-card p-5 sm:p-6">
                    <div className="flex items-center gap-4">
                      {c.logo_url ? (
                        <img
                          src={c.logo_url}
                          alt=""
                          width={48}
                          height={48}
                          className="size-12 shrink-0 rounded-2xl bg-white object-contain p-1"
                        />
                      ) : (
                        <span
                          className="neo-pub-display grid size-12 shrink-0 place-items-center rounded-2xl bg-white/10 text-sm text-white"
                          aria-hidden
                        >
                          {brandInitials(c.property_name)}
                        </span>
                      )}
                      <div className="min-w-0">
                        <p className="neo-pub-display truncate text-xl text-white">
                          {c.property_name}
                        </p>
                        <p className="truncate text-xs uppercase tracking-[0.14em] text-white/70">
                          {c.organization_name}
                        </p>
                      </div>
                    </div>
                    <div className="mt-5 flex flex-wrap gap-2">
                      {c.work ? (
                        <DoorLink to={propertyKey(c)} enter="work" label="Open Work" icon={Briefcase} primary />
                      ) : null}
                      {c.partner ? (
                        <DoorLink to={propertyKey(c)} enter="partner" label="Partner" icon={Handshake} />
                      ) : null}
                      {c.rider ? (
                        <DoorLink to={propertyKey(c)} enter="rider" label="Rider" icon={Bike} />
                      ) : null}
                      {c.public_slug ? (
                        <DoorLink to={c.public_slug} enter="stay_dine" label="Stay & Dine" icon={MapPin} />
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        ) : null}

        {/* ── Stays ────────────────────────────────────────────── */}
        <section className="pt-16" id="stays">
          <div className="flex items-baseline justify-between gap-4">
            <Eyebrow>{search ? "Search results" : signedIn ? "Discover more" : "Stays"}</Eyebrow>
            {!directory.isLoading && !directory.isError ? (
              <span className="text-xs text-white/70">
                {results.length} {results.length === 1 ? "hotel" : "hotels"}
              </span>
            ) : null}
          </div>

          {directory.isLoading ? (
            <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="neo-pub-card h-72 animate-pulse" />
              ))}
            </div>
          ) : null}

          {directory.isError ? (
            <PublicPanel className="mt-6">
              <p className="text-sm text-white/70">
                The hotel list could not be loaded right now. Please try again shortly.
              </p>
            </PublicPanel>
          ) : null}

          {!directory.isLoading && !directory.isError && results.length === 0 ? (
            <PublicPanel className="mt-6">
              <p className="text-base font-semibold text-white">Nothing to show here yet.</p>
              <p className="mt-2 text-sm leading-relaxed text-white/65">
                {search
                  ? "No hotel matches that search."
                  : "If you were given a direct hotel link or a QR code, open that instead."}
              </p>
            </PublicPanel>
          ) : null}

          {feature ? (
            <Link
              to="/start/$propertySlug"
              params={{ propertySlug: feature.public_slug }}
              className="neo-pub-card group mt-6 grid overflow-hidden md:grid-cols-[1.15fr_1fr]"
            >
              <CoverMedia
                src={feature.cover_image_url}
                alt={feature.property_name}
                initials={brandInitials(feature.property_name)}
                sizes="(min-width: 768px) 55vw, 100vw"
                className="aspect-[16/10] w-full md:aspect-auto md:h-full md:min-h-[22rem]"
              />
              <div className="flex flex-col justify-center gap-4 p-6 sm:p-9">
                <Eyebrow>Featured</Eyebrow>
                <Display as="h2" className="text-3xl sm:text-4xl">
                  {feature.property_name}
                </Display>
                <p className="text-xs uppercase tracking-[0.14em] text-white/70">
                  {[feature.organization_name, placeOf(feature)].filter(Boolean).join(" · ")}
                </p>
                {feature.tagline || feature.summary ? (
                  <p className="line-clamp-3 text-sm leading-relaxed text-white/70">
                    {feature.tagline ?? feature.summary}
                  </p>
                ) : null}
                {fromRate(feature) ? (
                  <p className="text-sm font-semibold text-neo-gold">{fromRate(feature)}</p>
                ) : null}
                <span className="mt-1 inline-flex items-center gap-2 text-sm font-semibold text-white">
                  Open hotel
                  <ArrowRight
                    className="size-4 transition-transform group-hover:translate-x-1"
                    aria-hidden
                  />
                </span>
              </div>
            </Link>
          ) : null}

          {rest.length ? (
            <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {rest.map((property) => (
                <Link
                  key={property.branch_id}
                  to="/start/$propertySlug"
                  params={{ propertySlug: property.public_slug }}
                  className="neo-pub-card group flex flex-col"
                >
                  <CoverMedia
                    src={property.cover_image_url}
                    alt={property.property_name}
                    initials={brandInitials(property.property_name)}
                    sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                    className="aspect-[4/3] w-full"
                  >
                    {property.logo_url ? (
                      <img
                        src={property.logo_url}
                        alt=""
                        width={44}
                        height={44}
                        className="absolute left-4 top-4 size-11 rounded-xl bg-white object-contain p-1"
                      />
                    ) : null}
                    {placeOf(property) ? (
                      <span className="absolute bottom-4 left-4 inline-flex items-center gap-1 text-xs font-medium text-white/85">
                        <MapPin className="size-3.5" aria-hidden />
                        {placeOf(property)}
                      </span>
                    ) : null}
                  </CoverMedia>
                  <span className="flex flex-1 flex-col p-5">
                    <span className="neo-pub-display block text-xl text-white">
                      {property.property_name}
                    </span>
                    <span className="mt-1 block truncate text-xs uppercase tracking-[0.14em] text-white/70">
                      {property.organization_name}
                    </span>
                    {property.tagline ? (
                      <span className="mt-3 line-clamp-2 text-sm leading-relaxed text-white/65">
                        {property.tagline}
                      </span>
                    ) : null}
                    {fromRate(property) ? (
                      <span className="mt-3 block text-sm font-semibold text-neo-gold">
                        {fromRate(property)}
                      </span>
                    ) : null}
                  </span>
                </Link>
              ))}
            </div>
          ) : null}
        </section>

        {/* ── Dining ───────────────────────────────────────────── */}
        {dining.length ? (
          <section className="pt-16" id="dining">
            <Eyebrow>Dining</Eyebrow>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-white/60">
              Hotels serving food you can browse and order from.
            </p>
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {dining.map((property) => (
                <Link
                  key={property.branch_id}
                  to="/guest/$hotelSlug/explore"
                  params={{ hotelSlug: property.public_slug }}
                  className="neo-pub-card flex items-center gap-4 p-4"
                >
                  <span
                    className="grid size-11 shrink-0 place-items-center rounded-2xl bg-white/10 text-white"
                    aria-hidden
                  >
                    <UtensilsCrossed className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-white">
                      {property.property_name}
                    </span>
                    <span className="block truncate text-xs text-white/75">
                      {placeOf(property) ?? property.organization_name}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ) : null}
      </main>

      {/* ── Footer ─────────────────────────────────────────────── */}
      <footer className="neo-pub-footer mt-20">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-12 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-sm">
            <img src={NEO_WORDMARK_SRC} alt="NEØ" className="h-5 w-auto object-contain" />
            <p className="mt-4 text-sm leading-relaxed text-white/75">
              One entrance to every hotel running on NEØ — for guests, staff, partners and riders.
            </p>
          </div>
          <nav aria-label="NEØ" className="flex flex-col gap-2 text-sm">
            <a className="text-white/60 transition-colors hover:text-white" href="#discover">
              Discover hotels
            </a>
            <a className="text-white/60 transition-colors hover:text-white" href="#stays">
              Stays
            </a>
            <Link to="/auth" className="text-white/60 transition-colors hover:text-white">
              Sign in
            </Link>
            <Link
              to="/auth"
              search={{ mode: "create" }}
              className="text-white/60 transition-colors hover:text-white"
            >
              Put your hotel on NEØ
            </Link>
          </nav>
        </div>
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-5 pb-10 text-xs text-white/70 sm:flex-row sm:items-center sm:justify-between">
          <PoweredByNeo tone="light" />
          <PublicCreatorCredit />

        </div>
      </footer>
    </PublicSurface>
  );
}

/** One entrance a person may use at a hotel they already belong to. */
function DoorLink({
  to,
  enter,
  label,
  icon: Icon,
  primary = false,
}: {
  to: string;
  enter: "work" | "partner" | "rider" | "stay_dine";
  label: string;
  icon: typeof Briefcase;
  primary?: boolean;
}) {
  return (
    <Link
      to="/start/$propertySlug"
      params={{ propertySlug: to }}
      search={{ enter }}
      className={`inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-xs font-semibold transition-colors ${
        primary
          ? "bg-white text-[#020A1C] hover:bg-white/90"
          : "bg-white/10 text-white hover:bg-white/20"
      }`}
    >
      <Icon className="size-3.5" aria-hidden /> {label}
    </Link>
  );
}
