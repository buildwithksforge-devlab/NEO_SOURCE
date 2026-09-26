import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Eye, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { BrandPreview } from "@/components/admin/BrandPreview";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { ColorField, FieldGrid, ImageUploadField } from "@/components/common/FormFields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTenant } from "@/lib/tenant";
import { defaultTenantState } from "@/lib/tenant-defaults";
import { fontOptions, type FontKey, type ThemePreference } from "@/lib/tenant-types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/brand-identity")({
  head: () => ({
    meta: [
      { title: "Brand Identity — System Administration" },
      {
        name: "description",
        content:
          "Configure brand colours, logos, favicon, fonts and theme preference with a live preview of the branded dashboard.",
      },
      { property: "og:title", content: "Brand Identity — System Administration" },
      { property: "og:description", content: "White-label colours, logos and typography." },
    ],
  }),
  component: BrandIdentityPage,
});

function BrandIdentityPage() {
  const { tenant, updateBrand } = useTenant();
  const [draft, setDraft] = useState(tenant.brand);
  const dirty = JSON.stringify(draft) !== JSON.stringify(tenant.brand);

  const patch = (p: Partial<typeof draft>) => setDraft({ ...draft, ...p });

  return (
    <div>
      <PageHeader
        eyebrow="Branding"
        title="Brand Identity"
        description="Every colour here is written to design tokens, so one change re-skins the whole platform."
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(defaultTenantState().brand);
                toast("Reset to default palette — save to apply");
              }}
            >
              <RotateCcw className="size-4" />
              Reset
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                updateBrand(draft);
                toast("Previewing unsaved brand across the app");
              }}
            >
              <Eye className="size-4" />
              Preview
            </Button>
            <Button
              disabled={!dirty}
              onClick={() => {
                updateBrand(draft);
                toast("Changes applied — NEØ is saving them automatically");
              }}
            >
              <Save className="size-4" />
              Apply Changes
            </Button>
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <SectionCard title="Colour system" description="Mapped to primary, secondary and accent tokens">
            <FieldGrid cols={2}>
              <ColorField
                label="Primary brand colour"
                value={draft.primary}
                onChange={(v) => patch({ primary: v })}
                hint="Buttons, links, active navigation"
              />
              <ColorField
                label="Secondary colour"
                value={draft.secondary}
                onChange={(v) => patch({ secondary: v })}
                hint="Surfaces and subtle fills"
              />
              <ColorField
                label="Accent colour"
                value={draft.accent}
                onChange={(v) => patch({ accent: v })}
                hint="Highlights and badges"
              />
              <ColorField
                label="Background colour"
                value={draft.background}
                onChange={(v) => patch({ background: v })}
                hint="Light screen background"
              />
              <ColorField
                label="Text colour"
                value={draft.foreground}
                onChange={(v) => patch({ foreground: v })}
              />
              <div className="space-y-2">
                <Label>Logo initials</Label>
                <Input
                  maxLength={3}
                  value={draft.logoText}
                  onChange={(e) => patch({ logoText: e.target.value.toUpperCase() })}
                />
              </div>
            </FieldGrid>
          </SectionCard>

          <SectionCard title="Logos & imagery" description="Uploads are stored per organization">
            <FieldGrid cols={3}>
              <ImageUploadField
                label="Light logo"
                value={draft.logoLight}
                onChange={(v) => patch({ logoLight: v })}
                aspect="wide"
              />
              <ImageUploadField
                label="Dark logo"
                value={draft.logoDark}
                onChange={(v) => patch({ logoDark: v })}
                aspect="wide"
              />
              <ImageUploadField
                label="Favicon"
                value={draft.favicon}
                onChange={(v) => patch({ favicon: v })}
              />
              <ImageUploadField
                label="Dashboard banner"
                value={draft.dashboardBanner}
                onChange={(v) => patch({ dashboardBanner: v })}
                aspect="wide"
              />
              <ImageUploadField
                label="Mobile app splash"
                value={draft.splashImage}
                onChange={(v) => patch({ splashImage: v })}
                aspect="tall"
              />
            </FieldGrid>
          </SectionCard>

          <SectionCard title="Typography & theme" description="Font family and default appearance">
            <div className="space-y-2">
              <Label>Font selection</Label>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {fontOptions.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => patch({ fontKey: f.key as FontKey })}
                    className={cn(
                      "rounded-xl border p-3 text-left transition-colors",
                      draft.fontKey === f.key
                        ? "border-primary bg-primary-soft"
                        : "border-border hover:bg-muted",
                    )}
                  >
                    <span className="block text-sm font-semibold" style={{ fontFamily: f.stack }}>
                      {f.label}
                    </span>
                    <span className="block text-xs text-muted-foreground">{f.note}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-5 space-y-2">
              <Label>Theme preference</Label>
              <div className="flex flex-wrap gap-2">
                {(["light", "dark", "system"] as ThemePreference[]).map((t) => (
                  <Button
                    key={t}
                    type="button"
                    variant={draft.theme === t ? "default" : "outline"}
                    onClick={() => patch({ theme: t })}
                    className="capitalize"
                  >
                    {t}
                  </Button>
                ))}
              </div>
            </div>
          </SectionCard>
        </div>

        <div className="xl:sticky xl:top-24 xl:h-fit">
          <SectionCard title="Live preview" description="How the branded dashboard will look">
            <BrandPreview
              brand={draft}
              businessName={tenant.organization.name}
              branchName={tenant.branches[0]?.name || "All Properties"}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              {dirty ? "Unsaved changes — press Save Changes to apply." : "All changes saved."}
            </p>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
