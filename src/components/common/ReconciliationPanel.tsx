/**
 * Renders a database-computed integrity report: one collapsible group per class
 * of exception, with the offending records listed rather than summarised away.
 */
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { EmptyState, ErrorState } from "@/components/common/StateSystem";
import { Skeleton } from "@/components/ui/skeleton";
import type { ReconciliationReport } from "@/lib/ops-reconciliation";

type Props = {
  title: string;
  description: string;
  report: ReconciliationReport | undefined;
  isLoading: boolean;
  error: unknown;
};

export function ReconciliationPanel({ title, description, report, isLoading, error }: Props) {
  return (
    <SectionCard
      title={title}
      description={description}
      actions={
        report ? (
          <StatusPill tone={report.healthy ? "success" : "warning"}>
            {report.healthy ? (
              <>
                <CheckCircle2 className="mr-1 inline h-3 w-3" />
                Reconciled
              </>
            ) : !report.ok ? (
              <>
                <AlertTriangle className="mr-1 inline h-3 w-3" />
                Check did not complete
              </>
            ) : (
              <>
                <AlertTriangle className="mr-1 inline h-3 w-3" />
                {report.total} exception{report.total === 1 ? "" : "s"}
              </>
            )}
          </StatusPill>
        ) : null
      }
    >
      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : error ? (
        <ErrorState error={error} inline />
      ) : !report ? (
        <EmptyState
          inline
          title="Awaiting data"
          description="Nothing has been reconciled for this scope yet. Records appear here once transactions are posted."
        />
      ) : !report.ok ? (
        <ErrorState
          inline
          error={
            new Error(
              "The integrity check did not complete for this scope, so no conclusion can be drawn. Retry, and report it if it keeps failing.",
            )
          }
        />
      ) : (
        <Accordion type="multiple" className="w-full">
          {report.groups.map((group) => (
            <AccordionItem key={group.key} value={group.key}>
              <AccordionTrigger className="text-sm">
                <span className="flex items-center gap-2">
                  {group.label}
                  <StatusPill tone={group.rows.length === 0 ? "success" : "warning"}>{group.rows.length}</StatusPill>
                </span>
              </AccordionTrigger>
              <AccordionContent>
                {group.rows.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Nothing outstanding.</p>
                ) : (
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {group.rows.slice(0, 50).map((row, index) => (
                      <li key={index} className="rounded border border-border/50 bg-card/40 p-2 font-mono">
                        {Object.entries(row)
                          .map(([k, v]) => `${k}: ${v ?? "—"}`)
                          .join(" · ")}
                      </li>
                    ))}
                  </ul>
                )}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}
    </SectionCard>
  );
}
