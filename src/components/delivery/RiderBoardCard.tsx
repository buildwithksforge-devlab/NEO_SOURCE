/**
 * Rider performance for the staff board.
 *
 * Deliveries completed and the average time each rider takes, read from the
 * same scoped database routine the dispatch desk uses, plus the shift history
 * of whichever rider is selected. Read-only: nothing here changes a record.
 */
import { useMemo, useState } from "react";
import { Bike } from "lucide-react";
import { SectionCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { QueryState } from "@/components/common/StateSystem";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { shortDateTime, titleCase } from "@/lib/delivery";
import {
  useDeliveryRouteLog,
  useRiderPerformance,
  useRiderRoutes,
  useRiderShifts,
} from "@/lib/delivery-data";
import type { Row } from "@/lib/inventory";

const str = (v: unknown, fallback = "") => (v == null ? fallback : String(v));

function minutes(v: number | null | undefined) {
  if (v === null || v === undefined) return "—";
  return `${v} min`;
}

function shiftTone(status: string): "default" | "info" | "success" | "warning" | "destructive" {
  if (status === "active") return "info";
  if (status === "completed") return "success";
  if (status === "cancelled") return "destructive";
  return "warning";
}

export function RiderBoardCard({ branchId }: { branchId?: string | null | undefined }) {
  const performance = useRiderPerformance(branchId);
  const routes = useRiderRoutes(branchId);
  const routeLog = useDeliveryRouteLog(branchId);
  const shifts = useRiderShifts(branchId);
  const [selected, setSelected] = useState<string | null>(null);

  const rows = performance.data ?? [];
  const selectedRider = rows.find((r) => r.rider_id === selected) ?? null;
  const routeByRider = useMemo(() => {
    const map = new Map<string, (typeof routes.data extends undefined ? never : NonNullable<typeof routes.data>[number])>();
    for (const r of routes.data ?? []) map.set(r.rider_id, r);
    return map;
  }, [routes.data]);

  const riderShifts = useMemo(() => {
    if (!selected) return [] as Row[];
    return ((shifts.data ?? []) as Row[]).filter((s) => str(s["rider_id"]) === selected);
  }, [shifts.data, selected]);

  return (
    <SectionCard
      title="Rider performance"
      description="Last 30 days: deliveries completed and the average time each one took. Pick a rider to see their shifts."
      icon={Bike}
    >
      <QueryState
        isLoading={performance.isLoading}
        error={performance.error}
        isEmpty={rows.length === 0}
        empty="No rider activity yet."
      >
        <TableScroll>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Rider</TableHead>
                <TableHead className="text-right">Assigned</TableHead>
                <TableHead className="text-right">Completed</TableHead>
                <TableHead className="text-right">Average per delivery</TableHead>
                <TableHead className="text-right">Distance travelled</TableHead>
                <TableHead className="text-right">Average distance</TableHead>
                <TableHead className="text-right">Speed</TableHead>
                <TableHead className="text-right">Minutes / km</TableHead>
                <TableHead className="text-right">Hours scheduled</TableHead>
                <TableHead className="text-right">Shifts</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.rider_id}>
                  <TableCell className="font-medium">
                    {r.display_name ?? r.rider_code ?? "Rider"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.assigned}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.delivered}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {minutes(r.avg_delivery_minutes)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {routeByRider.get(r.rider_id)?.measured_deliveries
                      ? `${routeByRider.get(r.rider_id)?.total_km} km`
                      : "Not measured"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {routeByRider.get(r.rider_id)?.avg_km == null
                      ? "—"
                      : `${routeByRider.get(r.rider_id)?.avg_km} km`}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {routeByRider.get(r.rider_id)?.avg_km_per_hour == null
                      ? "—"
                      : `${routeByRider.get(r.rider_id)?.avg_km_per_hour} km/h`}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {(() => {
                      const perKm =
                        routeByRider.get(r.rider_id)?.avg_minutes_per_km ?? r.avg_minutes_per_km;
                      return perKm == null ? "—" : `${perKm} min/km`;
                    })()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.scheduled_hours}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant={selected === r.rider_id ? "secondary" : "ghost"}
                      onClick={() =>
                        setSelected((current) => (current === r.rider_id ? null : r.rider_id))
                      }
                    >
                      {selected === r.rider_id ? "Hide" : "Shifts"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableScroll>
      </QueryState>

      <div className="mt-5 space-y-2">
        <p className="text-sm font-medium">Completed deliveries by distance and time</p>
        <p className="text-xs text-muted-foreground">
          Distance is measured between the property pickup point and where the delivery was
          confirmed. Rows say “Not measured” when the pickup point or the delivery location is
          missing — nothing is estimated.
        </p>
        <QueryState
          isLoading={routeLog.isLoading}
          error={routeLog.error}
          isEmpty={(routeLog.data ?? []).length === 0}
          empty="No completed delivery in the last 30 days."
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Rider</TableHead>
                  <TableHead>Zone</TableHead>
                  <TableHead>Delivered</TableHead>
                  <TableHead className="text-right">Distance</TableHead>
                  <TableHead className="text-right">Time</TableHead>
                  <TableHead className="text-right">Speed</TableHead>
                  <TableHead>Measured from</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(routeLog.data ?? []).map((row) => (
                  <TableRow key={row.order_id}>
                    <TableCell className="font-medium">{row.order_number ?? "—"}</TableCell>
                    <TableCell>{row.rider_name ?? "Unassigned"}</TableCell>
                    <TableCell>{row.zone_name ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {row.delivered_at ? shortDateTime(row.delivered_at) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.distance_km == null ? "Not measured" : `${row.distance_km} km`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{minutes(row.minutes)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.km_per_hour == null ? "—" : `${row.km_per_hour} km/h`}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {titleCase(row.distance_source.replace(/-/g, " "))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </div>

      {selectedRider ? (
        <div className="mt-5 space-y-2">
          <p className="text-sm font-medium">
            {selectedRider.display_name ?? "Rider"} — shift history
          </p>
          <QueryState
            isLoading={shifts.isLoading}
            error={shifts.error}
            isEmpty={riderShifts.length === 0}
            empty="No shift has been scheduled for this rider."
          >
            <TableScroll>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Starts</TableHead>
                    <TableHead>Ends</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {riderShifts.map((s) => (
                    <TableRow key={str(s["id"])}>
                      <TableCell className="whitespace-nowrap">
                        {shortDateTime(str(s["starts_at"]))}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {shortDateTime(str(s["ends_at"]))}
                      </TableCell>
                      <TableCell>
                        <StatusPill tone={shiftTone(str(s["status"], "scheduled"))}>
                          {titleCase(str(s["status"], "scheduled"))}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {str(s["notes"], "—")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableScroll>
          </QueryState>
        </div>
      ) : null}
    </SectionCard>
  );
}
