/**
 * NEØ PLATFORM CONSOLE — the SaaS operator's surface.
 *
 * Deliberately separate from hotel administration. Hotel administrators
 * configure their own property; only a registered NEØ platform operator sees
 * the businesses on the platform, their tenant state, and whether a property is
 * allowed to appear in public discovery.
 */
import { useState } from "react";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Building2, Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusPill } from "@/components/common/DataDisplay";
import { supabase } from "@/integrations/supabase/client";
import {
  useClaimFirstOperator,
  usePlatformConsole,
  useSetPropertyListing,
  type ConsoleProperty,
} from "@/lib/platform-console";
import { brandFallback } from "@/lib/public-apps";
import { NEO_WORDMARK_SRC } from "@/components/brand/NeoIdentity";

export const Route = createFileRoute("/platform-console")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({ to: "/auth", search: { redirect: location.href } });
    }
    return { user: data.user };
  },
  head: () => ({
    meta: [
      { title: "NEØ Platform Console" },
      {
        name: "description",
        content:
          "Platform-operator console for the businesses and properties running on NEØ, their tenant state and their public discovery eligibility.",
      },
      { property: "og:title", content: "NEØ Platform Console" },
      {
        property: "og:description",
        content: "Businesses, properties, tenant status and public discovery eligibility on NEØ.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PlatformConsolePage,
});

type ConsoleSection = "overview" | "businesses" | "properties";

/** Why a property is or is not visible to the public — operator's view. */
type VisibilityFilter = "all" | "listed" | "hotel_off" | "blocked" | "inactive";

const VISIBILITY_FILTERS: { key: VisibilityFilter; label: string }[] = [
  { key: "all", label: "All properties" },
  { key: "listed", label: "Listed publicly" },
  { key: "hotel_off", label: "Hotel discovery off" },
  { key: "blocked", label: "Blocked by NEØ" },
  { key: "inactive", label: "Property inactive" },
];

function visibilityOf(p: ConsoleProperty): Exclude<VisibilityFilter, "all"> {
  if (p.listed) return "listed";
  if (p.listing_state === "blocked") return "blocked";
  if (!p.active) return "inactive";
  return "hotel_off";
}

const CONSOLE_SECTIONS: { key: ConsoleSection; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "businesses", label: "Businesses" },
  { key: "properties", label: "Properties" },
];

function PlatformConsolePage() {
  const console_ = usePlatformConsole();
  const [filter, setFilter] = useState("");
  const [section, setSection] = useState<ConsoleSection>("overview");

  return (
    <div
      className="neo-public-app min-h-screen lg:flex"
      style={{ background: brandFallback.navy }}
    >
      {/* Operator rail: the console's own navigation, separate from any
          hotel's administration. */}
       <aside className="min-w-0 shrink-0 border-b border-white/10 px-5 py-6 lg:h-screen lg:w-64 lg:border-b-0 lg:border-r lg:py-8">
        <img src={NEO_WORDMARK_SRC} alt="NEØ" className="h-5 w-auto object-contain" />
        <p className="mt-2 neo-pub-eyebrow">Platform console</p>
         <nav aria-label="Console sections" className="neo-scroll-x mt-6 flex min-w-0 gap-2 pb-1 lg:flex-col">
          {CONSOLE_SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSection(s.key)}
              aria-current={s.key === section ? "page" : undefined}
              className={`rounded-xl px-4 py-2 text-left text-sm font-semibold transition-colors ${
                s.key === section ? "bg-white text-[#020A1C]" : "bg-white/5 text-white/70"
              }`}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <Link
          to="/"
          className="mt-6 inline-block text-xs font-semibold text-white/60 hover:text-white"
        >
          Back to my workspace
        </Link>
      </aside>

       <main className="mx-auto w-full max-w-5xl min-w-0 px-5 pb-16 pt-8">
         <h1 className="neo-public-title text-white">NEØ Platform Console</h1>
        <p className="mt-2 max-w-2xl text-sm text-white/65">
          Platform-operator view of the businesses and properties on NEØ. Hotel-level
          configuration — branding, rooms, staff, menu, finance, delivery — stays with each hotel's
          own administration and is not managed here.
        </p>

        {console_.isLoading ? (
          <div className="mt-8 flex items-center gap-2 text-sm text-white/60">
            <Loader2 className="size-4 animate-spin" /> Loading platform records…
          </div>
        ) : null}

        {console_.data && !console_.data.allowed ? (
          <div className="mt-8 rounded-2xl bg-white/5 p-6">
            <div className="flex items-center gap-2 text-white">
              <ShieldAlert className="size-5" aria-hidden />
              <h2 className="text-base font-semibold">Platform-operator access only</h2>
            </div>
            <p className="mt-2 text-sm text-white/65">
              Your account is not registered as a NEØ platform operator. This surface is separate
              from hotel administration: a hotel administrator never gains platform-operator powers.
            </p>
            {console_.data.operators === 0 ? <ClaimFirstOperator /> : null}
          </div>
        ) : null}

        {console_.data?.allowed ? (
          <>
            {console_.data.summary && section === "overview" ? (
              <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
                <SummaryTile label="Businesses" value={console_.data.summary.businesses} />
                <SummaryTile label="Properties" value={console_.data.summary.properties} />
                <SummaryTile label="Listed publicly" value={console_.data.summary.listed} />
                <SummaryTile label="Blocked by NEØ" value={console_.data.summary.blocked} />
                <SummaryTile
                  label="Not active"
                  value={console_.data.summary.suspended_tenants}
                />
              </div>
            ) : null}
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by business or property"
              aria-label="Filter businesses"
              className="mt-6 h-11 rounded-xl border-white/15 bg-white/5 text-white placeholder:text-white/40"
            />
            {section === "properties" ? (
              <PropertiesTable businesses={console_.data.businesses ?? []} filter={filter} />
            ) : null}

            <div className={section === "properties" ? "hidden" : "mt-5 space-y-4"}>

              {(console_.data.businesses ?? [])
                .filter((b) => {
                  const q = filter.trim().toLowerCase();
                  if (!q) return true;
                  return (
                    b.name.toLowerCase().includes(q) ||
                    b.properties.some((p) => p.name.toLowerCase().includes(q))
                  );
                })
                .map((b) => (
                  <section key={b.organization_id} className="rounded-2xl bg-white/5 p-5">
                     <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                       <div className="flex min-w-0 items-center gap-3">
                        <Building2 className="size-5 text-white/60" aria-hidden />
                         <div className="min-w-0">
                           <h2 className="truncate text-base font-semibold text-white">{b.name}</h2>
                           <p className="truncate text-xs text-white/50">
                            {b.legal_name || "Legal name not recorded"} ·{" "}
                            {b.properties.length} propert{b.properties.length === 1 ? "y" : "ies"}
                          </p>
                        </div>
                      </div>
                      <StatusPill tone={b.tenant_state === "active" ? "success" : "warning"}>
                        {b.tenant_state}
                      </StatusPill>
                    </div>

                    <div className="mt-4 space-y-2">
                      {b.properties.length === 0 ? (
                        <p className="text-sm text-white/50">No properties recorded.</p>
                      ) : null}
                      {b.properties.map((p) => (
                        <PropertyRow key={p.branch_id} property={p} />
                      ))}
                    </div>

                    {b.entitlements?.length ? (
                      <div className="mt-4 border-t border-white/10 pt-3">
                        <p className="text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-white/40">
                          Platform entitlements
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {b.entitlements.map((f) => (
                            <span
                              key={f.key}
                              className="rounded-full bg-white/5 px-3 py-1 text-[0.7rem] text-white/70"
                              title={`${f.source}`}
                            >
                              {f.name || f.key}: {f.enabled ? "on" : "off"}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </section>
                ))}
            </div>

            <p className="mt-8 text-xs text-white/40">
              Subscription and billing are not part of this console. NEØ does not currently hold
              platform plan or billing records, so nothing of that kind is shown here.
            </p>
          </>
        ) : null}
      </main>
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl bg-white/5 px-4 py-3">
      <p className="text-xl font-semibold text-white">{value}</p>
      <p className="text-[0.7rem] uppercase tracking-[0.14em] text-white/45">{label}</p>
    </div>
  );
}

/**
 * One-time bootstrap. It appears only while NEØ has no operator at all, and the
 * database refuses it the moment one exists — so it cannot be used to climb
 * into an established platform.
 */
function ClaimFirstOperator() {
  const claim = useClaimFirstOperator();
  return (
    <div className="mt-4 rounded-xl bg-white/5 p-4">
      <p className="text-sm text-white/70">
        No NEØ platform operator has been registered yet. You can register this signed-in account as
        the first operator. This is possible exactly once: as soon as an operator exists, only an
        existing operator can add another.
      </p>
      <Button
        className="mt-3"
        disabled={claim.isPending}
        onClick={() =>
          claim.mutate(undefined, {
            onSuccess: () => toast.success("Registered as the first NEØ platform operator"),
            onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not register"),
          })
        }
      >
        {claim.isPending ? "Registering…" : "Register this account as the first operator"}
      </Button>
    </div>
  );
}


function PropertyRow({ property }: { property: ConsoleProperty }) {
  const setListing = useSetPropertyListing();
  const blocked = property.listing_state === "blocked";

  function toggle() {
    setListing.mutate(
      { branchId: property.branch_id, state: blocked ? "eligible" : "blocked" },
      {
        onSuccess: () =>
          toast.success(
            blocked
              ? `${property.name} may appear in public discovery again`
              : `${property.name} is blocked from public discovery`,
          ),
        onError: (e) => toast.error(e instanceof Error ? e.message : "Could not update listing"),
      },
    );
  }

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 rounded-xl bg-white/5 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-white">{property.name}</p>
        <p className="truncate text-xs text-white/50">
          {[property.city, property.country].filter(Boolean).join(", ") || "Location not recorded"}
          {property.public_slug ? ` · /${property.public_slug}` : " · no public address"}
        </p>
      </div>
       <div data-public-actions className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">
        <StatusPill tone={property.active ? "success" : "warning"}>
          {property.active ? "Property active" : "Property inactive"}
        </StatusPill>
        <StatusPill tone={property.hotel_discovery ? "info" : "default"}>
          {property.hotel_discovery ? "Hotel discovery on" : "Hotel discovery off"}
        </StatusPill>
        <StatusPill tone={property.listed ? "success" : "default"}>
          {property.listed ? "Listed publicly" : "Not listed"}
        </StatusPill>
        <Button
          size="sm"
          variant={blocked ? "secondary" : "outline"}
          onClick={toggle}
          disabled={setListing.isPending}
        >
          {blocked ? "Allow listing" : "Block listing"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Every property on NEØ in one table, so an operator can see listing state
 * across businesses rather than business by business.
 */
function PropertiesTable({
  businesses,
  filter,
}: {
  businesses: { organization_id: string; name: string; properties: ConsoleProperty[] }[];
  filter: string;
}) {
  const [visibility, setVisibility] = useState<VisibilityFilter>("all");
  const q = filter.trim().toLowerCase();
  const rows = businesses.flatMap((b) =>
    b.properties
      .filter((p) => !q || p.name.toLowerCase().includes(q) || b.name.toLowerCase().includes(q))
      .filter((p) => visibility === "all" || visibilityOf(p) === visibility)
      .map((p) => ({ business: b.name, property: p })),
  );

  const filters = (
    <div className="mt-5 flex flex-wrap gap-2">
      {VISIBILITY_FILTERS.map((f) => (
        <button
          key={f.key}
          type="button"
          onClick={() => setVisibility(f.key)}
          aria-pressed={visibility === f.key}
          className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
            visibility === f.key ? "bg-white text-[#020A1C]" : "bg-white/10 text-white/70"
          }`}
        >
          {f.label}
        </button>
      ))}
    </div>
  );

  if (rows.length === 0) {
    return (
      <>
        {filters}
        <p className="mt-6 text-sm text-white/55">
          {q || visibility !== "all"
            ? "No property matches that search or filter."
            : "No properties recorded on NEØ yet."}
        </p>
      </>
    );
  }

  return (
    <>
    {filters}
    <div className="neo-table-scroll mt-5 rounded-2xl bg-white/5">
      <table className="w-full min-w-[44rem] table-fixed text-left text-sm">
        <thead>
          <tr className="text-[0.7rem] uppercase tracking-[0.14em] text-white/40">
            <th className="px-4 py-3 font-medium">Business</th>
            <th className="px-4 py-3 font-medium">Property</th>
            <th className="px-4 py-3 font-medium">Location</th>
            <th className="px-4 py-3 font-medium">Public address</th>
            <th className="px-4 py-3 font-medium">Listing</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ business, property }) => (
            <tr key={property.branch_id} className="border-t border-white/5 text-white/75">
               <td className="truncate px-4 py-3" title={business}>{business}</td>
               <td className="truncate px-4 py-3 text-white" title={property.name}>{property.name}</td>
               <td className="truncate px-4 py-3">
                {[property.city, property.country].filter(Boolean).join(", ") || "Not recorded"}
              </td>
               <td className="truncate px-4 py-3">
                {property.public_slug ? `/${property.public_slug}` : "None"}
              </td>
              <td className="px-4 py-3">
                <StatusPill tone={property.listed ? "success" : "default"}>
                  {property.listed
                    ? "Listed publicly"
                    : property.listing_state === "blocked"
                      ? "Blocked by NEØ"
                      : !property.active
                        ? "Property inactive"
                        : !property.hotel_discovery
                          ? "Hotel discovery off"
                          : "Not listed"}
                </StatusPill>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  );
}
