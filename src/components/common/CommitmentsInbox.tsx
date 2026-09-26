/**
 * Commitments inbox.
 *
 * Overdue commitments and blocked operational items, resolved by the database
 * against the reader's own capabilities. Each obligation appears once — the
 * row key is the record itself, not the notice that announced it — and links
 * straight to the screen that clears it.
 *
 * Presentation follows the shared state language (loading / error / empty) and
 * the containment contract: a two-track grid with a shrinkable text column, a
 * clamped detail line and an action that can never be pushed outside its row.
 */
import { ArrowUpRight, CalendarClock } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, QueryState } from "@/components/common/StateSystem";
import { useCommitments, overdueLabel, type Commitment } from "@/lib/commitments";

const tone = (c: Commitment) =>
  c.severity === "high" ? "destructive" : c.severity === "medium" ? "warning" : "info";

export function CommitmentsInbox({ branchId = null }: { branchId?: string | null }) {
  const commitments = useCommitments(branchId);
  const rows = commitments.data ?? [];
  const due = rows.filter((r) => r.kind === "commitment");
  const blocked = rows.filter((r) => r.kind === "blocked");

  return (
    <SectionCard
      icon={CalendarClock}
      title="Commitments and blocked items"
      description="What is overdue on you, and what is stuck. Drawn from approvals, tasks, guest requests, housekeeping, maintenance and the Finance handoff queue — each item listed once."
    >
      <QueryState
        isLoading={commitments.isLoading}
        error={commitments.error}
        isEmpty={rows.length === 0}
        onRetry={() => void commitments.refetch()}
        skeleton="rows"
        empty={
          <EmptyState
            inline
            title="Nothing is overdue or blocked in your scope"
            description="Commitments appear here the moment an approval, task, guest request or handoff passes its due time in your scope."
          />
        }
      >
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            {due.length} overdue commitment(s) · {blocked.length} blocked item(s)
          </p>
          <ul className="space-y-2">
            {rows.map((c) => (
              <li
                key={c.key}
                data-commitment-row
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3 overflow-hidden rounded-xl border border-outline-subtle p-3"
              >
                <div className="min-w-0">
                  <p
                    className="neo-line-1 text-[0.95rem] font-semibold leading-snug text-foreground"
                    title={c.title}
                  >
                    {c.title}
                  </p>
                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                    <StatusPill tone={tone(c)}>
                      {c.kind === "commitment" ? "Due from you" : "Blocked"}
                    </StatusPill>
                    <StatusPill tone="info">{c.module}</StatusPill>
                  </div>
                  <p className="neo-line-2 neo-contain mt-1.5 text-sm text-muted-foreground">
                    {c.detail}
                  </p>
                  <p className="neo-contain mt-1 text-xs text-muted-foreground">
                    {c.due_at
                      ? `${new Date(c.due_at).toLocaleString()} · ${overdueLabel(c.overdue_minutes)}`
                      : "No due time recorded"}
                    {c.reference ? ` · ${c.reference}` : ""}
                  </p>
                </div>
                <Link
                  to={c.drill_to}
                  className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium text-primary underline-offset-4 hover:underline"
                >
                  Open <ArrowUpRight className="size-3" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </QueryState>
    </SectionCard>
  );
}
