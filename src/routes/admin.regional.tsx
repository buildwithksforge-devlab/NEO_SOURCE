import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { FieldGrid } from "@/components/common/FormFields";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTenant } from "@/lib/tenant";

export const Route = createFileRoute("/admin/regional")({
  head: () => ({
    meta: [
      { title: "Regional Settings — System Administration" },
      {
        name: "description",
        content:
          "Country, currency, time zone, language, formats and tax rules configured per hospitality organization.",
      },
      { property: "og:title", content: "Regional Settings — System Administration" },
      { property: "og:description", content: "Locale and tax configuration for your organization." },
    ],
  }),
  component: RegionalPage,
});

function RegionalPage() {
  const { tenant, updateRegional } = useTenant();
  const r = tenant.regional;

  const sample = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2 }).format(1234.56);

  return (
    <div>
      <PageHeader
        eyebrow="Business setup"
        title="Regional Settings"
        description="Nothing is hardcoded to a single country — every hospitality organization sets its own locale and tax rules."
        actions={
          <div className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800">
            Changes save automatically
          </div>
        }
      />

      <div className="space-y-6">
        <SectionCard title="Locale" description="Country, currency and formatting">
          <FieldGrid cols={3}>
            <div className="space-y-2">
              <Label>Country</Label>
              <Input value={r.country} onChange={(e) => updateRegional({ country: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Currency code</Label>
              <Input value={r.currency} onChange={(e) => updateRegional({ currency: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Currency symbol</Label>
              <Input
                value={r.currencySymbol}
                onChange={(e) => updateRegional({ currencySymbol: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Time zone</Label>
              <Input value={r.timezone} onChange={(e) => updateRegional({ timezone: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Language</Label>
              <Select value={r.language} onValueChange={(v) => updateRegional({ language: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="sw">Kiswahili</SelectItem>
                  <SelectItem value="fr">French</SelectItem>
                  <SelectItem value="ar">Arabic</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Date format</Label>
              <Select value={r.dateFormat} onValueChange={(v) => updateRegional({ dateFormat: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DD/MM/YYYY">DD/MM/YYYY</SelectItem>
                  <SelectItem value="MM/DD/YYYY">MM/DD/YYYY</SelectItem>
                  <SelectItem value="YYYY-MM-DD">YYYY-MM-DD</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Time format</Label>
              <Select
                value={r.timeFormat}
                onValueChange={(v) => updateRegional({ timeFormat: v as "12h" | "24h" })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="24h">24-hour</SelectItem>
                  <SelectItem value="12h">12-hour</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Number formatting</Label>
              <Select
                value={r.numberFormat}
                onValueChange={(v) => updateRegional({ numberFormat: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1,234.56">1,234.56</SelectItem>
                  <SelectItem value="1.234,56">1.234,56</SelectItem>
                  <SelectItem value="1 234.56">1 234.56</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </FieldGrid>

          <div className="mt-5 rounded-xl border border-border bg-muted/40 p-4 text-sm">
            <p className="font-medium">Preview</p>
            <p className="mt-1 text-muted-foreground">
              {r.currencySymbol} {sample} · {r.dateFormat} · {r.timeFormat} · {r.timezone}
            </p>
          </div>
        </SectionCard>

        <SectionCard title="Tax rules" description="Statutory identifiers and rates">
          <FieldGrid cols={3}>
            <div className="space-y-2">
              <Label>Tax label</Label>
              <Input value={r.taxLabel} onChange={(e) => updateRegional({ taxLabel: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>{r.taxLabel} rate (%)</Label>
              <Input
                type="number"
                value={r.vatRate}
                onChange={(e) => updateRegional({ vatRate: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-2">
              <Label>Tax identifier label</Label>
              <Input
                value={r.taxIdLabel}
                onChange={(e) => updateRegional({ taxIdLabel: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>{r.taxIdLabel}</Label>
              <Input value={r.taxId} onChange={(e) => updateRegional({ taxId: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Business registration number</Label>
              <Input
                value={r.registrationNumber}
                onChange={(e) => updateRegional({ registrationNumber: e.target.value })}
              />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border p-3">
              <div>
                <p className="text-sm font-medium">Prices include tax</p>
                <p className="text-xs text-muted-foreground">Affects rates and menus</p>
              </div>
              <Switch
                checked={r.pricesIncludeTax}
                onCheckedChange={(v) => updateRegional({ pricesIncludeTax: v })}
              />
            </div>
            <div className="space-y-2 sm:col-span-2 xl:col-span-3">
              <Label>Registration details</Label>
              <Textarea
                rows={3}
                value={r.registrationDetails}
                onChange={(e) => updateRegional({ registrationDetails: e.target.value })}
              />
            </div>
          </FieldGrid>
        </SectionCard>
      </div>
    </div>
  );
}
