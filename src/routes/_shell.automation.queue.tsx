import { useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  statusTone,
  titleCase,
  useCommunicationQueue,
  useScheduledActions,
} from "@/lib/automation";

export const Route = createFileRoute("/_shell/automation/queue")({
  head: () => ({
    meta: [
      { title: "Communication Queue — Automation Centre" },
      {
        name: "description",
        content:
          "Queued, scheduled, sent, failed and suppressed guest communications with full audit detail.",
      },
      { property: "og:title", content: "Communication Queue — Automation Centre" },
      {
        property: "og:description",
        content: "Delivery tracking for every automated guest message.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type QueueRow = {
  id: string;
  channel: string;
  recipient: string | null;
  subject: string | null;
  status: string;
  attempt_count: number;
  max_attempts: number;
  scheduled_for: string | null;
  failure_message: string | null;
  suppression_reason: string | null;
  is_marketing: boolean;
  consent_verified: boolean;
  created_at: string;
  customers: { full_name: string } | null;
};

function QueuePage() {
  const queue = useCommunicationQueue();
  const scheduled = useScheduledActions();
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");

  const rows = ((queue.data ?? []) as unknown as QueueRow[]).filter((r) => {
    if (status !== "all" && r.status !== status) return false;
    if (!search.trim()) return true;
    const needle = search.toLowerCase();
    return (
      (r.recipient ?? "").toLowerCase().includes(needle) ||
      (r.subject ?? "").toLowerCase().includes(needle) ||
      (r.customers?.full_name ?? "").toLowerCase().includes(needle)
    );
  });

  return (
    <div>
      <PageHeader
        eyebrow="Automation & Communications"
        title="Communication queue"
        description="Messages are queued by workflows and only dispatched once a provider is connected. Suppressed messages are never sent."
      />

      <SectionCard
        title="Queue"
        description={`${rows.length} message(s)`}
        className="mb-6"
        actions={
          <div className="flex gap-2">
            <Input
              className="w-48"
              placeholder="Search recipient"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  "all",
                  "queued",
                  "scheduled",
                  "sending",
                  "sent",
                  "delivered",
                  "failed",
                  "suppressed",
                  "cancelled",
                ].map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      >
        {rows.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            No messages match this view.
          </p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {r.customers?.full_name ?? r.recipient ?? "Unknown recipient"} ·{" "}
                    {r.subject ?? "(no subject)"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {titleCase(r.channel)} · attempt {r.attempt_count}/{r.max_attempts} ·{" "}
                    {r.scheduled_for
                      ? `scheduled ${new Date(r.scheduled_for).toLocaleString()}`
                      : new Date(r.created_at).toLocaleString()}
                  </p>
                  {r.failure_message ? (
                    <p className="text-xs text-destructive">{r.failure_message}</p>
                  ) : null}
                  {r.suppression_reason ? (
                    <p className="text-xs text-on-tint-warning">
                      Suppressed: {titleCase(r.suppression_reason)}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {r.is_marketing ? (
                    <StatusPill tone={r.consent_verified ? "info" : "destructive"}>
                      {r.consent_verified ? "Consent verified" : "No consent"}
                    </StatusPill>
                  ) : null}
                  <StatusPill tone={statusTone(r.status)}>{titleCase(r.status)}</StatusPill>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="Scheduled actions"
        description="Delayed workflow actions waiting for their due time."
      >
        {(scheduled.data ?? []).length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Nothing is scheduled.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {(scheduled.data ?? []).map((s) => {
              const row = s as unknown as {
                id: string;
                action_type: string;
                scheduled_for: string;
                status: string;
                last_error: string | null;
              };
              return (
                <li key={row.id} className="flex items-center justify-between gap-3 py-2">
                  <div>
                    <p>{titleCase(row.action_type)}</p>
                    <p className="text-xs text-muted-foreground">
                      Due {new Date(row.scheduled_for).toLocaleString()}
                      {row.last_error ? ` · ${row.last_error}` : ""}
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
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/automation/queue">
      <QueuePage />
    </OpsGuard>
  );
}
