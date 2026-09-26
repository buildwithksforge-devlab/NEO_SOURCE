import { LoadingState } from "@/components/common/StateSystem";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { Workflow } from "lucide-react";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { EmptyState, MetricTile } from "@/components/marketing/MarketingShared";
import { useLeads, useMoveLeadStage } from "@/lib/marketing-data";
import { PIPELINE_STAGES, formatDate, isOverdue, leadStageLabels } from "@/lib/marketing";

export const Route = createFileRoute("/_shell/marketing/pipeline")({
  head: () => ({
    meta: [
      { title: "Lead Pipeline — Marketing & CRM" },
      {
        name: "description",
        content:
          "Kanban view of every open enquiry, its assigned owner, forecast value and overdue follow-ups.",
      },
      { property: "og:title", content: "Lead Pipeline — Marketing & CRM" },
      {
        property: "og:description",
        content: "Kanban pipeline with forecast value and overdue follow-ups.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type Row = Record<string, any>;

function Page() {
  const { data: leads, isLoading } = useLeads();
  const move = useMoveLeadStage();

  const rows = (leads ?? []) as Row[];
  const open = rows.filter(
    (l) => !["won", "lost", "archived", "unqualified"].includes(String(l["stage"])),
  );
  const forecast = open.reduce(
    (sum, l) => sum + (Number(l["estimated_value"] ?? 0) * Number(l["probability"] ?? 0)) / 100,
    0,
  );
  const overdue = open.filter((l) => isOverdue(l["next_followup_at"], String(l["stage"])));
  const won = rows.filter((l) => String(l["stage"]) === "won").length;
  const closed = rows.filter((l) => ["won", "lost"].includes(String(l["stage"]))).length;

  return (
    <div>
      <PageHeader
        eyebrow="Marketing & CRM"
        title="Lead Pipeline"
        description="Drag-free stage movement: pick the next stage on any card. Every move is written to the lead's immutable stage history."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        <MetricTile label="Open leads" value={String(open.length)} />
        <MetricTile
          label="Weighted forecast"
          value={forecast.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          hint="Estimated value × recorded probability"
        />
        <MetricTile
          label="Overdue follow-ups"
          value={String(overdue.length)}
          tone={overdue.length ? "warning" : "default"}
        />
        <MetricTile
          label="Conversion"
          value={closed ? `${((won / closed) * 100).toFixed(0)}%` : "—"}
          hint={closed ? `${won} won of ${closed} closed` : "No closed leads yet"}
        />
      </div>

      {isLoading ? (
        <LoadingState variant="cards" rows={5} />
      ) : !rows.length ? (
        <SectionCard title="Pipeline" description="Nothing to show yet.">
          <EmptyState
            icon={Workflow}
            title="No leads in the pipeline"
            description="Capture a lead from the Leads screen or connect a website enquiry form to populate this board."
          />
        </SectionCard>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {PIPELINE_STAGES.map((stage) => {
            const items = rows.filter((l) => String(l["stage"]) === stage);
            const value = items.reduce((s, l) => s + Number(l["estimated_value"] ?? 0), 0);
            return (
              <div
                key={stage}
                className="w-72 shrink-0 rounded-xl border border-border bg-muted/30 p-3"
              >
                <div className="mb-3 flex items-baseline justify-between">
                  <p className="text-sm font-semibold text-foreground">{leadStageLabels[stage]}</p>
                  <span className="text-xs text-muted-foreground">{items.length}</span>
                </div>
                <p className="mb-3 text-xs text-muted-foreground">
                  {value.toLocaleString()} recorded value
                </p>
                <div className="space-y-2">
                  {items.map((lead) => (
                    <div
                      key={String(lead["id"])}
                      className="rounded-lg border border-border bg-card p-3 shadow-sm"
                    >
                      <p className="text-sm font-medium text-foreground">
                        {String(lead["contact_name"])}
                      </p>
                      <p className="text-xs text-muted-foreground">{String(lead["lead_number"])}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {Number(lead["estimated_value"] ?? 0).toLocaleString()} ·{" "}
                        {Number(lead["probability"] ?? 0)}%
                      </p>
                      {isOverdue(lead["next_followup_at"], stage) ? (
                        <p className="mt-1 text-xs font-medium text-destructive">
                          Overdue {formatDate(lead["next_followup_at"])}
                        </p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap gap-1">
                        {nextStages(stage).map((next) => (
                          <Button
                            key={next}
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs"
                            onClick={() =>
                              move.mutate({
                                id: String(lead["id"]),
                                fromStage: stage,
                                toStage: next,
                              })
                            }
                          >
                            → {leadStageLabels[next]}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ))}
                  {!items.length ? (
                    <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                      Empty
                    </p>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function nextStages(stage: string) {
  const index = PIPELINE_STAGES.indexOf(stage as (typeof PIPELINE_STAGES)[number]);
  const forward = PIPELINE_STAGES[index + 1];
  const options: (typeof PIPELINE_STAGES)[number][] = [];
  if (forward && forward !== "won" && forward !== "lost") options.push(forward);
  if (stage !== "won" && stage !== "lost") options.push("won", "lost");
  return options;
}

function GuardedPage() {
  return (
    <OpsGuard path="/marketing/pipeline">
      <Page />
    </OpsGuard>
  );
}
