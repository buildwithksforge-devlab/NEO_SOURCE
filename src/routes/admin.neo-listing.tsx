/**
 * JOIN NEØ — a hotel's onboarding path onto the public platform.
 *
 * It reports the four canonical conditions that decide whether a property is
 * publicly discoverable, and is explicit about which two the hotel controls and
 * which two NEØ controls. It never changes a platform-owned fact from here.
 */
import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useBranches } from "@/lib/branches";
import { usePropertyListingStatus } from "@/lib/platform-console";

export const Route = createFileRoute("/admin/neo-listing")({
  head: () => ({
    meta: [
      { title: "Join NEØ — Configuration Centre" },
      {
        name: "description",
        content:
          "Take a property live on the public NEØ platform: see every condition that must be met before guests can find this hotel, and who controls each one.",
      },
      { property: "og:title", content: "Join NEØ — Configuration Centre" },
      {
        property: "og:description",
        content: "Public listing readiness for one property, condition by condition.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: NeoListingPage,
});

function Condition({
  met,
  title,
  owner,
  detail,
}: {
  met: boolean;
  title: string;
  owner: string;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border p-3">
      {met ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
      ) : (
        <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {title} <span className="text-xs font-normal text-muted-foreground">· {owner}</span>
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

/** One plain sentence, so nobody has to interpret four checkboxes. */
function listingOutcome(s: {
  publicly_discoverable: boolean;
  tenant_active: boolean;
  property_active: boolean;
  platform_eligible: boolean;
  hotel_discovery: boolean;
  has_public_experience: boolean;
}) {
  if (s.publicly_discoverable) return "Publicly listed — guests can find this hotel on NEØ.";
  if (!s.tenant_active) return "Not publicly listed — the business account is not active on NEØ.";
  if (!s.platform_eligible) return "Not publicly listed — NEØ has withheld this property from public listing.";
  if (!s.property_active) return "Not publicly listed — the property itself is switched off in your property settings.";
  if (!s.has_public_experience)
    return "Not publicly listed — no public experience has been set up for this property yet.";
  return "Not publicly listed — public listing is switched off in your public experience.";
}

function NeoListingPage() {
  const branches = useBranches();
  const [branchId, setBranchId] = useState<string | null>(null);

  useEffect(() => {
    if (!branchId && branches.data?.length) setBranchId(branches.data[0]!.id);
  }, [branches.data, branchId]);

  const status = usePropertyListingStatus(branchId);
  const s = status.data;
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const publicUrl = useMemo(
    () => (s?.public_slug ? `${origin}/start/${s.public_slug}` : null),
    [s?.public_slug, origin],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Join NEØ"
        description="What this property still needs before guests can find it on the public NEØ platform."
      />

      <SectionCard title="Property">
        <Select value={branchId ?? ""} onValueChange={(v) => setBranchId(v)}>
          <SelectTrigger className="max-w-sm">
            <SelectValue placeholder="Choose a property" />
          </SelectTrigger>
          <SelectContent>
            {(branches.data ?? []).map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SectionCard>

      {status.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Checking listing conditions…
        </div>
      ) : null}

      {status.isError ? (
        <SectionCard title="Listing conditions">
          <p className="text-sm text-muted-foreground">
            The listing conditions could not be read for this property.
          </p>
        </SectionCard>
      ) : null}

      {s ? (
        <SectionCard
          title={
            s.publicly_discoverable
              ? "This property is listed on NEØ"
              : "This property is not listed on NEØ yet"
          }
          description="All four conditions must be true at the same time."
        >
          <p className="mb-3 text-sm text-muted-foreground">{listingOutcome(s)}</p>
          <div className="space-y-2">
            <Condition
              met={s.tenant_active}
              title="Business active on NEØ"
              owner="NEØ controls this"
              detail="The business account behind this property is in good standing on the platform."
            />
            <Condition
              met={s.platform_eligible}
              title="Not blocked by NEØ"
              owner="NEØ controls this"
              detail="NEØ has not withheld this property from public listing."
            />
            <Condition
              met={s.property_active}
              title="Property active"
              owner="You control this"
              detail="The property itself is switched on in your own property settings."
            />
            <Condition
              met={s.hotel_discovery}
              title="Public listing switched on"
              owner="You control this"
              detail={
                s.has_public_experience
                  ? "Your public experience decides whether this hotel appears in the NEØ hotel list."
                  : "No public experience has been set up for this property yet."
              }
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button asChild variant="outline">
              <Link to="/admin/public-experience">Set up the public experience</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/admin/branches">Property settings</Link>
            </Button>
            {publicUrl ? (
              <a
                href={publicUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                Open this hotel's public page
              </a>
            ) : null}
          </div>

          {!s.tenant_active || !s.platform_eligible ? (
            <p className="mt-4 text-xs text-muted-foreground">
              One of the conditions NEØ controls is not met. That is decided by NEØ, not from inside
              your hotel — contact NEØ to have it reviewed.
            </p>
          ) : null}
        </SectionCard>
      ) : null}
    </div>
  );
}
