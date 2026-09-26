import { LoadingState } from "@/components/common/StateSystem";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { PieChart, ShieldAlert } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState } from "@/components/marketing/MarketingShared";
import { useSegments, useSegmentSnapshots } from "@/lib/marketing-data";
import {
  PROHIBITED_SEGMENT_ATTRIBUTES,
  SEGMENT_ATTRIBUTES,
  SEGMENT_TEMPLATES,
  formatDateTime,
  operatorLabels,
  type SegmentCondition,
  type SegmentRuleSet,
} from "@/lib/marketing";

export const Route = createFileRoute("/_shell/marketing/segments")({
  head: () => ({
    meta: [
      { title: "Customer Segments — Marketing & CRM" },
      {
        name: "description",
        content:
          "Dynamic audience segments built from recorded stay, spend, loyalty and consent attributes.",
      },
      { property: "og:title", content: "Customer Segments — Marketing & CRM" },
      {
        property: "og:description",
        content: "Rule-based audience segmentation with frozen campaign snapshots.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type Row = Record<string, any>;

function Page() {
  const { data: segments, isLoading } = useSegments();
  const { data: snapshots } = useSegmentSnapshots();

  return (
    <div>
      <PageHeader
        eyebrow="Marketing & CRM"
        title="Customer Segments"
        description="Segments are evaluated against the Phase 4 customer record. Membership counts refresh from recorded data; a campaign always sends to a frozen snapshot so the audience cannot drift mid-send."
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <SectionCard
          title="Segments"
          description="Defined audiences for this organization."
          className="lg:col-span-2"
        >
          {isLoading ? (
            <LoadingState variant="rows" rows={4} />
          ) : !segments?.length ? (
            <EmptyState
              icon={PieChart}
              title="No segments defined"
              description="Segments created in CRM Settings appear here. Start from one of the suggested definitions on the right."
            />
          ) : (
            <ul className="space-y-3">
              {(segments as Row[]).map((seg) => (
                <li key={String(seg["id"])} className="rounded-xl border border-border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-medium text-foreground">{String(seg["name"])}</p>
                      <p className="text-sm text-muted-foreground">
                        {String(seg["description"] ?? "No description")}
                      </p>
                    </div>
                    <StatusPill tone={seg["is_active"] === false ? "default" : "success"}>
                      {seg["is_active"] === false ? "Inactive" : "Active"}
                    </StatusPill>
                  </div>
                  <RuleSummary rules={seg["rules"] ?? seg["criteria"]} />
                  <p className="mt-2 text-xs text-muted-foreground">
                    {seg["member_count"] != null
                      ? `${Number(seg["member_count"]).toLocaleString()} members at last evaluation`
                      : "Membership not yet evaluated"}
                    {seg["last_evaluated_at"]
                      ? ` · ${formatDateTime(seg["last_evaluated_at"])}`
                      : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <div className="space-y-6">
          <SectionCard
            title="Suggested definitions"
            description="Common hospitality audiences you can recreate."
          >
            <ul className="space-y-3">
              {SEGMENT_TEMPLATES.map((t) => (
                <li key={t.name} className="rounded-lg border border-dashed border-border p-3">
                  <p className="text-sm font-medium text-foreground">{t.name}</p>
                  <p className="text-xs text-muted-foreground">{t.description}</p>
                  <RuleSummary rules={t.rules} />
                </li>
              ))}
            </ul>
          </SectionCard>

          <SectionCard
            title="Available attributes"
            description="Only these recorded fields can be used in rules."
          >
            <div className="flex flex-wrap gap-1.5">
              {SEGMENT_ATTRIBUTES.map((a) => (
                <span
                  key={a.value}
                  className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
                >
                  {a.label}
                </span>
              ))}
            </div>
            <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
                <ShieldAlert className="size-3.5" /> Never permitted as a targeting attribute
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {PROHIBITED_SEGMENT_ATTRIBUTES.join(", ")}
              </p>
            </div>
          </SectionCard>
        </div>
      </div>

      <SectionCard
        className="mt-6"
        title="Frozen audience snapshots"
        description="Each campaign send keeps an immutable copy of its audience for audit and reporting."
      >
        {!snapshots?.length ? (
          <p className="text-sm text-muted-foreground">No audiences have been frozen yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {(snapshots as Row[]).map((s) => (
              <li
                key={String(s["id"])}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
              >
                <span className="font-medium text-foreground">
                  {String(s["name"] ?? "Snapshot")}
                </span>
                <span className="text-muted-foreground">
                  {Number(s["member_count"] ?? 0).toLocaleString()} members · frozen{" "}
                  {formatDateTime(s["created_at"])}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function RuleSummary({ rules }: { rules: unknown }) {
  const set = rules as SegmentRuleSet | null | undefined;
  if (!set || !Array.isArray(set.conditions) || !set.conditions.length) {
    return <p className="mt-2 text-xs text-muted-foreground">No rule conditions recorded.</p>;
  }
  return (
    <ul className="mt-2 space-y-1">
      {set.conditions.map((c: SegmentCondition, i: number) => (
        <li key={i} className="text-xs text-muted-foreground">
          {i > 0 ? <span className="font-semibold uppercase">{set.match ?? "all"} · </span> : null}
          {SEGMENT_ATTRIBUTES.find((a) => a.value === c.attribute)?.label ?? c.attribute}{" "}
          {operatorLabels[c.operator] ?? c.operator}{" "}
          {String(Array.isArray(c.value) ? c.value.join(", ") : (c.value ?? ""))}
        </li>
      ))}
    </ul>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/marketing/segments">
      <Page />
    </OpsGuard>
  );
}
