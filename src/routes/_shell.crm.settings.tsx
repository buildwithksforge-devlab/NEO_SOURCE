import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import { toast } from "sonner";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { CUSTOMER_TYPES, PREFERENCE_CATEGORIES, titleCase } from "@/lib/crm";

export const Route = createFileRoute("/_shell/crm/settings")({
  head: () => ({
    meta: [
      { title: "CRM Settings — Guest CRM" },
      {
        name: "description",
        content:
          "Configure guest data retention, consent wording, complaint response targets and portal visibility for the CRM module.",
      },
      { property: "og:title", content: "CRM Settings — Guest CRM" },
      { property: "og:description", content: "Configurable CRM policies and privacy controls." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type CrmSettings = {
  retentionMonths: number;
  complaintResponseHours: number;
  complaintResolutionHours: number;
  requireConsentForMarketing: boolean;
  maskIdentityDocuments: boolean;
  portalShowsLoyalty: boolean;
  portalShowsFeedback: boolean;
  consentWording: string;
};

const DEFAULTS: CrmSettings = {
  retentionMonths: 84,
  complaintResponseHours: 4,
  complaintResolutionHours: 48,
  requireConsentForMarketing: true,
  maskIdentityDocuments: true,
  portalShowsLoyalty: true,
  portalShowsFeedback: true,
  consentWording:
    "I agree to receive service messages about my stay. Marketing messages are optional and I can withdraw consent at any time.",
};

function Page() {
  const { profile, user, isAdmin, can } = useAuth();
  const [settings, setSettings] = useState<CrmSettings>(DEFAULTS);
  const [rowId, setRowId] = useState<string | null>(null);
  const [existing, setExisting] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);

  const canEdit = can("administration", "edit");

  useEffect(() => {
    if (!profile?.organization_id) return;
    void (async () => {
      const { data } = await supabase
        .from("system_settings")
        .select("id, settings")
        .eq("organization_id", profile.organization_id)
        .maybeSingle();
      if (!data) return;
      setRowId(data.id);
      const all = (data.settings ?? {}) as Record<string, unknown>;
      setExisting(all);
      const crm = (all["crm"] ?? {}) as Partial<CrmSettings>;
      setSettings({ ...DEFAULTS, ...crm });
    })();
  }, [profile?.organization_id]);

  async function save() {
    if (!profile?.organization_id) return;
    setSaving(true);
    const next = { ...existing, crm: settings };
    const { error } = rowId
      ? await supabase.from("system_settings").update({ settings: next }).eq("id", rowId)
      : await supabase
          .from("system_settings")
          .insert({ organization_id: profile.organization_id, settings: next });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setExisting(next);
    await logAudit({
      organizationId: profile.organization_id,
      userId: user?.id ?? null,
      userName: profile.full_name,
      action: "crm.settings.update",
      module: "administration",
      newValue: settings as unknown as Record<string, unknown>,
    });
    toast.success("CRM settings saved");
  }

  return (
    <div>
      <PageHeader
        eyebrow="Guest CRM"
        title="CRM Settings"
        description="Every CRM rule is configurable per organisation — nothing is hard-coded into the product."
        actions={
          <Button onClick={save} disabled={!canEdit || saving}>
            {saving ? "Saving…" : "Save settings"}
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard
          title="Service level targets"
          description="Used for complaint due dates and dashboards"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>First response target (hours)</Label>
              <Input
                type="number"
                value={settings.complaintResponseHours}
                onChange={(e) =>
                  setSettings({ ...settings, complaintResponseHours: Number(e.target.value) })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>Resolution target (hours)</Label>
              <Input
                type="number"
                value={settings.complaintResolutionHours}
                onChange={(e) =>
                  setSettings({ ...settings, complaintResolutionHours: Number(e.target.value) })
                }
              />
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Privacy & data protection">
          <div className="space-y-3 text-sm">
            <div className="space-y-1.5">
              <Label>Guest data retention (months)</Label>
              <Input
                type="number"
                value={settings.retentionMonths}
                onChange={(e) =>
                  setSettings({ ...settings, retentionMonths: Number(e.target.value) })
                }
              />
            </div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.maskIdentityDocuments}
                onChange={(e) =>
                  setSettings({ ...settings, maskIdentityDocuments: e.target.checked })
                }
              />
              Mask identity document numbers unless the viewer holds the identity permission
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.requireConsentForMarketing}
                onChange={(e) =>
                  setSettings({ ...settings, requireConsentForMarketing: e.target.checked })
                }
              />
              Block marketing messages without recorded consent
            </label>
          </div>
        </SectionCard>

        <SectionCard
          title="Consent wording"
          description="Shown at registration and in the guest portal"
        >
          <Textarea
            rows={4}
            value={settings.consentWording}
            onChange={(e) => setSettings({ ...settings, consentWording: e.target.value })}
          />
        </SectionCard>

        <SectionCard title="Guest portal visibility">
          <div className="space-y-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.portalShowsLoyalty}
                onChange={(e) => setSettings({ ...settings, portalShowsLoyalty: e.target.checked })}
              />
              Show loyalty balance and history to guests
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.portalShowsFeedback}
                onChange={(e) =>
                  setSettings({ ...settings, portalShowsFeedback: e.target.checked })
                }
              />
              Allow guests to submit and track feedback
            </label>
            <p className="text-xs text-muted-foreground">
              Internal notes, VIP notes and staff-only timeline entries are never visible to guests,
              regardless of these settings.
            </p>
          </div>
        </SectionCard>

        <SectionCard title="Customer types" description="Reference list used across the CRM">
          <div className="flex flex-wrap gap-2 text-xs">
            {CUSTOMER_TYPES.map((t) => (
              <span key={t} className="rounded-full border border-border px-3 py-1">
                {titleCase(t)}
              </span>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Preference categories" description="Captured on every guest profile">
          <div className="flex flex-wrap gap-2 text-xs">
            {Object.keys(PREFERENCE_CATEGORIES).map((k) => (
              <span key={k} className="rounded-full border border-border px-3 py-1">
                {titleCase(k)}
              </span>
            ))}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

// Money and customer records: the screen asks for the capability its route
// declares, so the menu and the page can never disagree.
function GuardedPage() {
  return (
    <OpsGuard path="/crm/settings">
      <Page />
    </OpsGuard>
  );
}
