/**
 * Experience Studio.
 *
 * One place where a hotel configures the experience every customer, partner,
 * rider and staff member sees: its brand, its media, its words, which services
 * it truly offers, and whether it is published. It writes to the same single
 * record the public page already reads (neo_public_experience), so nothing here
 * is a second, parallel settings engine.
 */
import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Monitor, Smartphone, Tablet } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useBranches } from "@/lib/branches";
import { slugify } from "@/lib/public-apps";
import {
  brandDefaults,
  brandStyle,
  fontCatalogue,
  personalities,
  resolveBrand,
  type ExperienceBrand,
  type ExperienceContent,
  type ExperienceMedia,
  type FontKey,
  type PersonalityKey,
  serviceEnabled,
} from "@/lib/experience-brand";
import { useTrafficSummary } from "@/lib/traffic";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/experience-studio")({
  head: () => ({
    meta: [
      { title: "Experience Studio — Configuration Centre" },
      {
        name: "description",
        content:
          "Configure one property's brand, media, words, customer services and entrances, and publish the experience customers, partners and riders see.",
      },
      { property: "og:title", content: "Experience Studio — Configuration Centre" },
      {
        property: "og:description",
        content: "One hotel brand, applied across Stay & Dine, Work, Partner and Rider.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ExperienceStudioPage,
});

type SectionKey = "overview" | "brand" | "stay" | "work" | "partner" | "rider" | "publishing";

const sections: { key: SectionKey; label: string; hint: string }[] = [
  { key: "overview", label: "Overview", hint: "Readiness and what is live" },
  { key: "brand", label: "Brand", hint: "Colours, type, logo and imagery" },
  { key: "stay", label: "Stay & Dine", hint: "What guests can do" },
  { key: "work", label: "Work", hint: "The staff entrance" },
  { key: "partner", label: "Partner", hint: "Suppliers and corporate clients" },
  { key: "rider", label: "Rider", hint: "Delivery riders" },
  { key: "publishing", label: "Publishing", hint: "Address, listing and links" },
];

const serviceFields: { key: string; label: string; hint: string }[] = [
  { key: "hotel_information", label: "Hotel information", hint: "About, facilities and contact." },
  { key: "rooms", label: "Rooms", hint: "Show room types and rates." },
  { key: "booking", label: "Room booking", hint: "Let customers request a reservation." },
  { key: "menu", label: "Digital menu", hint: "Show the restaurant menu." },
  { key: "food_ordering", label: "Food ordering", hint: "Accept customer food orders." },
  { key: "pickup", label: "Pickup", hint: "Customers collect their own order." },
  { key: "delivery", label: "Delivery", hint: "Deliver orders to the customer." },
  { key: "room_service", label: "Room service", hint: "Ordering for guests staying in a room." },
  { key: "laundry_resident", label: "Laundry — resident guests", hint: "Charge to the room." },
  { key: "laundry_public", label: "Laundry — public customers", hint: "No stay required." },
  { key: "laundry_collection", label: "Laundry — collection", hint: "You collect from the customer." },
  { key: "laundry_delivery", label: "Laundry — delivery back", hint: "You return laundry." },
  { key: "guest_requests", label: "Guest requests", hint: "Requests routed to your departments." },
  { key: "feedback", label: "Feedback", hint: "Let customers leave feedback." },
];

type ExperienceRow = {
  id: string;
  organization_id: string;
  branch_id: string;
  public_slug: string;
  discoverable: boolean;
  display_name: string | null;
  tagline: string | null;
  summary: string | null;
  cover_image_url: string | null;
  website_url: string | null;
  services: Record<string, boolean>;
  doors: Record<string, boolean>;
  brand: ExperienceBrand;
  media: ExperienceMedia;
  content: ExperienceContent;
  published_at?: string | null;
};

function ExperienceStudioPage() {
  const { can, organizationId } = useAuth();
  const canEdit = can("administration", "workspace", "edit");
  const branches = useBranches();
  const queryClient = useQueryClient();
  const [branchId, setBranchId] = useState<string | null>(null);
  const [section, setSection] = useState<SectionKey>("overview");
  const [device, setDevice] = useState<"phone" | "tablet" | "desktop">("phone");

  useEffect(() => {
    if (!branchId && branches.data?.length) setBranchId(branches.data[0]!.id);
  }, [branches.data, branchId]);

  const branch = useMemo(
    () => branches.data?.find((b) => b.id === branchId) ?? null,
    [branches.data, branchId],
  );

  const config = useQuery({
    queryKey: ["neo-experience-studio", branchId],
    enabled: Boolean(branchId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("neo_public_experience" as never)
        .select("*")
        .eq("branch_id", branchId!)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as unknown as ExperienceRow | null) ?? null;
    },
  });

  const [draft, setDraft] = useState<ExperienceRow | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!branch) return;
    const row = config.data;
    setDirty(false);
    setDraft(
      row
        ? {
            ...row,
            services: row.services ?? {},
            doors: row.doors ?? {},
            brand: row.brand ?? {},
            media: row.media ?? {},
            content: row.content ?? {},
          }
        : {
            id: "",
            organization_id: organizationId ?? "",
            branch_id: branch.id,
            public_slug: slugify(branch.name),
            discoverable: false,
            display_name: branch.name,
            tagline: null,
            summary: null,
            cover_image_url: null,
            website_url: null,
            services: {},
            doors: { stay_dine: true, work: true, partner: true, rider: true },
            brand: {},
            media: {},
            content: {},
          },
    );
  }, [config.data, branch, organizationId]);

  const patch = (next: Partial<ExperienceRow>) => {
    setDraft((prev) => (prev ? { ...prev, ...next } : prev));
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: async ({ row, publish }: { row: ExperienceRow; publish?: boolean }) => {
      const payload: Record<string, unknown> = {
        organization_id: organizationId,
        branch_id: row.branch_id,
        public_slug: slugify(row.public_slug || row.display_name || "hotel"),
        discoverable: publish === undefined ? row.discoverable : publish,
        display_name: row.display_name,
        tagline: row.tagline,
        summary: row.summary,
        cover_image_url: row.cover_image_url,
        website_url: row.website_url?.trim() ? row.website_url.trim() : null,
        services: row.services,
        doors: row.doors,
        brand: row.brand,
        media: row.media,
        content: row.content,
      };
      if (publish) payload['published_at'] = new Date().toISOString();
      const { error } = await supabase
        .from("neo_public_experience" as never)
        .upsert(payload as never, { onConflict: "branch_id" });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      setDirty(false);
      toast.success("Experience saved");
      void queryClient.invalidateQueries({ queryKey: ["neo-experience-studio", branchId] });
      void queryClient.invalidateQueries({ queryKey: ["neo-public-experience", branchId] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const resolved = resolveBrand(draft?.brand);
  const slug = draft ? slugify(draft.public_slug || draft.display_name || "hotel") : "";
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  const readiness = draft
    ? [
        { label: "Name shown to customers", done: Boolean(draft.display_name?.trim()) },
        { label: "Short description", done: Boolean(draft.summary?.trim()) },
        { label: "Brand colours and type chosen", done: Object.keys(draft.brand ?? {}).length > 0 },
        { label: "Cover image", done: Boolean(draft.media?.hero_url || draft.cover_image_url) },
        {
          label: "At least one customer service switched on",
          done: Object.values(draft.services ?? {}).some(Boolean),
        },
        { label: "Public address set", done: Boolean(slug) },
        { label: "Listed publicly", done: Boolean(draft.discoverable) },
      ]
    : [];

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        eyebrow="Customer experience"
        title="Experience Studio"
        description="One brand for this property, applied everywhere it is seen. Nothing here changes who may enter an entrance — that is always decided by a person's real relationship with the hotel."
        actions={
          canEdit && draft ? (
            <Button onClick={() => save.mutate({ row: draft })} disabled={save.isPending || !dirty}>
              {save.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              {dirty ? "Save changes" : "Saved"}
            </Button>
          ) : undefined
        }
      />

      {branches.isLoading ? (
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading properties…
        </div>
      ) : null}

      {branches.data?.length ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {branches.data.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => setBranchId(b.id)}
              className={cn(
                "rounded-full border px-4 py-1.5 text-xs font-medium",
                b.id === branchId
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground",
              )}
            >
              {b.name}
            </button>
          ))}
        </div>
      ) : null}

      {draft ? (
        <div className="grid gap-5 lg:grid-cols-[200px_minmax(0,1fr)_320px]">
          {/* Studio sections */}
          <nav className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible">
            {sections.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setSection(s.key)}
                className={cn(
                  "shrink-0 rounded-xl border px-3 py-2 text-left",
                  section === s.key ? "border-primary bg-primary-soft" : "border-border",
                )}
              >
                <span className="block text-sm font-medium">{s.label}</span>
                <span className="hidden text-[0.7rem] text-muted-foreground lg:block">{s.hint}</span>
              </button>
            ))}
          </nav>

          <div className="min-w-0 space-y-4">
            {section === "overview" ? (
              <SectionCard
                title="Readiness"
                description="What is still missing before this experience is complete."
              >
                <ul className="space-y-2">
                  {readiness.map((item) => (
                    <li key={item.label} className="flex items-center gap-2 text-sm">
                      <span
                        className={cn(
                          "flex size-5 items-center justify-center rounded-full border text-[0.6rem]",
                          item.done
                            ? "border-emerald-500 bg-emerald-500/10 text-emerald-600"
                            : "border-border text-muted-foreground",
                        )}
                      >
                        {item.done ? <Check className="size-3" /> : "—"}
                      </span>
                      <span className={item.done ? "" : "text-muted-foreground"}>{item.label}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-xs text-muted-foreground">
                  {draft.published_at
                    ? `Last published ${new Date(draft.published_at).toLocaleString()}.`
                    : "This experience has not been published yet."}
                </p>
              </SectionCard>
            ) : null}

            {section === "brand" ? (
              <>
                <SectionCard title="Personality" description="A starting point you can then adjust.">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {(Object.keys(personalities) as PersonalityKey[]).map((key) => (
                      <button
                        key={key}
                        type="button"
                        disabled={!canEdit}
                        onClick={() => {
                          const { display_font: _d, body_font: _b, ...rest } = draft.brand;
                          patch({ brand: { ...rest, personality: key } });
                        }}
                        className={cn(
                          "rounded-xl border p-3 text-left",
                          resolved.personality === key ? "border-primary bg-primary-soft" : "border-border",
                        )}
                      >
                        <span className="block text-sm font-medium">{personalities[key].label}</span>
                        <span className="block text-xs text-muted-foreground">{personalities[key].hint}</span>
                      </button>
                    ))}
                  </div>
                </SectionCard>

                <SectionCard title="Colours" description="Used across every surface this hotel owns.">
                  <div className="grid gap-4 sm:grid-cols-4">
                    {([
                      ["primary", "Primary"],
                      ["accent", "Accent"],
                      ["surface", "Deep surface"],
                      ["ink", "Light text"],
                    ] as const).map(([key, label]) => (
                      <div key={key} className="space-y-1.5">
                        <Label htmlFor={`c-${key}`}>{label}</Label>
                        <div className="flex items-center gap-2">
                          <input
                            id={`c-${key}`}
                            type="color"
                            disabled={!canEdit}
                            value={resolved[key]}
                            onChange={(e) => patch({ brand: { ...draft.brand, [key]: e.target.value } })}
                            className="size-9 cursor-pointer rounded-md border border-border bg-transparent"
                          />
                          <Input
                            value={resolved[key]}
                            disabled={!canEdit}
                            onChange={(e) => patch({ brand: { ...draft.brand, [key]: e.target.value } })}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </SectionCard>

                <SectionCard title="Type and shape" description="Only fonts the platform already serves.">
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="space-y-1.5">
                      <Label>Headline font</Label>
                      <select
                        className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                        disabled={!canEdit}
                        value={draft.brand.display_font ?? personalities[resolved.personality].display}
                        onChange={(e) =>
                          patch({ brand: { ...draft.brand, display_font: e.target.value as FontKey } })
                        }
                      >
                        {(Object.keys(fontCatalogue) as FontKey[]).map((f) => (
                          <option key={f} value={f}>
                            {fontCatalogue[f].label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Body font</Label>
                      <select
                        className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                        disabled={!canEdit}
                        value={draft.brand.body_font ?? personalities[resolved.personality].body}
                        onChange={(e) =>
                          patch({ brand: { ...draft.brand, body_font: e.target.value as FontKey } })
                        }
                      >
                        {(Object.keys(fontCatalogue) as FontKey[]).map((f) => (
                          <option key={f} value={f}>
                            {fontCatalogue[f].label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="radius">Corner softness ({resolved.radius}px)</Label>
                      <input
                        id="radius"
                        type="range"
                        min={0}
                        max={32}
                        disabled={!canEdit}
                        value={resolved.radius}
                        onChange={(e) => patch({ brand: { ...draft.brand, radius: Number(e.target.value) } })}
                        className="w-full"
                      />
                    </div>
                  </div>
                </SectionCard>

                <SectionCard title="Media" description="Your own photography. Nothing is invented for you.">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="logo">Logo address</Label>
                      <Input
                        id="logo"
                        placeholder="https://…"
                        disabled={!canEdit}
                        value={draft.media.logo_url ?? ""}
                        onChange={(e) => patch({ media: { ...draft.media, logo_url: e.target.value } })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="hero">Cover photograph address</Label>
                      <Input
                        id="hero"
                        placeholder="https://…"
                        disabled={!canEdit}
                        value={draft.media.hero_url ?? draft.cover_image_url ?? ""}
                        onChange={(e) =>
                          patch({
                            media: { ...draft.media, hero_url: e.target.value },
                            cover_image_url: e.target.value,
                          })
                        }
                      />
                    </div>
                  </div>
                </SectionCard>
              </>
            ) : null}

            {section === "stay" ? (
              <>
                <SectionCard title="Words" description="What a guest reads first.">
                  <div className="grid gap-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="wt">Welcome title</Label>
                      <Input
                        id="wt"
                        disabled={!canEdit}
                        value={draft.content.welcome_title ?? ""}
                        onChange={(e) =>
                          patch({ content: { ...draft.content, welcome_title: e.target.value } })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="wm">Welcome message</Label>
                      <Textarea
                        id="wm"
                        rows={3}
                        disabled={!canEdit}
                        value={draft.content.welcome_message ?? ""}
                        onChange={(e) =>
                          patch({ content: { ...draft.content, welcome_message: e.target.value } })
                        }
                      />
                    </div>
                  </div>
                </SectionCard>
                <SectionCard
                  title="Customer services"
                  description="Only the services you switch on are offered. A service that is off is never shown."
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    {serviceFields.map((field) => (
                      <label key={field.key} className="flex items-start gap-3">
                        <Switch
                          checked={serviceEnabled(draft.services, field.key)}
                          disabled={!canEdit}
                          onCheckedChange={(v) =>
                            patch({ services: { ...draft.services, [field.key]: v } })
                          }
                        />
                        <span>
                          <span className="block text-sm font-medium">{field.label}</span>
                          <span className="block text-xs text-muted-foreground">{field.hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </SectionCard>
              </>
            ) : null}

            {(["work", "partner", "rider"] as const).includes(section as "work") ||
            section === "partner" ||
            section === "rider" ? (
              <EntranceSection
                section={section}
                draft={draft}
                canEdit={canEdit}
                patch={patch}
              />
            ) : null}

            {section === "publishing" ? (
              <>
                <SectionCard title="Public listing" description="How this hotel appears on the NEØ front door.">
                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="flex items-start gap-3">
                      <Switch
                        checked={draft.discoverable}
                        disabled={!canEdit}
                        onCheckedChange={(v) => patch({ discoverable: v })}
                      />
                      <span>
                        <span className="block text-sm font-medium">List this hotel publicly</span>
                        <span className="block text-xs text-muted-foreground">
                          When off, the hotel is still reachable by its own link and by its own
                          people, but never appears in the public hotel list.
                        </span>
                      </span>
                    </label>
                    <div className="space-y-1.5">
                      <Label htmlFor="slug">Public address</Label>
                      <Input
                        id="slug"
                        disabled={!canEdit}
                        value={draft.public_slug}
                        onChange={(e) => patch({ public_slug: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="dn">Name shown to customers</Label>
                      <Input
                        id="dn"
                        disabled={!canEdit}
                        value={draft.display_name ?? ""}
                        onChange={(e) => patch({ display_name: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="tl">Tagline</Label>
                      <Input
                        id="tl"
                        disabled={!canEdit}
                        value={draft.tagline ?? ""}
                        onChange={(e) => patch({ tagline: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5 md:col-span-2">
                      <Label htmlFor="sm">Short description</Label>
                      <Textarea
                        id="sm"
                        rows={3}
                        disabled={!canEdit}
                        value={draft.summary ?? ""}
                        onChange={(e) => patch({ summary: e.target.value })}
                      />
                    </div>
                  </div>
                  {canEdit ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button
                        onClick={() => save.mutate({ row: draft, publish: true })}
                        disabled={save.isPending}
                      >
                        Publish experience
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => save.mutate({ row: draft, publish: false })}
                        disabled={save.isPending}
                      >
                        Unlist
                      </Button>
                    </div>
                  ) : null}
                </SectionCard>

                <SectionCard
                  title="Your hotel website"
                  description="Add your own website address, then put the tagged links below on it. Anyone who arrives through them books, orders and pays here, and the arrival is counted for you."
                >
                  <div className="space-y-2">
                    <Label htmlFor="website-url">Hotel website address</Label>
                    <Input
                      id="website-url"
                      placeholder="https://www.yourhotel.com"
                      value={draft.website_url ?? ""}
                      onChange={(e) => patch({ website_url: e.target.value })}
                    />
                  </div>
                </SectionCard>

                <SectionCard
                  title="Links"
                  description="Put these on your own website, a social profile or a QR code. Each one tells you where the visitor came from."
                >
                  <ul className="space-y-2 text-sm">
                    {[
                      { label: "Hotel front door", url: `${origin}/start/${slug}` },
                      { label: "Stay & Dine", url: `${origin}/guest/${slug}` },
                      { label: "Food delivery", url: `${origin}/delivery/${slug}` },
                      { label: "Partner portal", url: `${origin}/partner/${slug}` },
                      { label: "Rider app", url: `${origin}/rider` },
                    ].map((link) => {
                      const tagged = `${link.url}?utm_source=hotel-website&utm_medium=referral`;
                      return (
                        <li key={link.label} className="flex flex-wrap items-center gap-2">
                          <span className="w-40 shrink-0 text-muted-foreground">{link.label}</span>
                          <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
                            {tagged}
                          </code>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              void navigator.clipboard.writeText(tagged);
                              toast.success("Link copied");
                            }}
                          >
                            Copy
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </SectionCard>

                <ArrivalsCard branchId={branchId} />
              </>
            ) : null}
          </div>

          {/* Live preview */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              {([
                ["phone", Smartphone],
                ["tablet", Tablet],
                ["desktop", Monitor],
              ] as const).map(([key, Icon]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setDevice(key)}
                  aria-label={key}
                  className={cn(
                    "rounded-lg border p-2",
                    device === key ? "border-primary bg-primary-soft" : "border-border",
                  )}
                >
                  <Icon className="size-4" />
                </button>
              ))}
              <span className="text-xs text-muted-foreground">Live preview</span>
            </div>

            <div
              className={cn(
                "mx-auto overflow-hidden border border-border",
                device === "phone" && "aspect-[9/17] w-full max-w-[230px] rounded-[2rem]",
                device === "tablet" && "aspect-[3/4] w-full max-w-[300px] rounded-2xl",
                device === "desktop" && "aspect-[16/10] w-full rounded-xl",
              )}
              style={brandStyle(draft.brand)}
            >
              <div
                className="flex h-full w-full flex-col justify-end p-4"
                style={{
                  background: draft.media.hero_url || draft.cover_image_url
                    ? `linear-gradient(180deg, rgba(2,10,28,0.15), rgba(2,10,28,0.85)), url(${
                        draft.media.hero_url || draft.cover_image_url
                      }) center/cover`
                    : `linear-gradient(160deg, ${resolved.surface}, ${resolved.primary})`,
                  fontFamily: "var(--pb-body)",
                  color: resolved.ink,
                }}
              >
                {draft.media.logo_url ? (
                  <img
                    src={draft.media.logo_url}
                    alt=""
                    className="mb-auto h-8 w-auto self-start object-contain"
                  />
                ) : null}
                <span
                  className="text-[0.62rem] uppercase tracking-[0.2em]"
                  style={{ color: resolved.accent }}
                >
                  {draft.tagline || "Your tagline"}
                </span>
                <span className="mt-1 text-xl leading-tight" style={{ fontFamily: "var(--pb-display)" }}>
                  {draft.content.welcome_title || draft.display_name || "Your hotel"}
                </span>
                <span className="mt-1 text-[0.7rem] opacity-80">
                  {draft.content.welcome_message || draft.summary || "Your welcome message appears here."}
                </span>
                <span
                  className="mt-3 self-start px-4 py-2 text-xs font-medium"
                  style={{
                    background: resolved.primary,
                    color: resolved.surface,
                    borderRadius: "var(--pb-radius)",
                  }}
                >
                  Stay &amp; Dine
                </span>
              </div>
            </div>
            <p className="text-center text-[0.7rem] text-muted-foreground">
              Powered by NEØ appears on every public surface.
            </p>
          </div>
        </div>
      ) : null}

      {!canEdit ? (
        <p className="mt-4 text-sm text-muted-foreground">
          You can view this configuration but not change it.
        </p>
      ) : null}
    </div>
  );
}

function EntranceSection({
  section,
  draft,
  canEdit,
  patch,
}: {
  section: SectionKey;
  draft: ExperienceRow;
  canEdit: boolean;
  patch: (next: Partial<ExperienceRow>) => void;
}) {
  const map: Record<string, { door: string; title: string; note: keyof ExperienceContent; body: string }> = {
    work: {
      door: "work",
      title: "Work",
      note: "stay_note",
      body: "The staff entrance for people employed at this property. Switching it on does not grant anyone access; staff accounts are still what decide entry.",
    },
    partner: {
      door: "partner",
      title: "Partner",
      note: "partner_note",
      body: "Suppliers, corporate clients and contractors with a granted portal relationship.",
    },
    rider: {
      door: "rider",
      title: "Rider",
      note: "rider_note",
      body: "Registered delivery riders working for this property.",
    },
  };
  const conf = map[section];
  if (!conf) return null;
  return (
    <SectionCard title={`${conf.title} entrance`} description={conf.body}>
      <label className="flex items-start gap-3">
        <Switch
          checked={draft.doors?.[conf.door] !== false}
          disabled={!canEdit}
          onCheckedChange={(v) => patch({ doors: { ...draft.doors, [conf.door]: v } })}
        />
        <span>
          <span className="block text-sm font-medium">Show this entrance on the hotel page</span>
          <span className="block text-xs text-muted-foreground">
            Access is always decided by a real relationship, never by this switch.
          </span>
        </span>
      </label>
      <div className="mt-4 space-y-1.5">
        <Label htmlFor={`note-${section}`}>Note shown on this entrance</Label>
        <Textarea
          id={`note-${section}`}
          rows={2}
          disabled={!canEdit}
          value={(draft.content[conf.note] as string | undefined) ?? ""}
          onChange={(e) => patch({ content: { ...draft.content, [conf.note]: e.target.value } })}
        />
      </div>
    </SectionCard>
  );
}

export { brandDefaults };

/**
 * Where arrivals came from. Counts only — no visitor is identified — and only
 * for a property the signed-in person is already permitted to see.
 */
function ArrivalsCard({ branchId }: { branchId: string | null }) {
  const traffic = useTrafficSummary(branchId);
  const summary = traffic.data;

  return (
    <SectionCard
      title="Where your visitors come from"
      description="Arrivals at this property's public entrances over the last 30 days."
    >
      {traffic.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading arrivals…
        </p>
      ) : !summary?.allowed ? (
        <p className="text-sm text-muted-foreground">
          You are not permitted to see arrivals for this property.
        </p>
      ) : (summary.total ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground">
          No arrivals recorded yet. Once your tagged links are live on your website, visits appear
          here.
        </p>
      ) : (
        <div className="space-y-4 text-sm">
          <p className="text-2xl font-semibold tabular-nums">{summary.total}</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <p className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Entrance</p>
              <ul className="space-y-1">
                {(summary.by_door ?? []).map((d) => (
                  <li key={d.door} className="flex justify-between gap-2">
                    <span className="truncate">{d.door.replace(/_/g, " ")}</span>
                    <span className="tabular-nums">{d.visits}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Source</p>
              <ul className="space-y-1">
                {(summary.by_source ?? []).map((s) => (
                  <li key={`${s.source}-${s.medium}-${s.campaign}`} className="flex justify-between gap-2">
                    <span className="truncate">{s.source}</span>
                    <span className="tabular-nums">{s.visits}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                Referring site
              </p>
              <ul className="space-y-1">
                {(summary.by_referrer ?? []).map((r) => (
                  <li key={r.referrer} className="flex justify-between gap-2">
                    <span className="truncate">{r.referrer}</span>
                    <span className="tabular-nums">{r.visits}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
