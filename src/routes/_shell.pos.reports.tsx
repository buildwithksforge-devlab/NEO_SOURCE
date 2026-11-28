import { PosHandoffRecoveryCard } from "../components/pos/PosHandoffRecoveryCard";

const neoHandoffRpc = async (
  name: string,
  args: Record<string, unknown>
): Promise<{
  data: unknown;
  error: { message: string } | null;
}> => {
  const result = await supabase.rpc(
    name as never,
    args as never
  );

  return {
    data: result.data,
    error: result.error
      ? { message: result.error.message }
      : null,
  };
};

import { supabase } from "@/integrations/supabase/client";
import { PosConsumptionExceptionCard } from "@/components/pos/PosConsumptionExceptionCard";
import { kenyaBusinessDate } from "@/lib/kenya-business-date";
import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageHeader, SectionCard, TableScroll } from "@/components/common/DataDisplay";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, PosGuard, QueryState } from "@/components/pos/PosShared";
import { money, titleCase } from "@/lib/pos";
import {
  usePosCompletePeriodOrders,
  useTeamPosPerformance,
  usePosStaffDisplayNames,
} from "@/lib/pos-data";

import {
  unusualPosBillIds,
} from "@/lib/pos-reporting-anomalies";

import {
  posReportingErrorMessage,
} from "@/lib/pos-reporting-errors";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { PosCollectionEvidenceCard } from "@/components/pos/PosCollectionEvidenceCard";
import { PosFullPeriodFinancialCard } from "@/components/pos/PosFullPeriodFinancialCard";
import { PosFinanceReconciliationCard } from "@/components/pos/PosFinanceReconciliationCard";

import {
  ReportExceptions,
  ReportExportButton,
  ReportKpiGrid,
  ReportPeriodNote,
} from "@/components/common/ReportWorkspace";
import {
  collectExceptions,
  compare,
  previousPeriod,
  type ReportColumn,
  type ExceptionRule,
} from "@/lib/reporting-standard";

export const Route = createFileRoute("/_shell/pos/reports")({
  head: () => ({
    meta: [
      { title: "POS Reports â€” NEÃ˜" },
      {
        name: "description",
        content:
          "Sales by outlet, order type and payment method, calculated only from finalised transactions.",
      },
      { property: "og:title", content: "POS Reports â€” NEÃ˜" },
      {
        property: "og:description",
        content:
          "Sales by outlet, order type and payment method, calculated only from finalised transactions.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PosGuard action="reports.view" path="/pos/reports">
      <ReportsPage />
    </PosGuard>
  ),
});

type SalesRow = {
  id: string;
  order_number: string;
  order_type: string;
  status: string;
  closed_at: string | null;
  created_at: string;
  grand_total: number | null;
  discount_total?: number | null;
  subtotal?: number | null;
};

const EXCEPTION_RULES: ExceptionRule<SalesRow>[] = [
  {
    id: "zero-value",
    severity: "high",
    when: (o) => Number(o.grand_total ?? 0) <= 0,
    title: (o) => `Bill ${o.order_number} closed with no value`,
    detail: () => "A finalised bill with a zero total usually means an unsettled or mis-keyed order.",
    recordId: (o) => o.id,
  },
  {
    id: "heavy-discount",
    severity: "medium",
    when: (o) => {
      const sub = Number(o.subtotal ?? 0);
      const disc = Number(o.discount_total ?? 0);
      return sub > 0 && disc / sub > 0.15;
    },
    title: (o) => `Bill ${o.order_number} discounted above 15%`,
    detail: (o) => `Discount of ${money(Number(o.discount_total ?? 0))} against a ${money(Number(o.subtotal ?? 0))} subtotal.`,
    recordId: (o) => o.id,
  },
];


function TeamPosPerformanceCard({
  from,
  to,
}: {
  from: string;
  to: string;
}) {
  const performance = useTeamPosPerformance(from, to);

  const rows = performance.data ?? [];

  const staffNames = usePosStaffDisplayNames(
    rows.map((row) => row.profile_id),
  );

  const amount = (value: number | string | null | undefined) =>
    Number(value ?? 0);

  const total = rows.reduce(
    (sum, row) => sum + amount(row.finalized_bill_value),
    0,
  );

  return (
    <SectionCard
      title="Employee Sales Activity"
      description="Property-scoped employee POS activity. Figures are finalized bill values, not reconciled revenue or award rankings."
    >
      {performance.isLoading ? (
        <p className="text-sm text-muted-foreground">
          Loading employee performance...
        </p>
      ) : performance.error ? (
        <p role="alert" className="text-sm text-destructive">
          Employee performance is unavailable:{" "}
          {posReportingErrorMessage(performance.error)}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No employee POS activity was found for this reporting period.
        </p>
      ) : (
        <>
          <div className="mb-4 rounded-lg border p-4">
            <p className="text-sm text-muted-foreground">
              Finalized bill value attributed to original creators
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {money(total)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              This is an operational attribution total, not an
              official Finance revenue figure.
            </p>
          </div>

          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead className="text-right">
                    Created
                  </TableHead>
                  <TableHead className="text-right">
                    Assigned
                  </TableHead>
                  <TableHead className="text-right">
                    Finalized
                  </TableHead>
                  <TableHead className="text-right">
                    Cancelled
                  </TableHead>
                  <TableHead className="text-right">
                    Voided
                  </TableHead>
                  <TableHead className="text-right">
                    Average bill
                  </TableHead>
                  <TableHead className="text-right">
                    Finalized value
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const finalized = amount(
                    row.created_orders_finalized,
                  );
                  const value = amount(
                    row.finalized_bill_value,
                  );

                  return (
                    <TableRow key={row.profile_id}>
                      <TableCell className="font-mono text-xs">
                        {staffNames.data?.[row.profile_id] ??
                          `Staff ${row.profile_id.slice(0, 8)}`}
                      </TableCell>
                      <TableCell className="text-right">
                        {amount(row.orders_created)}
                      </TableCell>
                      <TableCell className="text-right">
                        {amount(row.orders_currently_assigned)}
                      </TableCell>
                      <TableCell className="text-right">
                        {finalized}
                      </TableCell>
                      <TableCell className="text-right">
                        {amount(row.created_orders_cancelled)}
                      </TableCell>
                      <TableCell className="text-right">
                        {amount(row.created_orders_voided)}
                      </TableCell>
                      <TableCell className="text-right">
                        {money(
                          finalized > 0 ? value / finalized : 0,
                        )}
                      </TableCell>
                      <TableCell className="text-right font-semibold">
                        {money(value)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableScroll>

          <p className="mt-3 text-xs text-muted-foreground">
            Employee names are resolved from authorized profiles.
            If a profile is not visible under database permissions,
            its shortened identifier is shown instead.
            Figures are operational activity, not certified revenue.
          </p>
        </>
      )}
    </SectionCard>
  );
}

function ReportsPage() {
  const navigate = useNavigate();
  const today = kenyaBusinessDate();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [sourcePage, setSourcePage] = useState(0);

  useEffect(() => {
    setSourcePage(0);
  }, [from, to]);

  const period = { from, to };
  const previous = previousPeriod(period);

  const orders = usePosCompletePeriodOrders(
    from,
    to,
    previous?.from ?? from,
    previous?.to ?? to,
  );

  const all = (orders.data ?? []) as unknown as SalesRow[];

  const inRange = (window: { from: string; to: string } | null) => {
    if (!window) return [] as SalesRow[];
    const start = new Date(`${window.from}T00:00:00+03:00`);

    const nextDay = new Date(
      Date.parse(`${window.to}T00:00:00Z`) +
      86400000,
    )
      .toISOString()
      .slice(0, 10);

    const end = new Date(`${nextDay}T00:00:00+03:00`);
    return all.filter((o) => {
      if (!o.closed_at) return false;

      const d = new Date(o.closed_at);

      return (
        d >= start &&
        d < end &&
        ["paid", "charged-to-room", "credit", "closed"]
          .includes(o.status)
      );
    });
  };

  const rows = useMemo(() => inRange(period), [all, from, to]);
  const priorRows = useMemo(() => inRange(previous), [all, from, to]);

  const sourcePageSize = 100;
  const sourcePageCount = Math.max(
    1,
    Math.ceil(rows.length / sourcePageSize),
  );

  const safeSourcePage = Math.min(
    sourcePage,
    sourcePageCount - 1,
  );

  const revenue = rows.reduce((s, o) => s + Number(o.grand_total ?? 0), 0);
  const priorRevenue = priorRows.reduce((s, o) => s + Number(o.grand_total ?? 0), 0);
  const average = rows.length ? revenue / rows.length : 0;
  const priorAverage = priorRows.length ? priorRevenue / priorRows.length : 0;

  const byType = new Map<string, { count: number; total: number }>();
  for (const o of rows) {
    const cur = byType.get(o.order_type) ?? { count: 0, total: 0 };
    byType.set(o.order_type, {
      count: cur.count + 1,
      total: cur.total + Number(o.grand_total ?? 0),
    });
  }

  const unusualBillIds = useMemo(
    () => unusualPosBillIds(rows),
    [rows],
  );

  const exceptions = useMemo(
    () =>
      collectExceptions(
        rows,
        [
          ...EXCEPTION_RULES,
          {
            id: "unusually-large-bill",
            severity: "high",
            when: (bill) => unusualBillIds.has(bill.id),
            title: (bill) =>
              `Unusually large bill ${bill.order_number}`,
            detail: (bill) =>
              `Finalized bill value ${money(
                Number(bill.grand_total ?? 0),
              )}. Review the source transaction; this flag does not establish fraud or an accounting error.`,
            recordId: (bill) => bill.id,
          },
        ] satisfies ExceptionRule<SalesRow>[],
      ),
    [rows, unusualBillIds],
  );

  const columns: ReportColumn<SalesRow>[] = [
    { key: "order", header: "Bill", value: (o) => o.order_number },
    { key: "type", header: "Order type", value: (o) => titleCase(o.order_type) },
    { key: "status", header: "Status", value: (o) => o.status },
    { key: "closed", header: "Closed at", value: (o) => o.closed_at ?? "" },
    { key: "total", header: "Total", value: (o) => Number(o.grand_total ?? 0), total: true },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Restaurant & POS"
        title="POS Reports"
        description="Figures come only from finalised bills. Open orders are deliberately excluded so nothing is counted before it is real."
        actions={
          orders.isSuccess ? (
          <ReportExportButton
            rows={rows}
            columns={columns}
            onScreenTotals={{ total: revenue }}
            filename={`pos-sales-${from}-to-${to}.csv`}
          />
          ) : null
        }
      />

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="from">From</Label>
          <NeoDatePicker id="from" value={from} onChange={setFrom} quick={["today", "this-week", "next-7", "this-month"]} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="to">To</Label>
          <NeoDatePicker id="to" value={to} onChange={setTo} quick={["today", "this-week", "next-7", "this-month"]} />
        </div>
        <ReportPeriodNote period={period} previous={previous} />
      </div>

      <div className="mb-6">
        <PosFullPeriodFinancialCard from={from} to={to} />
<PosFinanceReconciliationCard from={from} to={to} />
        <div className="mt-4">
          <TeamPosPerformanceCard from={from} to={to} />
        </div>
        <div className="mt-4">
          <PosCollectionEvidenceCard from={from} to={to} />

          {/* Production handoff recovery and investigation */}
          <PosHandoffRecoveryCard
            callRpc={neoHandoffRpc}
          />
        <div className="mt-6">
          <PosConsumptionExceptionCard />
        </div>
        </div>
      </div>

      {!orders.isSuccess && (
        <div
          role="status"
          className="mb-4 rounded-lg border p-4 text-sm"
        >
          {orders.isError
            ? "The complete reporting period could not be retrieved. Figures and exports must not be treated as complete. Please retry or choose a shorter period."
            : "Retrieving all authorized POS orders for the selected and comparison periods. Totals will appear after the complete query finishes."}
        </div>
      )}

      {orders.isSuccess && (
      <ReportKpiGrid
        className="mb-6"
        kpis={[
          {
            id: "bills",
            label: "Finalised bills",
            value: String(rows.length),
            comparison: compare(rows.length, priorRows.length),
            unit: "bills",
          },
          {
            id: "revenue",
            label: "Finalized bill value",
            value: money(revenue),
            comparison: compare(revenue, priorRevenue),
          },
          {
            id: "average",
            label: "Average bill",
            value: money(average),
            comparison: compare(Math.round(average), Math.round(priorAverage)),
          },
          {
            id: "exceptions",
            label: "Exceptions",
            value: String(exceptions.length),
            hint: "Bills needing a second look",
          },
        ]}
      />
      )}

      {orders.isSuccess && (
      <SectionCard
        title="Exceptions"
        description="Listed individually so nothing hides inside an average. Each one opens its source bill."
        className="mb-6"
      >
        <ReportExceptions
          exceptions={exceptions}
          onOpenRecord={(id) => void navigate({ to: "/pos/orders/$id", params: { id } })}
        />
      </SectionCard>
      )}

      {orders.isSuccess && (
      <SectionCard
        title="Sales by order type"
        description="Dine-in, takeaway, room service, delivery and catering."
      >
        <QueryState
          isLoading={orders.isLoading}
          error={orders.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No finalised sales in this period"
              description="Pick another date range, or settle some bills first."
            />
          }
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order type</TableHead>
                  <TableHead>Bills</TableHead>
                  <TableHead className="text-right">Finalized bill value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...byType.entries()].map(([type, v]) => (
                  <TableRow key={type}>
                    <TableCell>{titleCase(type)}</TableCell>
                    <TableCell>{v.count}</TableCell>
                    <TableCell className="text-right">{money(v.total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </SectionCard>
      )}

      <SectionCard
        className="mt-6"
        title="Source bills"
        description="The exact records the figures above are built from â€” open any of them to verify."
      >
        <QueryState
          isLoading={orders.isLoading}
          error={orders.error}
          isEmpty={rows.length === 0}
          empty={<EmptyState title="Nothing to drill into" description="No finalised bill in this period." />}
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Bill</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Closed</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.slice(
                   safeSourcePage * sourcePageSize,
                   (safeSourcePage + 1) * sourcePageSize,
                 ).map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="font-medium">{o.order_number}</TableCell>
                    <TableCell>{titleCase(o.order_type)}</TableCell>
                    <TableCell>{(o.closed_at ?? o.created_at).slice(0, 16).replace("T", " ")}</TableCell>
                    <TableCell className="text-right">{money(Number(o.grand_total ?? 0))}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void navigate({ to: "/pos/orders/$id", params: { id: o.id } })}
                      >
                        Open
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>

          {orders.isSuccess && rows.length > sourcePageSize && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                Showing{" "}
                {safeSourcePage * sourcePageSize + 1}
                {" - "}
                {Math.min(
                  (safeSourcePage + 1) * sourcePageSize,
                  rows.length,
                )}
                {" of "}
                {rows.length} finalized bills
              </p>

              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={safeSourcePage === 0}
                  onClick={() =>
                    setSourcePage((page) =>
                      Math.max(0, page - 1),
                    )
                  }
                >
                  Previous
                </Button>

                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    safeSourcePage + 1 >= sourcePageCount
                  }
                  onClick={() =>
                    setSourcePage((page) => page + 1)
                  }
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </QueryState>
      </SectionCard>
    </div>
  );
}
