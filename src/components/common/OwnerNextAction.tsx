/**
 * The compact form of a workflow position, for table rows.
 *
 * A register row has no space for the full panel, but "Scheduled" alone is
 * not an answer either. This gives the two facts that decide whether a row
 * needs someone today — who holds it and what they must do — and states the
 * blocker rather than leaving the reader to guess why nothing is moving.
 */
import { AlertTriangle } from "lucide-react";
import type { WorkflowPosition } from "@/lib/workflow-position";

export function OwnerNextAction({ position }: { position: WorkflowPosition }) {
  if (position.complete) {
    return <span className="text-muted-foreground text-xs">Complete</span>;
  }
  return (
    <div className="min-w-[11rem] space-y-0.5">
      <p className="text-xs font-medium">{position.owner}</p>
      <p className="text-muted-foreground text-xs">
        {position.nextAction ?? "Awaiting definition"}
      </p>
      {position.blocker && (
        <p className="text-destructive flex items-start gap-1 text-xs">
          <AlertTriangle aria-hidden className="mt-0.5 size-3 shrink-0" />
          <span>{position.blocker}</span>
        </p>
      )}
    </div>
  );
}
