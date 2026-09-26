import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2 } from "lucide-react";
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

export const Route = createFileRoute("/admin/public-experience")({
  head: () => ({
    meta: [
      { title: "Public experience — Configuration Centre" },
      {
        name: "description",
        content:
          "Decide whether this hotel appears in the public NEØ hotel list, which customer services it offers, and which entrances are open.",
      },
      { property: "og:title", content: "Public experience — Configuration Centre" },
      {
        property: "og:description",
        content: "Control the public front door for one property, and copy its public links.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PublicExperiencePage,
});

/** Customer services a hotel may expose on its public page. */
const serviceFields: { key: string; label: string; hint: string }[] = [
  { key: "hotel_information", label: "Hotel information", hint: "About, facilities and contact." },
  { key: "rooms", label: "Rooms", hint: "Show room types and rates." },
  { key: "booking", label: "Room booking", hint: "Let customers request or make a reservation." },
  { key: "menu", label: "Digital menu", hint: "Show the restaurant menu." },
  { key: "food_ordering", label: "Food ordering", hint: "Accept customer food orders." },
  { key: "pickup", label: "Pickup", hint: "Customers collect their own order." },
  { key: "delivery", label: "Delivery", hint: "Deliver orders to the customer." },
  { key: "room_service", label: "Room service", hint: "Ordering for guests staying in a room." },
  { key: "laundry_resident", label: "Laundry — resident guests", hint: "Charge to the room." },
  { key: "laundry_public", label: "Laundry — public customers", hint: "No stay required." },
  { key: "laundry_collection", label: "Laundry — collection", hint: "You collect laundry from the customer." },
  { key: "laundry_delivery", label: "Laundry — delivery back", hint: "You return laundry to the customer." },

  { key: "guest_requests", label: "Guest requests", hint: "Requests routed to your departments." },
  { key: "feedback", label: "Feedback", hint: "Let customers leave feedback." },
];

const doorFields: { key: string; label: string; hint: string }[] = [
  { key: "stay_dine", label: "Stay & Dine", hint: "The customer entrance." },
  { key: "work", label: "Work", hint: "The staff entrance for this property." },
  { key: "partner", label: "Partner", hint: "Suppliers, corporate clients and other businesses." },
  { key: "rider", label: "Rider", hint: "The delivery rider field app." },
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
  services: Record<string, boolean>;
  doors: Record<string, boolean>;
};

function PublicExperiencePage() {
  const { can, organizationId } = useAuth();
  const canEdit = can("administration", "workspace", "edit");
  const branches = useBranches();
  const queryClient = useQueryClient();
  const [branchId, setBranchId] = useState<string | null>(null);

  useEffect(() => {
    if (!branchId && branches.data?.length) setBranchId(branches.data[0]!.id);
  }, [branches.data, branchId]);

  const branch = useMemo(
    () => branches.data?.find((b) => b.id === branchId) ?? null,
    [branches.data, branchId],
  );

  const config = useQuery({
    queryKey: ["neo-public-experience", branchId],
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

  useEffect(() => {
    if (!branch) return;
    const row = config.data;
    setDraft(
      row ?? {
        id: "",
        organization_id: organizationId ?? "",
        branch_id: branch.id,
        public_slug: slugify(branch.name),
        discoverable: false,
        display_name: branch.name,
        tagline: null,
        summary: null,
        cover_image_url: null,
        services: {},
        doors: { stay_dine: true, work: true, partner: true, rider: true },
      },
    );
  }, [config.data, branch, organizationId]);

  const save = useMutation({
    mutationFn: async (row: ExperienceRow) => {
      const payload = {
        organization_id: organizationId,
        branch_id: row.branch_id,
        public_slug: slugify(row.public_slug || row.display_name || "hotel"),
        discoverable: row.discoverable,
        display_name: row.display_name,
        tagline: row.tagline,
        summary: row.summary,
        cover_image_url: row.cover_image_url,
        services: row.services,
        doors: row.doors,
      };
      const { error } = await supabase
        .from("neo_public_experience" as never)
        .upsert(payload as never, { onConflict: "branch_id" });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Public experience saved");
      void queryClient.invalidateQueries({ queryKey: ["neo-public-experience", branchId] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const slug = draft ? slugify(draft.public_slug || draft.display_name || "hotel") : "";
  const links = slug
    ? [
        { label: "Hotel front door", url: `${origin}/start/${slug}` },
        { label: "Stay & Dine", url: `${origin}/guest/${slug}` },
        { label: "Order food / delivery", url: `${origin}/delivery/${slug}` },
        { label: "Partner portal", url: `${origin}/partner/${slug}` },
        { label: "Rider app", url: `${origin}/rider` },
      ]
    : [];

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        eyebrow="Customer experience"
        title="Public experience"
        description="Each property decides for itself whether it appears in the public NEØ hotel list, which customer services it offers, and which of the four entrances are open. Nothing here changes who is allowed through an entrance — that always comes from a person's real relationship with the hotel."
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
              className={`rounded-full border px-4 py-1.5 text-xs font-medium ${
                b.id === branchId
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground"
              }`}
            >
              {b.name}
            </button>
          ))}
        </div>
      ) : null}

      {draft ? (
        <div className="space-y-4">
          <SectionCard title="Public listing" description="How this hotel appears on the NEØ front door.">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="flex items-start gap-3">
                <Switch
                  checked={draft.discoverable}
                  disabled={!canEdit}
                  onCheckedChange={(v) => setDraft({ ...draft, discoverable: v })}
                />
                <span>
                  <span className="block text-sm font-medium">List this hotel publicly</span>
                  <span className="block text-xs text-muted-foreground">
                    When off, the hotel is still reachable by its own link but never appears in the
                    public hotel list.
                  </span>
                </span>
              </label>

              <div className="space-y-1.5">
                <Label htmlFor="public-slug">Public address</Label>
                <Input
                  id="public-slug"
                  value={draft.public_slug}
                  disabled={!canEdit}
                  onChange={(e) => setDraft({ ...draft, public_slug: e.target.value })}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="display-name">Name shown to customers</Label>
                <Input
                  id="display-name"
                  value={draft.display_name ?? ""}
                  disabled={!canEdit}
                  onChange={(e) => setDraft({ ...draft, display_name: e.target.value })}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="tagline">Tagline</Label>
                <Input
                  id="tagline"
                  value={draft.tagline ?? ""}
                  disabled={!canEdit}
                  onChange={(e) => setDraft({ ...draft, tagline: e.target.value })}
                />
              </div>

              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="summary">Short description</Label>
                <Textarea
                  id="summary"
                  rows={3}
                  value={draft.summary ?? ""}
                  disabled={!canEdit}
                  onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
                />
              </div>
            </div>
          </SectionCard>

          <SectionCard
            title="Customer services"
            description="Only the services you switch on are offered to customers."
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {serviceFields.map((field) => (
                <label key={field.key} className="flex items-start gap-3">
                  <Switch
                    checked={Boolean(draft.services?.[field.key])}
                    disabled={!canEdit}
                    onCheckedChange={(v) =>
                      setDraft({ ...draft, services: { ...draft.services, [field.key]: v } })
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

          <SectionCard
            title="Entrances"
            description="Which of the four entrances appear for this property. Switching one on never grants anyone access to it."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {doorFields.map((field) => (
                <label key={field.key} className="flex items-start gap-3">
                  <Switch
                    checked={draft.doors?.[field.key] !== false}
                    disabled={!canEdit}
                    onCheckedChange={(v) =>
                      setDraft({ ...draft, doors: { ...draft.doors, [field.key]: v } })
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

          <SectionCard
            title="Public links"
            description="Put these behind the buttons on your own website, or turn them into QR codes."
          >
            <ul className="space-y-2">
              {links.map((link) => (
                <li key={link.label} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="w-44 shrink-0 text-muted-foreground">{link.label}</span>
                  <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
                    {link.url}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void navigator.clipboard.writeText(link.url);
                      toast.success("Link copied");
                    }}
                  >
                    <Copy className="size-3.5" /> Copy
                  </Button>
                </li>
              ))}
            </ul>
          </SectionCard>

          {canEdit ? (
            <div className="flex justify-end">
              <Button onClick={() => save.mutate(draft)} disabled={save.isPending}>
                {save.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                Save public experience
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              You can view this configuration but not change it.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
