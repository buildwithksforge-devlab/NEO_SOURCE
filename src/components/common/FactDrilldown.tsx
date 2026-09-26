/**
 * Eligibility validator drilldown.
 *
 * A zero figure is a claim about the operational records, so it must be
 * defensible: this dialog lists the exact records behind the metric, their
 * current status, the rule that governs eligibility and the action needed to
 * make each one eligible.
 */
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowUpRight, SearchCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/common/DataDisplay";
import { useEligibilityDrilldown } from "@/lib/finance-posting";
import type { FactScope } from "@/lib/facts";

export function FactDrilldown({
  metric,
  label,
  eligibility,
  scope,
}: {
  metric: string;
  label: string;
  eligibility: string;
  scope: FactScope;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
          <SearchCheck className="size-3.5" /> Why?
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{label} — eligibility validator</DialogTitle>
          <DialogDescription>{eligibility}</DialogDescription>
        </DialogHeader>
        <DrilldownBody metric={metric} scope={scope} />
      </DialogContent>
    </Dialog>
  );
}

function DrilldownBody({ metric, scope }: { metric: string; scope: FactScope }) {
  const rows = useEligibilityDrilldown(metric, scope, true);

  if (rows.isLoading) return <Skeleton className="h-40 w-full rounded-xl" />;
  if (rows.error)
    return (
      <p className="flex items-center gap-2 text-sm text-destructive">
        <AlertTriangle className="size-4" /> The operational records could not be read.
      </p>
    );
  if ((rows.data ?? []).length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        There is no operational record of this kind in the selected period and property, so the
        figure is genuinely nil rather than unmatched.
      </p>
    );

  return (
    <div className="max-h-[60vh] overflow-auto">
      <table className="w-full text-left text-sm">
        <thead className="sticky top-0 bg-card text-xs uppercase text-muted-foreground">
          <tr>
            <th className="py-2 pr-3">Record</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3">Amount</th>
            <th className="py-2 pr-3">Date</th>
            <th className="py-2 pr-3">Eligibility rule</th>
            <th className="py-2 pr-3">Action required</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {(rows.data ?? []).map((r) => (
            <tr key={`${r.source_module}:${r.source_id}`}>
              <td className="py-2 pr-3">
                <span className="font-mono text-xs">{r.reference || r.source_id}</span>
                <span className="ml-2 text-xs text-muted-foreground">{r.source_module}</span>
              </td>
              <td className="py-2 pr-3">
                <StatusPill tone={r.eligible ? "success" : "warning"}>
                  {r.eligible ? "Eligible" : r.source_status}
                </StatusPill>
              </td>
              <td className="py-2 pr-3">
                {r.currency} {Number(r.amount ?? 0).toLocaleString("en-KE")}
              </td>
              <td className="py-2 pr-3">{r.occurred_on}</td>
              <td className="py-2 pr-3 text-xs text-muted-foreground">{r.rule}</td>
              <td className="py-2 pr-3 text-xs font-medium">{r.required_action}</td>
              <td className="py-2">
                <Link
                  to={r.drill_to}
                  className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
                >
                  Open <ArrowUpRight className="size-3" />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
