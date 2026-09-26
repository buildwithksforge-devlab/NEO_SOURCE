import { useEffect, useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ProviderBadge } from "@/components/marketing/MarketingShared";
import { useMarketingSettings, useSaveMarketingSettings } from "@/lib/marketing-data";
import { ATTRIBUTION_MODELS, CLV_METHODS, providerStatusLabels, titleCase } from "@/lib/marketing";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/_shell/marketing/settings")({
  head: () => ({
    meta: [
      { title: "Marketing Settings — Marketing & CRM" },
      {
        name: "description",
        content:
          "Frequency caps, quiet hours, attribution window, lifetime value method and channel provider status.",
      },
      { property: "og:title", content: "Marketing Settings — Marketing & CRM" },
      {
        property: "og:description",
        content: "Sending guardrails, attribution and provider configuration.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type Row = Record<string, any>;
const CHANNELS = ["email", "sms", "whatsapp", "push"];

function Page() {
  const { can } = useAuth();
  const { data } = useMarketingSettings();
  const save = useSaveMarketingSettings();
  const [form, setForm] = useState<Row>({});

  useEffect(() => {
    if (data) setForm(data as Row);
  }, [data]);

  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  const editable = can("marketing", "edit");

  return (
    <div>
      <PageHeader
        eyebrow="Marketing & CRM"
        title="Marketing Settings"
        description="These guardrails are enforced server-side on every send. Changing them affects future audience freezes only; campaigns already frozen keep the rules that applied at the time."
        actions={
          editable ? (
            <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(form)}>
              {save.isPending ? "Saving…" : "Save settings"}
            </Button>
          ) : null
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard
          title="Sending guardrails"
          description="Applied to marketing messages only — never to transactional ones."
        >
          <div className="space-y-4">
            <div>
              <Label>Maximum marketing messages per customer per week</Label>
              <Input
                type="number"
                min={0}
                disabled={!editable}
                value={String(form["frequency_cap_per_week"] ?? 2)}
                onChange={(e) => set("frequency_cap_per_week", Number(e.target.value || 0))}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Quiet hours start</Label>
                <Input
                  type="time"
                  disabled={!editable}
                  value={String(form["quiet_hours_start"] ?? "21:00")}
                  onChange={(e) => set("quiet_hours_start", e.target.value)}
                />
              </div>
              <div>
                <Label>Quiet hours end</Label>
                <Input
                  type="time"
                  disabled={!editable}
                  value={String(form["quiet_hours_end"] ?? "07:00")}
                  onChange={(e) => set("quiet_hours_end", e.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
              <div>
                <Label>Require approval before every launch</Label>
                <p className="text-xs text-muted-foreground">
                  Recommended. Disabling still records who launched each campaign.
                </p>
              </div>
              <Switch
                disabled={!editable}
                checked={form["require_campaign_approval"] !== false}
                onCheckedChange={(v) => set("require_campaign_approval", v)}
              />
            </div>
            <div>
              <Label>Compensation value requiring approval</Label>
              <Input
                type="number"
                min={0}
                disabled={!editable}
                value={String(form["compensation_approval_threshold"] ?? 0)}
                onChange={(e) =>
                  set("compensation_approval_threshold", Number(e.target.value || 0))
                }
              />
            </div>
          </div>
        </SectionCard>

        <SectionCard
          title="Measurement"
          description="How revenue is credited and lifetime value is calculated."
        >
          <div className="space-y-4">
            <div>
              <Label>Attribution model</Label>
              <Select
                disabled={!editable}
                value={String(form["attribution_model"] ?? ATTRIBUTION_MODELS[0]?.value)}
                onValueChange={(v) => set("attribution_model", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ATTRIBUTION_MODELS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Attribution window (days)</Label>
              <Input
                type="number"
                min={1}
                disabled={!editable}
                value={String(form["attribution_window_days"] ?? 30)}
                onChange={(e) => set("attribution_window_days", Number(e.target.value || 1))}
              />
            </div>
            <div>
              <Label>Customer lifetime value method</Label>
              <Select
                disabled={!editable}
                value={String(form["clv_method"] ?? CLV_METHODS[0]?.value)}
                onValueChange={(v) => set("clv_method", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLV_METHODS.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">
                Historic value uses posted revenue only. Predictive value is clearly labelled as an
                estimate wherever it appears.
              </p>
            </div>
          </div>
        </SectionCard>
      </div>

      <SectionCard
        className="mt-6"
        title="Channel providers"
        description="Delivery is only reported for configured providers. Unconfigured channels report nothing rather than assuming success."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {CHANNELS.map((c) => (
            <div key={c} className="rounded-lg border border-border p-3">
              <p className="text-sm font-medium text-foreground">{titleCase(c)}</p>
              <div className="mt-2">
                <ProviderBadge
                  label={
                    providerStatusLabels[
                      String(
                        form[`${c}_status`] ?? "not_configured",
                      ) as keyof typeof providerStatusLabels
                    ] ?? "Not configured"
                  }
                  status={String(form[`${c}_status`] ?? "not_configured")}
                />
              </div>
              {editable ? (
                <Select
                  value={String(form[`${c}_status`] ?? "not_configured")}
                  onValueChange={(v) => set(`${c}_status`, v)}
                >
                  <SelectTrigger className="mt-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(providerStatusLabels).map(([k, label]) => (
                      <SelectItem key={k} value={k}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/marketing/settings">
      <Page />
    </OpsGuard>
  );
}
