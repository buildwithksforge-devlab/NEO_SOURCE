import { useMemo, useState } from "react";
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
import { usePosOrders } from "@/lib/pos-data";
import { NeoDatePicker } from "@/components/common/DatePicker";
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
      { title: "POS Reports — NEØ" },
      {
        name: "description",
        content:
          "Sales by outlet, order type and payment method, calculated only from finalised transactions.",
      },
      { property: "og:title", content: "POS Reports — NEØ" },
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

function ReportsPage() {
  const navigate = useNavigate();
  const orders = usePosOrders("closed");
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);

  const period = { from, to };
  const previous = previousPeriod(period);

  const all = (orders.data ?? []) as unknown as SalesRow[];

  const inRange = (window: { from: string; to: string } | null) => {
    if (!window) return [] as SalesRow[];
    const start = new Date(`${window.from}T00:00:00`);
    const end = new Date(`${window.to}T23:59:59`);
    return all.filter((o) => {
      const d = new Date(o.closed_at ?? o.created_at);
      return d >= start && d <= end && !["voided", "cancelled"].includes(o.status);
    });
  };

  const rows = useMemo(() => inRange(period), [all, from, to]);
  const priorRows = useMemo(() => inRange(previous), [all, from, to]);

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

  const exceptions = useMemo(() => collectExceptions(rows, EXCEPTION_RULES), [rows]);

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
          <ReportExportButton
            rows={rows}
            columns={columns}
            onScreenTotals={{ total: revenue }}
            filename={`pos-sales-${from}-to-${to}.csv`}
          />
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
            label: "Revenue",
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
                  <TableHead className="text-right">Revenue</TableHead>
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

      <SectionCard
        className="mt-6"
        title="Source bills"
        description="The exact records the figures above are built from — open any of them to verify."
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
                {rows.slice(0, 100).map((o) => (
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
        </QueryState>
      </SectionCard>
    </div>
  );
}
