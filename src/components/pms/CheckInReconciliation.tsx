import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { SectionCard } from "@/components/common/DataDisplay";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { titleCase } from "@/lib/pms";
import { useCheckInReconciliation } from "@/lib/pms-data";

function tone(severity: string): "destructive" | "warning" | "outline" {
  if (severity === "critical") return "destructive";
  if (severity === "warning") return "warning";
  return "outline";
}

/**
 * Watches for check-ins that did not reach the counts and records they should
 * have updated — a stay that never opened a folio, a room that stayed vacant,
 * an arrival missing from guest history.
 */
export function CheckInReconciliation() {
  const { branchId } = useActivePropertyFilter();
  const monitor = useCheckInReconciliation(branchId);
  const rows = monitor.data ?? [];

  return (
    <SectionCard
      title="Check-in reconciliation"
      description="Drift between an arrival and the in-house counts, folios and guest history it should have updated."
    >
      {monitor.isLoading ? (
        <Skeleton className="h-24 w-full rounded-xl" />
      ) : monitor.error ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{(monitor.error as Error).message}</p>
      ) : rows.length === 0 ? (
        <div className="flex items-center gap-3 rounded-xl border border-dashed border-border/60 p-5 text-sm">
          <CheckCircle2 className="size-5 text-primary" />
          <span>Every check-in agrees with its stay, folio, room state and guest history.</span>
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((r, i) => (
            <li
              key={`${r.issue}-${r.reservation_id ?? r.room_number ?? i}`}
              className="rounded-xl border border-border/60 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <AlertTriangle className="size-4 text-on-tint-warning" />
                <Badge variant={tone(r.severity)}>{titleCase(r.severity)}</Badge>
                <span className="text-sm font-medium">{titleCase(r.issue.replace(/_/g, " "))}</span>
                {r.reference ? <span className="font-mono text-xs text-muted-foreground">{r.reference}</span> : null}
                {r.room_number ? <span className="text-xs text-muted-foreground">Room {r.room_number}</span> : null}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{r.detail}</p>
              <p className="mt-1 text-sm">
                {r.required_action}{" "}
                <Link to={r.drill_to} className="text-primary underline-offset-4 hover:underline">
                  Open
                </Link>
              </p>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
