import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PosGuard } from "@/components/pos/PosShared";
import { DEFAULT_POS_SETTINGS, type PosSettings } from "@/lib/pos";
import { usePosSettings, useSavePosSettings } from "@/lib/pos-data";

export const Route = createFileRoute("/_shell/pos/settings")({
  head: () => ({
    meta: [
      { title: "POS Settings — NEØ" },
      {
        name: "description",
        content:
          "Service charge, tax and receipt rules, with links to central printer configuration and verified integration readiness.",
      },
      { property: "og:title", content: "POS Settings — NEØ" },
      {
        property: "og:description",
        content:
          "Service charge, tax and receipt rules, with links to central printer configuration and verified integration readiness.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PosGuard action="settings.manage" path="/pos/settings">
      <SettingsPage />
    </PosGuard>
  ),
});

function SettingsPage() {
  const query = usePosSettings();
  const save = useSavePosSettings();
  const [form, setForm] = useState<PosSettings>(DEFAULT_POS_SETTINGS);
  useEffect(() => {
    if (query.data) setForm(query.data.settings);
  }, [query.data]);

  return (
    <div>
      <PageHeader
        eyebrow="Restaurant & POS"
        title="POS Settings"
        description="Trading rules applied to every bill, plus the honest connection state of each integration."
        actions={
          <Button
            disabled={save.isPending}
            onClick={() => save.mutate({ id: query.data?.id ?? null, settings: form })}
          >
            Save settings
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Charges & tax" description="Applied when an order is recalculated.">
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="sc">Service charge %</Label>
              <Input
                id="sc"
                inputMode="decimal"
                value={String(form.serviceChargePercent)}
                onChange={(e) =>
                  setForm({ ...form, serviceChargePercent: Number(e.target.value) || 0 })
                }
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="tax">Default tax rate %</Label>
              <Input
                id="tax"
                inputMode="decimal"
                value={String(form.defaultTaxPercent)}
                onChange={(e) =>
                  setForm({ ...form, defaultTaxPercent: Number(e.target.value) || 0 })
                }
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="shift">Require an open shift before taking cash</Label>
              <Switch
                id="shift"
                checked={form.enforceShift}
                onCheckedChange={(v) => setForm({ ...form, enforceShift: v })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="footer">Receipt footer</Label>
              <Input
                id="footer"
                value={form.receiptFooter}
                onChange={(e) => setForm({ ...form, receiptFooter: e.target.value })}
              />
            </div>
          </div>
        </SectionCard>

        <SectionCard
          title="Integration readiness"
          description="View saved provider configuration and verified results in the Integration Centre."
        >
          <p className="mb-3 text-sm text-muted-foreground">
            A configured module or saved provider name does not prove a payment callback, guest
            folio posting or live station connection. Review its recorded evidence before treating
            it as ready.
          </p>
          <Button variant="outline" asChild>
            <Link to="/platform/integrations">Review integration readiness</Link>
          </Button>
        </SectionCard>
      </div>

      <SectionCard
        className="mt-6"
        title="Printer configuration"
        description="Printer discovery, property/station assignments and the print queue are managed in the Configuration Centre."
      >
        <Button variant="outline" asChild>
          <Link to="/admin/printers">Open printer configuration</Link>
        </Button>
      </SectionCard>
    </div>
  );
}
