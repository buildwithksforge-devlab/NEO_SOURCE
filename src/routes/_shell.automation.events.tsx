import { useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState, LoadingState } from "@/components/common/StateSystem";
import {
  EVENT_CATALOGUE,
  statusTone,
  titleCase,
  useDomainEvents,
  useWorkflowRuns,
} from "@/lib/automation";

export const Route = createFileRoute("/_shell/automation/events")({
  head: () => ({
    meta: [
      { title: "Event Log — Automation Centre" },
      {
        name: "description",
        content:
          "Recorded business events, their processing status and the workflow runs they produced.",
      },
      { property: "og:title", content: "Event Log — Automation Centre" },
      {
        property: "og:description",
        content: "Transactional event outbox with exactly-once processing history.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type EventRow = {
  id: string;
  event_type: string;
  source_module: string;
  status: string;
  retry_count: number;
  last_error: string | null;
  occurred_at: string;
  processed_at: string | null;
};

function EventsPage() {
  const events = useDomainEvents(200);
  const runs = useWorkflowRuns(100);
  const [type, setType] = useState("all");

  const rows = ((events.data ?? []) as unknown as EventRow[]).filter(
    (e) => type === "all" || e.event_type === type,
  );
  const liveTypes = Array.from(
    new Set(((events.data ?? []) as unknown as EventRow[]).map((e) => e.event_type)),
  );

  return (
    <div>
      <PageHeader
        eyebrow="Automation & Communications"
        title="Event log & history"
        description="Every automated action starts from a recorded business event. Events are written in the same transaction as the operation itself, so nothing is lost or duplicated."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard
          title="Recorded events"
          description={`${rows.length} event(s)`}
          actions={
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All event types</SelectItem>
                {liveTypes.map((t) => (
                  <SelectItem key={t} value={t}>
                    {titleCase(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        >
          {events.isLoading ? (
            <LoadingState rows={4} />
          ) : rows.length === 0 ? (
            <EmptyState inline title="No events recorded" description="No business events have been recorded yet." />
          ) : (
            <ul className="divide-y divide-border text-sm">
              {rows.slice(0, 60).map((e) => (
                <li key={e.id} className="flex items-start justify-between gap-3 py-2">
                  <div>
                    <p className="font-medium">{titleCase(e.event_type)}</p>
                    <p className="text-xs text-muted-foreground">
                      {titleCase(e.source_module)} · {new Date(e.occurred_at).toLocaleString()}
                      {e.retry_count ? ` · ${e.retry_count} retries` : ""}
                    </p>
                    {e.last_error ? (
                      <p className="text-xs text-destructive">{e.last_error}</p>
                    ) : null}
                  </div>
                  <StatusPill tone={statusTone(e.status)}>{titleCase(e.status)}</StatusPill>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Run history"
          description="Complete execution history across all workflows."
        >
          {runs.isLoading ? (
            <LoadingState rows={4} />
          ) : (runs.data ?? []).length === 0 ? (
            <EmptyState inline title="No workflow runs" description="No workflow runs have been recorded yet." />
          ) : (
            <ul className="divide-y divide-border text-sm">
              {(runs.data ?? []).map((r) => {
                const row = r as unknown as {
                  id: string;
                  status: string;
                  mode: string;
                  matched: boolean;
                  started_at: string;
                  duration_ms: number | null;
                  actions_completed: number;
                  actions_total: number;
                  workflow_definitions: { name: string } | null;
                };
                return (
                  <li key={row.id} className="flex items-center justify-between gap-3 py-2">
                    <div>
                      <p className="font-medium">{row.workflow_definitions?.name ?? "Workflow"}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(row.started_at).toLocaleString()} · {row.mode} ·{" "}
                        {row.actions_completed}/{row.actions_total} actions
                        {row.duration_ms ? ` · ${row.duration_ms} ms` : ""}
                      </p>
                    </div>
                    <StatusPill tone={statusTone(row.status)}>{titleCase(row.status)}</StatusPill>
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Event catalogue"
        className="mt-6"
        description="Events available to workflows in this platform."
      >
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {EVENT_CATALOGUE.map((e) => (
            <li
              key={e.type}
              className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
            >
              <span>
                {e.label}
                <span className="block text-xs text-muted-foreground">{e.group}</span>
              </span>
              <StatusPill tone={e.live ? "success" : "default"}>
                {e.live ? "Live" : "Module pending"}
              </StatusPill>
            </li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/automation/events">
      <EventsPage />
    </OpsGuard>
  );
}
