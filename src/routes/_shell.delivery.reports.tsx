import { useState } from "react";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { createFileRoute } from "@tanstack/react-router";
import { Atomic, PageHeader, SectionCard, TableScroll } from "@/components/common/DataDisplay";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DeliveryGuard, EmptyState, QueryState } from "@/components/delivery/DeliveryGuard";
import { formatMoney } from "@/lib/inventory";
import {
  metricGroup,
  num,
  str,
  useDeliveryDepartmentMetrics,
  useDeliveryRiderPerformance,
  type DeliveryRow,
} from "@/lib/delivery-department";

export const Route = createFileRoute("/_shell/delivery/reports")({
  head: () => ({
    meta: [
      { title: "Delivery Department Reports — NEØ" },
      {
        name: "description",
        content:
          "Delivery volume, on-time performance, cash-on-delivery exposure and rider utilisation for the selected property and period.",
      },
      { property: "og:title", content: "Delivery Department Reports — NEØ" },
      {
        property: "og:description",
        content:
          "Department performance for Delivery: volume, on-time rate, COD exposure and rider utilisation.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <DeliveryGuard action="reports.view">
      <DeliveryReportsPage />
    </DeliveryGuard>
  ),
});

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function monthStart() {
  const d = new Date();
  d.setDate(1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

/**
 * A database capability refusal (PostgREST surfaces PostgreSQL 42501 as
 * "insufficient_privilege" / "permission denied"). Treated as a scope boundary
 * rather than a fault so one gated sub-query cannot break the whole report.
 */
export function isPermissionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /insufficient_privilege|permission denied|not permitted|42501/i.test(message);
}

/** `null` means the source has no value for this period — never render a zero. */
function optional(value: unknown, render: (n: number) => string) {
  if (value === null || value === undefined || value === "") return "Awaiting data";
  const n = Number(value);
  return Number.isFinite(n) ? render(n) : "Awaiting data";
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <SectionCard title={label}>
      <p className="neo-metric-value-lead">
        <Atomic>{value}</Atomic>
      </p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </SectionCard>
  );
}

function DeliveryReportsPage() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const metrics = useDeliveryDepartmentMetrics(from, to);
  const riders = useDeliveryRiderPerformance(from, to);

  const data = metrics.data as DeliveryRow | undefined;
  const volume = metricGroup(data, "volume");
  const service = metricGroup(data, "service");
  const payments = metricGroup(data, "payments");
  const riderCounts = metricGroup(data, "riders");
  const exceptions = metricGroup(data, "exceptions");

  const riderRows = (riders.data ?? []) as DeliveryRow[];
  const hasActivity = num(volume["total"]) > 0 || num(riderCounts["total"]) > 0;

  // `neo_delivery_rider_performance` gates on delivery dispatch/rider access,
  // which is narrower than the `delivery.reports.view` gate on this page. A
  // reports-only viewer therefore gets a 42501 back from that one query — it is
  // a scope boundary, not a broken report, so the page keeps its totals and
  // explains the gap instead of showing a failure.
  const riderDenied = isPermissionError(riders.error);

  return (
    <div>
      <PageHeader
        eyebrow="Delivery Department"
        title="Department Reports"
        description="Everything here is read from live delivery records for the property you have selected. Nothing is estimated."
      />

      <div className="mb-6 flex flex-wrap items-end gap-4">
        <div className="min-w-0">
          <Label htmlFor="from">From</Label>
          <NeoDatePicker
            id="from"
            value={from}
            onChange={setFrom}
            className="w-44 max-w-full"
            quick={["today", "this-week", "next-7", "this-month"]}
          />
        </div>
        <div className="min-w-0">
          <Label htmlFor="to">To</Label>
          <NeoDatePicker
            id="to"
            value={to}
            onChange={setTo}
            className="w-44 max-w-full"
            quick={["today", "this-week", "next-7", "this-month"]}
          />
        </div>
      </div>

      <QueryState
        isLoading={metrics.isLoading}
        error={metrics.error}
        isEmpty={!metrics.isLoading && !hasActivity}
        empty={
          <EmptyState
            title="Awaiting Data"
            description="No delivery activity has been recorded for this property in the selected period."
          />
        }
      >
        <div className="neo-kpi-grid">
          <Metric
            label="Orders"
            value={String(num(volume["total"]))}
            hint={`${num(volume["today"])} today`}
          />
          <Metric
            label="Delivered"
            value={String(num(volume["delivered"]))}
            hint={`${num(volume["cancelled"])} cancelled · ${num(volume["failed"])} failed`}
          />
          <Metric
            label="On-time rate"
            value={optional(service["on_time_rate"], (n) => `${n.toFixed(1)}%`)}
          />
          <Metric
            label="Avg delivery time"
            value={optional(service["avg_delivery_minutes"], (n) => `${n.toFixed(0)} min`)}
          />
          <Metric label="Delivered revenue" value={formatMoney(num(service["revenue"]))} />
          <Metric
            label="Cash on delivery"
            value={formatMoney(num(payments["cod_value"]))}
            hint={`${num(payments["cod_orders"])} cash order(s) · ${num(payments["unpaid"])} unpaid`}
          />
          <Metric
            label="Active riders"
            value={String(num(riderCounts["total"]))}
            hint={`${num(riderCounts["available"])} available · ${num(riderCounts["on_delivery"])} on delivery`}
          />
          <Metric
            label="Open exceptions"
            value={String(num(exceptions["open_issues"]))}
            hint={`${num(exceptions["supply_requests_pending"])} supply · ${num(exceptions["maintenance_open"])} maintenance`}
          />
        </div>

        <div className="mt-6">
          <SectionCard
            title="Rider performance"
            description="Per-rider volume, on-time delivery and cash held for the period."
          >
            <QueryState
              isLoading={riders.isLoading}
              error={riderDenied ? null : riders.error}
              isEmpty={riderDenied || riderRows.length === 0}
              empty={
                riderDenied ? (
                  <EmptyState
                    title="Rider detail not available"
                    description="Your access covers delivery reporting totals but not the per-rider ledger. Ask an administrator for delivery dispatch or rider access to see this breakdown."
                  />
                ) : (
                  <EmptyState
                    title="Awaiting Data"
                    description="No rider activity in this period."
                  />
                )
              }
            >
              <TableScroll>
                <Table className="neo-list-rows">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="neo-sticky-col">Rider</TableHead>
                      <TableHead className="text-right">Assigned</TableHead>
                      <TableHead className="text-right">Delivered</TableHead>
                      <TableHead className="text-right">On time</TableHead>
                      <TableHead className="text-right">Avg minutes</TableHead>
                      <TableHead className="text-right">Cash collected</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {riderRows.map((r, i) => (
                      <TableRow key={String(r["rider_id"] ?? i)}>
                        <TableCell className="neo-sticky-col whitespace-nowrap font-medium">
                          {str(r["display_name"] ?? r["rider_code"])}
                        </TableCell>
                        <TableCell className="text-right">
                          <Atomic>{num(r["assigned"])}</Atomic>
                        </TableCell>
                        <TableCell className="text-right">
                          <Atomic>{num(r["delivered"])}</Atomic>
                        </TableCell>
                        <TableCell className="text-right">
                          <Atomic>{optional(r["on_time_rate"], (n) => `${n.toFixed(1)}%`)}</Atomic>
                        </TableCell>
                        <TableCell className="text-right">
                          <Atomic>
                            {optional(r["avg_delivery_minutes"], (n) => n.toFixed(0))}
                          </Atomic>
                        </TableCell>
                        <TableCell className="text-right">
                          <Atomic>{formatMoney(num(r["cash_collected"]))}</Atomic>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            </QueryState>
          </SectionCard>
        </div>
      </QueryState>
    </div>
  );
}
