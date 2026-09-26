import { EmptyState } from "@/components/hr/HrShared";
import { StatusPill } from "@/components/common/DataDisplay";
import { shortDate } from "@/lib/hr";
import type { TimelineEvent } from "@/lib/hr-timeline";

/**
 * One dated stream of the employee's working life. Assembled from the records
 * themselves, so it can never disagree with them.
 */
export function EmployeeTimeline({ events }: { events: readonly TimelineEvent[] }) {
  if (!events.length) {
    return (
      <EmptyState
        title="Nothing recorded yet"
        description="Joining, contract, leave, training, appraisal and exit events appear here as they happen."
      />
    );
  }

  return (
    <ol className="relative space-y-4 border-l border-border pl-5">
      {events.map((event) => (
        <li key={event.id} className="relative">
          <span
            className="absolute -left-[1.625rem] top-1.5 size-2.5 rounded-full bg-primary ring-4 ring-background"
            aria-hidden
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{event.title}</span>
            <StatusPill tone={event.tone}>{event.group}</StatusPill>
            <span className="ml-auto text-xs text-muted-foreground">{shortDate(event.date)}</span>
          </div>
          {event.detail ? (
            <p className="mt-0.5 text-sm text-muted-foreground">{event.detail}</p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
