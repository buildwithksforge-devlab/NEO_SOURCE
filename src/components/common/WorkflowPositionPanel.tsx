/**
 * The "whose desk is this on?" panel.
 *
 * Renders a {@link WorkflowPosition} the same way wherever it appears, so a
 * held supplier invoice and an unposted checkout read alike: stage on the
 * conveyor, current owner, what happened last, what must happen next, who may
 * do it, why it cannot happen yet, and what it will do to the books.
 *
 * The panel never decides authority. It shows the roles the workflow expects;
 * the action button beside it is still gated by capability, and the database
 * refuses anything the caller may not do.
 */
import { AlertTriangle, ArrowRight, CheckCircle2, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { RelatedReference, WorkflowPosition } from "@/lib/workflow-position";

function StageTrack({ stages, index }: { stages: readonly string[]; index: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-1" aria-label="Workflow stages">
      {stages.map((stage, i) => {
        const done = i < index;
        const current = i === index;
        return (
          <li key={stage} className="flex items-center gap-1">
            <span
              aria-current={current ? "step" : undefined}
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] leading-tight",
                current && "bg-primary text-primary-foreground font-medium",
                done && "bg-muted text-muted-foreground",
                !done && !current && "text-muted-foreground/60",
              )}
            >
              {stage}
            </span>
            {i < stages.length - 1 && (
              <ArrowRight aria-hidden className="text-muted-foreground/40 size-3 shrink-0" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-muted-foreground text-[11px] tracking-wide uppercase">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export function WorkflowPositionPanel({
  position,
  references = [],
  className,
}: {
  position: WorkflowPosition;
  references?: readonly RelatedReference[];
  className?: string;
}) {
  const { blocker, nextAction, complete } = position;

  return (
    <section
      className={cn("bg-card space-y-3 rounded-lg border p-4", className)}
      aria-label="Workflow position"
    >
      <StageTrack stages={position.stages} index={position.stageIndex} />

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{position.stage}</Badge>
        <span className="text-muted-foreground inline-flex items-center gap-1 text-sm">
          <UserRound aria-hidden className="size-3.5" />
          {position.owner}
          <span className="text-muted-foreground/70">({position.owningRole})</span>
        </span>
      </div>

      <dl className="grid gap-3 sm:grid-cols-2">
        <Fact label="Previous action">
          {position.previousAction ?? <span className="text-muted-foreground">Not recorded</span>}
        </Fact>
        <Fact label="Next required action">
          {complete ? (
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 aria-hidden className="size-3.5" /> Complete — nothing further required
            </span>
          ) : (
            (nextAction ?? <span className="text-muted-foreground">Awaiting definition</span>)
          )}
        </Fact>
        {position.permittedRoles.length > 0 && (
          <Fact label="Who may perform it">{position.permittedRoles.join(" or ")}</Fact>
        )}
        {position.financialConsequence && (
          <Fact label="Financial consequence">{position.financialConsequence}</Fact>
        )}
      </dl>

      {blocker && (
        <p
          role="status"
          className="text-destructive flex items-start gap-2 rounded-md border border-current/25 bg-current/5 p-2 text-sm"
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-medium">Blocked — </span>
            {blocker}
          </span>
        </p>
      )}

      {references.length > 0 && (
        <dl className="flex flex-wrap gap-x-6 gap-y-1">
          {references.map((ref) => (
            <div key={`${ref.label}-${ref.value}`} className="text-sm">
              <dt className="text-muted-foreground inline text-[11px] tracking-wide uppercase">
                {ref.label}{" "}
              </dt>
              <dd className="inline font-mono text-xs">{ref.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
