import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { statusTone, titleCase, useAutomationRefresh, useWorkflowFailures } from "@/lib/automation";
import { retryWorkflowFailure } from "@/lib/automation.functions";
import { useAuth } from "@/lib/auth";
import { count, useOutboxFailures, useOutboxHealth } from "@/lib/intelligence-data";
import { EmptyState, LoadingState } from "@/components/common/StateSystem";

export const Route = createFileRoute("/_shell/automation/failures")({
  head: () => ({
    meta: [
      { title: "Failed Workflows — Automation Centre" },
      {
        name: "description",
        content:
          "Dead-letter view of failed workflow runs with error category, cause and safe retry.",
      },
      { property: "og:title", content: "Failed Workflows — Automation Centre" },
      {
        property: "og:description",
        content: "Investigate and retry failed automation runs without duplicating actions.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type FailureRow = {
  id: string;
  error_category: string;
  error_message: string;
  recommended_action: string | null;
  retry_count: number;
  status: string;
  first_failed_at: string;
  last_failed_at: string;
  workflow_definitions: { name: string } | null;
};

function FailuresPage() {
  const { can, isAdmin } = useAuth();
  const failures = useWorkflowFailures();
  const refresh = useAutomationRefresh();
  const retry = useServerFn(retryWorkflowFailure);
  const canRetry = can("automation", "override");

  const rows = (failures.data ?? []) as unknown as FailureRow[];

  async function handleRetry(id: string) {
    try {
      await retry({ data: { failureId: id } });
      refresh();
      toast.success("Event re-queued for processing");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Retry failed");
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Automation & Communications"
        title="Failed workflows"
        description="Failures are kept with their original event so a retry replays the same work exactly once."
      />

      <SectionCard
        title="Failure log"
        description={`${rows.filter((r) => r.status === "new").length} unresolved`}
      >
        {failures.isLoading ? (
          <LoadingState rows={3} />
        ) : rows.length === 0 ? (
          <EmptyState inline title="No workflow failures" description="No workflow failures have been recorded." />
        ) : (
          <ul className="divide-y divide-border text-sm">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="font-medium">{r.workflow_definitions?.name ?? "Workflow"}</p>
                  <p className="text-xs text-muted-foreground">
                    {titleCase(r.error_category)} · {r.retry_count} retry attempt(s) · last failed{" "}
                    {new Date(r.last_failed_at).toLocaleString()}
                  </p>
                  <p className="mt-1 text-xs text-destructive">{r.error_message}</p>
                  {r.recommended_action ? (
                    <p className="text-xs text-muted-foreground">
                      Recommended: {r.recommended_action}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill tone={statusTone(r.status)}>{titleCase(r.status)}</StatusPill>
                  {canRetry && r.status !== "resolved" ? (
                    <Button size="sm" variant="outline" onClick={() => handleRetry(r.id)}>
                      <RotateCcw className="size-4" /> Retry
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <OutboxSection />
    </div>
  );
}

/**
 * Event outbox health. Every operational handoff (finance posting, notification,
 * downstream task) travels through the outbox, so a stuck event here explains a
 * missing figure elsewhere. Retries are replayed by the processor with the
 * original idempotency key, so a replay can never double-post.
 */
function OutboxSection() {
  const health = useOutboxHealth(null);
  const failures = useOutboxFailures(null);

  if (health.data && health.data.authorised === false) return null;

  const h = health.data;
  const rows = failures.data ?? [];

  return (
    <SectionCard
      title="Event outbox health"
      description="Pending, retrying and dead-lettered handoffs. Replays reuse the original event key, so no action is performed twice."
    >
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          { label: "Pending", value: count(h?.pending) },
          { label: "Retrying", value: count(h?.retrying) },
          { label: "Processing", value: count(h?.processing) },
          { label: "Dead-lettered", value: count(h?.dead_lettered) },
          { label: "Processed (24h)", value: count(h?.processed_24h) },
        ].map((m) => (
          <div key={m.label} className="rounded-xl border border-border p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{m.label}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {health.isLoading ? "…" : m.value}
            </p>
          </div>
        ))}
      </div>

      {failures.isLoading ? (
        <LoadingState rows={2} />
      ) : rows.length === 0 ? (
        <EmptyState inline title="No failed or retrying events" description="The event outbox has no failed or retrying events right now." />
      ) : (
        <ul className="divide-y divide-border text-sm">
          {rows.map((e) => (
            <li key={e.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-medium">{titleCase(e.event_type)}</p>
                <p className="text-xs text-muted-foreground">
                  {e.source_module ?? "unknown module"} · attempt {e.attempts} of {e.max_attempts} ·
                  raised {new Date(e.occurred_at).toLocaleString()}
                  {e.next_attempt_at
                    ? ` · next attempt ${new Date(e.next_attempt_at).toLocaleString()}`
                    : ""}
                </p>
                {e.last_error ? (
                  <p className="mt-1 text-xs text-destructive">{e.last_error}</p>
                ) : null}
              </div>
              <StatusPill tone={statusTone(e.dead_lettered_at ? "failed" : e.status)}>
                {e.dead_lettered_at ? "Dead-lettered" : titleCase(e.status)}
              </StatusPill>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/automation/failures">
      <FailuresPage />
    </OpsGuard>
  );
}
