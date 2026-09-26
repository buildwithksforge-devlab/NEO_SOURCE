/**
 * Rider performance metrics and per-rider activity log. Both come from scoped
 * database routines so a viewer only ever sees properties in their scope.
 */
import { useState } from "react";
import { SectionCard } from "@/components/common/DataDisplay";
import { EmptyState, QueryState } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { money, shortDateTime, titleCase } from "@/lib/delivery";
import { useRiderAudit, useRiderPerformance } from "@/lib/delivery-data";

export function RiderPerformanceCard({ branchId }: { branchId?: string | null | undefined }) {
  const performance = useRiderPerformance(branchId);
  const rows = performance.data ?? [];
  const [openRider, setOpenRider] = useState<{ id: string; name: string } | null>(null);

  return (
    <SectionCard
      title="Rider performance"
      description="Last 30 days: assignments, completion, delivery speed, punctuality, cash carried and scheduled hours."
    >
      <QueryState
        isLoading={performance.isLoading}
        error={performance.error}
        isEmpty={rows.length === 0}
        empty={<EmptyState title="Awaiting data" description="Performance appears once riders complete deliveries." />}
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Rider</TableHead>
                <TableHead className="text-right">Assigned</TableHead>
                <TableHead className="text-right">Delivered</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead className="text-right">Active</TableHead>
                <TableHead className="text-right">Avg delivery</TableHead>
                <TableHead className="text-right">Avg assign→done</TableHead>

                <TableHead className="text-right">On time</TableHead>
                <TableHead className="text-right">Cash</TableHead>
                <TableHead className="text-right">Hours</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.rider_id}>
                  <TableCell className="font-medium">{r.display_name ?? r.rider_code ?? "Rider"}</TableCell>
                  <TableCell className="text-right">{r.assigned}</TableCell>
                  <TableCell className="text-right">{r.delivered}</TableCell>
                  <TableCell className="text-right">{r.failed}</TableCell>
                  <TableCell className="text-right">{r.active_orders ?? 0}</TableCell>
                  <TableCell className="text-right">{r.avg_delivery_minutes ?? "—"}</TableCell>
                  <TableCell className="text-right">{r.avg_assignment_minutes ?? "—"}</TableCell>


                  <TableCell className="text-right">
                    {r.on_time_rate === null || r.on_time_rate === undefined ? "—" : `${r.on_time_rate}%`}
                  </TableCell>
                  <TableCell className="text-right">{money(r.cash_collected)}</TableCell>
                  <TableCell className="text-right">{r.scheduled_hours}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setOpenRider({ id: r.rider_id, name: r.display_name ?? "Rider" })}
                    >
                      Activity
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </QueryState>

      <RiderAuditSheet rider={openRider} onClose={() => setOpenRider(null)} />
    </SectionCard>
  );
}

function RiderAuditSheet({
  rider,
  onClose,
}: {
  rider: { id: string; name: string } | null;
  onClose: () => void;
}) {
  const audit = useRiderAudit(rider?.id ?? null);
  const rows = audit.data ?? [];

  return (
    <Sheet open={Boolean(rider)} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <SheetContent className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{rider?.name ?? "Rider"} activity</SheetTitle>
          <SheetDescription>Order transitions and shift changes, most recent first.</SheetDescription>
        </SheetHeader>
        <div className="mt-4">
          <QueryState
            isLoading={audit.isLoading}
            error={audit.error}
            isEmpty={rows.length === 0}
            empty={<EmptyState title="No activity yet" description="Nothing recorded for this rider." />}
          >
            <ol className="space-y-3">
              {rows.map((row, index) => (
                <li key={`${row.created_at}-${index}`} className="border-l-2 border-border/60 pl-3">
                  <p className="text-sm font-medium">
                    {titleCase(row.action.replace(/[._]/g, " "))}
                    {row.order_number ? ` · ${row.order_number}` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {shortDateTime(row.created_at)}
                    {row.detail ? ` · ${row.detail}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          </QueryState>
        </div>
      </SheetContent>
    </Sheet>
  );
}
