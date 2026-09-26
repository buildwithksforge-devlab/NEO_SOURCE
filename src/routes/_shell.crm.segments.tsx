import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { CUSTOMER_TYPES, titleCase, useCustomers, useSegments } from "@/lib/crm";
import { EmptyState, LoadingState } from "@/components/common/StateSystem";

export const Route = createFileRoute("/_shell/crm/segments")({
  head: () => ({
    meta: [
      { title: "Guest Segments — Guest CRM" },
      {
        name: "description",
        content:
          "Build rule-based guest segments for marketing and service, with consent-aware campaign eligibility counts.",
      },
      { property: "og:title", content: "Guest Segments — Guest CRM" },
      { property: "og:description", content: "Rule-based hospitality guest segmentation." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type Conditions = {
  customerType?: string;
  vipOnly?: boolean;
  marketingConsentOnly?: boolean;
  minLifetimeValue?: number;
};

function matches(
  customer: {
    customer_type: string;
    is_vip: boolean;
    marketing_consent: boolean;
    lifetime_value: number;
  },
  c: Conditions,
) {
  if (c.customerType && customer.customer_type !== c.customerType) return false;
  if (c.vipOnly && !customer.is_vip) return false;
  if (c.marketingConsentOnly && !customer.marketing_consent) return false;
  if (c.minLifetimeValue && Number(customer.lifetime_value ?? 0) < c.minLifetimeValue) return false;
  return true;
}

function Page() {
  const { profile, user, isAdmin, can } = useAuth();
  const segments = useSegments();
  const customers = useCustomers();
  const [form, setForm] = useState({
    name: "",
    description: "",
    customerType: "any",
    vipOnly: false,
    marketingConsentOnly: true,
    minLifetimeValue: "",
  });

  const canManage = can("crm-segments", "create");

  const draftConditions = useMemo<Conditions>(
    () => ({
      ...(form.customerType !== "any" ? { customerType: form.customerType } : {}),
      vipOnly: form.vipOnly,
      marketingConsentOnly: form.marketingConsentOnly,
      ...(form.minLifetimeValue ? { minLifetimeValue: Number(form.minLifetimeValue) } : {}),
    }),
    [form],
  );

  const rows = (customers.data ?? []) as unknown as {
    customer_type: string;
    is_vip: boolean;
    marketing_consent: boolean;
    lifetime_value: number;
  }[];
  const draftCount = rows.filter((c) => matches(c, draftConditions)).length;

  async function createSegment() {
    if (!profile?.organization_id || !form.name.trim()) return;
    const { error } = await supabase.from("customer_segments").insert({
      organization_id: profile.organization_id,
      name: form.name.trim(),
      description: form.description.trim(),
      rule_type: "dynamic",
      conditions: draftConditions,
      estimated_members: draftCount,
      last_calculated_at: new Date().toISOString(),
      campaign_eligible: form.marketingConsentOnly,
      owner_id: user?.id ?? null,
      created_by: user?.id ?? null,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    await logAudit({
      organizationId: profile.organization_id,
      userId: user?.id ?? null,
      userName: profile.full_name,
      action: "crm.segment.create",
      module: "crm-segments",
      newValue: { name: form.name.trim(), conditions: draftConditions },
    });
    setForm({ ...form, name: "", description: "" });
    void segments.refetch();
    toast.success("Segment saved");
  }

  async function recalc(id: string, conditions: Conditions) {
    const count = rows.filter((c) => matches(c, conditions)).length;
    await supabase
      .from("customer_segments")
      .update({ estimated_members: count, last_calculated_at: new Date().toISOString() })
      .eq("id", id);
    void segments.refetch();
    toast.success(`Segment recalculated — ${count} members`);
  }

  return (
    <div>
      <PageHeader
        eyebrow="Guest CRM"
        title="Segments"
        description="Segments are recalculated from live customer records. Campaign-eligible counts only ever include guests who gave marketing consent."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Segments" value={String(segments.data?.length ?? 0)} />
        <StatCard label="Customers in scope" value={String(rows.length)} />
        <StatCard label="Draft rule matches" value={String(draftCount)} />
      </div>

      <SectionCard title="Create a dynamic segment" className="mb-6">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Segment name</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Customer type</Label>
            <Select
              value={form.customerType}
              onValueChange={(v) => setForm({ ...form, customerType: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any type</SelectItem>
                {CUSTOMER_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {titleCase(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Minimum lifetime value</Label>
            <Input
              type="number"
              value={form.minLifetimeValue}
              onChange={(e) => setForm({ ...form, minLifetimeValue: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea
              rows={2}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.vipOnly}
              onChange={(e) => setForm({ ...form, vipOnly: e.target.checked })}
            />
            VIP guests only
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.marketingConsentOnly}
              onChange={(e) => setForm({ ...form, marketingConsentOnly: e.target.checked })}
            />
            Marketing consent given
          </label>
          <Button
            className="ml-auto"
            onClick={createSegment}
            disabled={!form.name.trim() || !canManage}
          >
            Save segment ({draftCount})
          </Button>
        </div>
      </SectionCard>

      <SectionCard title="Saved segments">
        {segments.isLoading ? (
          <LoadingState rows={2} />
        ) : !segments.data?.length ? (
          <EmptyState inline title="No segments yet" description="No customer segments have been saved yet." />
        ) : (
          <ul className="divide-y divide-border">
            {segments.data.map((s) => {
              const row = s as unknown as {
                id: string;
                name: string;
                description: string;
                estimated_members: number;
                campaign_eligible: boolean;
                conditions: Conditions;
                last_calculated_at: string | null;
              };
              return (
                <li
                  key={row.id}
                  className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="font-medium">{row.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.description || "No description"} ·{" "}
                      {row.last_calculated_at
                        ? `recalculated ${new Date(row.last_calculated_at).toLocaleString()}`
                        : "never recalculated"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusPill tone={row.campaign_eligible ? "success" : "warning"}>
                      {row.campaign_eligible ? "Campaign eligible" : "Service only"}
                    </StatusPill>
                    <StatusPill tone="info">{row.estimated_members} members</StatusPill>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => recalc(row.id, row.conditions ?? {})}
                    >
                      Recalculate
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

// Money and customer records: the screen asks for the capability its route
// declares, so the menu and the page can never disagree.
function GuardedPage() {
  return (
    <OpsGuard path="/crm/segments">
      <Page />
    </OpsGuard>
  );
}
