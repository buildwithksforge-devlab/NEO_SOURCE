import { useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { PieChart, Plus } from "lucide-react";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, MetricTile } from "@/components/marketing/MarketingShared";
import {
  useAddMarketingCost,
  useAttributionEvents,
  useCampaigns,
  useConversions,
  useMarketingCosts,
} from "@/lib/marketing-data";
import {
  ATTRIBUTION_MODELS,
  COST_TYPES,
  calculateRomi,
  formatDate,
  titleCase,
} from "@/lib/marketing";
import { useAuth } from "@/lib/auth";
import { NeoDatePicker } from "@/components/common/DatePicker";

export const Route = createFileRoute("/_shell/marketing/reports")({
  head: () => ({
    meta: [
      { title: "Campaign Reports — Marketing & CRM" },
      {
        name: "description",
        content:
          "Attributed revenue, campaign costs and return, reconciled against posted finance records.",
      },
      { property: "og:title", content: "Campaign Reports — Marketing & CRM" },
      {
        property: "og:description",
        content: "Campaign attribution, costs and revenue-based return.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type Row = Record<string, any>;

function Page() {
  const { can } = useAuth();
  const [model, setModel] = useState<string>(String(ATTRIBUTION_MODELS[0]?.value ?? "last_touch"));
  const [campaignId, setCampaignId] = useState<string>("all");
  const { data: campaigns } = useCampaigns();
  const { data: costs } = useMarketingCosts(campaignId === "all" ? undefined : campaignId);
  const { data: conversions } = useConversions(campaignId === "all" ? undefined : campaignId);
  const { data: attribution } = useAttributionEvents();
  const addCost = useAddMarketingCost();

  const [costForm, setCostForm] = useState<Row>({ cost_type: "media", amount: 0 });
  const setCost = (k: string, v: unknown) => setCostForm((f) => ({ ...f, [k]: v }));

  const totalCost = ((costs ?? []) as Row[]).reduce((s, c) => s + Number(c["amount"] ?? 0), 0);
  const totalRevenue = ((conversions ?? []) as Row[]).reduce(
    (s, c) => s + Number(c["revenue_amount"] ?? c["value"] ?? 0),
    0,
  );
  const romi = calculateRomi({ cost: totalCost, revenue: totalRevenue });

  return (
    <div>
      <PageHeader
        eyebrow="Marketing & CRM"
        title="Campaign Reports"
        description="Revenue is only attributed when a recorded booking, order or event references a campaign, voucher or tracked link. Nothing is estimated, and figures reconcile to posted finance records."
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <Select value={campaignId} onValueChange={setCampaignId}>
          <SelectTrigger className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All campaigns</SelectItem>
            {((campaigns ?? []) as Row[]).map((c) => (
              <SelectItem key={String(c["id"])} value={String(c["id"])}>
                {String(c["name"])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={model} onValueChange={setModel}>
          <SelectTrigger className="w-56">
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

      <div className="grid gap-3 sm:grid-cols-4">
        <MetricTile label="Recorded cost" value={totalCost.toLocaleString()} />
        <MetricTile label="Attributed revenue" value={totalRevenue.toLocaleString()} />
        <MetricTile
          label="Conversions"
          value={String((conversions ?? []).length)}
          hint={`Attribution model: ${titleCase(model)}`}
        />
        <MetricTile
          label="Revenue-based return"
          value={romi.ratio == null ? "—" : `${(romi.ratio * 100).toFixed(1)}%`}
          hint={romi.label}
          tone={romi.ratio != null && romi.ratio > 0 ? "success" : "default"}
        />
      </div>

      <SectionCard
        className="mt-6"
        title="Conversions"
        description="Each conversion links back to a recorded transaction."
      >
        {!conversions?.length ? (
          <EmptyState
            icon={PieChart}
            title="No attributed conversions"
            description="A conversion is recorded when a booking or order references a campaign, voucher or tracked link."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Occurred</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {((conversions ?? []) as Row[]).map((c) => (
                  <TableRow key={String(c["id"])}>
                    <TableCell>{c["campaigns"]?.name ?? "—"}</TableCell>
                    <TableCell>{c["customers"]?.full_name ?? "—"}</TableCell>
                    <TableCell>{titleCase(String(c["conversion_type"] ?? ""))}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(c["occurred_at"])}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(c["revenue_amount"] ?? c["value"] ?? 0).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <SectionCard
          title="Marketing costs"
          description="Recorded spend used in the return calculation."
        >
          {!costs?.length ? (
            <p className="text-sm text-muted-foreground">No costs recorded.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {((costs ?? []) as Row[]).map((c) => (
                <li
                  key={String(c["id"])}
                  className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
                >
                  <span>
                    {titleCase(String(c["cost_type"]))}
                    {c["campaigns"]?.name ? ` · ${String(c["campaigns"].name)}` : ""}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {Number(c["amount"] ?? 0).toLocaleString()} · {formatDate(c["incurred_on"])}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {can("marketing", "create") ? (
            <div className="mt-4 grid gap-2 rounded-lg border border-dashed border-border p-3 sm:grid-cols-4">
              <Select
                value={String(costForm["cost_type"])}
                onValueChange={(v) => setCost("cost_type", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COST_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {titleCase(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="number"
                min={0}
                step="0.01"
                placeholder="Amount"
                onChange={(e) => setCost("amount", Number(e.target.value || 0))}
              />
              <NeoDatePicker value="" onChange={(v) => setCost("incurred_on", v)} />
              <Button
                onClick={() =>
                  addCost.mutate({
                    ...costForm,
                    campaign_id: campaignId === "all" ? null : campaignId,
                  })
                }
              >
                <Plus className="mr-1.5 size-4" /> Add cost
              </Button>
              <div className="sm:col-span-4">
                <Label className="text-xs text-muted-foreground">
                  Costs post against the finance module as marketing expenditure for reconciliation.
                </Label>
              </div>
            </div>
          ) : null}
        </SectionCard>

        <SectionCard
          title="Attribution events"
          description="Tracked touchpoints preceding a conversion."
        >
          {!attribution?.length ? (
            <p className="text-sm text-muted-foreground">No attribution events recorded.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {((attribution ?? []) as Row[]).slice(0, 25).map((a) => (
                <li
                  key={String(a["id"])}
                  className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
                >
                  <span>{a["campaigns"]?.name ?? titleCase(String(a["source"] ?? "direct"))}</span>
                  <span className="text-xs text-muted-foreground">
                    {titleCase(String(a["event_type"] ?? "touch"))} · {formatDate(a["occurred_at"])}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/marketing/reports">
      <Page />
    </OpsGuard>
  );
}
