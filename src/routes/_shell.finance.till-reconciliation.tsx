/**
 * Daily till reconciliation.
 *
 * Read-only. It runs `public.neo_till_reconciliation` for one property and one
 * day, and shows the day's orders, payments, receipts, cashier sessions, rider
 * cash, ledger entries and stock consumption side by side, with the matches
 * between them. Nothing on this page writes.
 */
import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck } from "lucide-react";
import {
  PageHeader,
  SectionCard,
  StatCard,
  StatusPill,
  TableScroll,
} from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NeoDatePicker, toIso } from "@/components/common/DatePicker";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ErrorState, LoadingState } from "@/components/common/StateSystem";
import { FinanceEmpty, FinanceGuard, financeHead } from "@/components/finance/FinanceShared";
import { useFinanceFactScope } from "@/lib/finance-data";
import { money, titleCase } from "@/lib/finance";
import { guardedRpc } from "@/lib/rpc-guard";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_shell/finance/till-reconciliation")({
  head: financeHead(
    "Till reconciliation",
    "Match one day's till against the guest and restaurant orders it came from: payments, receipts, cashier sessions, rider cash, ledger entries and stock consumed.",
  ),
  component: () => (
    <FinanceGuard feature="reconciliation" action="view">
      <TillReconciliation />
    </FinanceGuard>
  ),
});

type Check = {
  key: string;
  label: string;
  left: number;
  right: number;
  difference: number;
  ok: boolean;
};

type Shift = {
  id: string;
  shift_number: string | null;
  status: string | null;
  opened_at: string | null;
  closed_at: string | null;
  opening_float: number | null;
  expected_cash: number | null;
  counted_cash: number | null;
  variance: number | null;
  variance_reason: string | null;
  cashier: string | null;
};

type Report = {
  branch_id: string;
  date: string;
  orders: {
    count?: number;
    gross?: number;
    paid?: number;
    tax?: number;
    service_charge?: number;
    discount?: number;
    by_source?: { source: string; count: number; gross: number }[];
  };
  payments: {
    methods: { method: string; count: number; amount: number }[];
    total: number;
    count: number;
    receipts: number;
    cash: number;
  };
  shifts: Shift[];
  rider_cash: { count: number; expected: number; collected: number; outstanding: number };
  unbilled_delivery: {
    count: number;
    value: number;
    orders: {
      id: string;
      order_number: string;
      subtotal: number;
      delivery_fee: number;
      grand_total: number;
      payment_method: string | null;
    }[];
  };
  journals: { count: number; posted: number; total_debit: number; total_credit: number };
  stock: { movements: number; value: number };
  checks: Check[];
  generated_at: string;
};

const COUNT_CHECKS = new Set([
  "payments_vs_receipts",
  "payments_vs_journals",
  "sales_vs_stock",
  "delivery_billed",
]);

function TillReconciliation() {
  const scope = useFinanceFactScope();
  const [date, setDate] = useState(toIso(new Date()));

  const report = useQuery({
    queryKey: ["finance", "till-reconciliation", scope.branchId ?? "none", date],
    enabled: Boolean(scope.branchId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_till_reconciliation", {
        _branch: scope.branchId,
        _date: date,
      });
      if (error) throw new Error(error.message);
      return data as unknown as Report;
    },
  });

  if (!scope.branchId) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Finance"
          title="Till reconciliation"
          description="Match one day's till against the orders it came from."
        />
        <FinanceEmpty
          title="Choose a property"
          description="A till belongs to one property. Select a property above to reconcile its day."
        />
      </div>
    );
  }

  const data = report.data;
  const breaks = (data?.checks ?? []).filter((c) => !c.ok);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Finance"
        title="Till reconciliation"
        description="One day, one property. Everything the day should have produced — payments, receipts, cashier counts, rider cash, ledger entries and stock consumed — read side by side. This page never changes a record."
        actions={
          <Button variant="outline" onClick={() => void report.refetch()} disabled={report.isFetching}>
            <RefreshCw className="mr-2 size-4" /> Refresh
          </Button>
        }
      />

      <SectionCard title="Business day" description="Pick the day to reconcile.">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="till-date">Date</Label>
            <NeoDatePicker id="till-date" value={date} onChange={(value) => setDate(value ?? "")} />
          </div>
        </div>
      </SectionCard>

      {report.isLoading ? (
        <LoadingState />
      ) : report.error ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} inline />
      ) : !data ? (
        <FinanceEmpty title="No reading" description="No reconciliation could be produced for this day." />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Orders taken" value={String(data.orders.count ?? 0)} hint={money(data.orders.gross ?? 0)} />
            <StatCard label="Payments" value={money(data.payments.total)} hint={`${data.payments.count} taken, ${data.payments.receipts} receipted`} />
            <StatCard label="Ledger posted" value={money(data.journals.total_credit)} hint={`${data.journals.posted} of ${data.journals.count} entries posted`} />
            <StatCard label="Stock consumed" value={money(data.stock.value)} hint={`${data.stock.movements} movements`} />
          </div>

          <SectionCard
            title="Does it match?"
            description="Each line compares two records that must agree. A difference is a real break to investigate, not a rounding note."
          >
            <TableScroll>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Match</TableHead>
                    <TableHead className="text-right">From orders / payments</TableHead>
                    <TableHead className="text-right">From the other record</TableHead>
                    <TableHead className="text-right">Difference</TableHead>
                    <TableHead>Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.checks.map((c) => {
                    const asCount = COUNT_CHECKS.has(c.key);
                    const fmt = (n: number) => (asCount ? String(n) : money(n));
                    return (
                      <TableRow key={c.key}>
                        <TableCell>{c.label}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(c.left)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(c.right)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmt(c.difference)}</TableCell>
                        <TableCell>
                          <StatusPill tone={c.ok ? "success" : "destructive"}>
                            {c.ok ? (
                              <span className="flex items-center gap-1">
                                <CheckCircle2 className="size-3.5" /> Matches
                              </span>
                            ) : (
                              <span className="flex items-center gap-1">
                                <AlertTriangle className="size-3.5" /> Does not match
                              </span>
                            )}
                          </StatusPill>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableScroll>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <Link to="/finance/till">Close the till and declare counted cash</Link>
              </Button>
              <Button asChild variant="ghost" size="sm">
                <Link to="/finance/commerce-check">Open the commerce check</Link>
              </Button>
            </div>
            {breaks.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Everything agrees for this day.
              </p>
            ) : (
              <p className="mt-3 text-sm text-destructive">
                {breaks.length} of {data.checks.length} comparisons do not agree.
              </p>
            )}
          </SectionCard>

          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title="Payments by method" description="Completed payments taken on this day.">
              {data.payments.methods.length === 0 ? (
                <FinanceEmpty title="No payments" description="No completed payment was recorded on this day." />
              ) : (
                <TableScroll>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Method</TableHead>
                        <TableHead className="text-right">Count</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.payments.methods.map((m) => (
                        <TableRow key={m.method}>
                          <TableCell>{titleCase(m.method)}</TableCell>
                          <TableCell className="text-right">{m.count}</TableCell>
                          <TableCell className="text-right">{money(m.amount)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableScroll>
              )}
            </SectionCard>

            <SectionCard title="Where the orders came from" description="Restaurant, guest app and other channels.">
              {(data.orders.by_source ?? []).length === 0 ? (
                <FinanceEmpty title="No orders" description="No order was taken at this property on this day." />
              ) : (
                <TableScroll>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Channel</TableHead>
                        <TableHead className="text-right">Orders</TableHead>
                        <TableHead className="text-right">Value</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(data.orders.by_source ?? []).map((s) => (
                        <TableRow key={s.source}>
                          <TableCell>{titleCase(s.source)}</TableCell>
                          <TableCell className="text-right">{s.count}</TableCell>
                          <TableCell className="text-right">{money(s.gross)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableScroll>
              )}
            </SectionCard>
          </div>

          <SectionCard
            title="Cashier sessions"
            description="Float, expected cash, counted cash and the explained variance for every till opened on this day."
          >
            {data.shifts.length === 0 ? (
              <FinanceEmpty title="No till opened" description="No cashier session was opened at this property on this day." />
            ) : (
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Session</TableHead>
                      <TableHead>Cashier</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Float</TableHead>
                      <TableHead className="text-right">Expected</TableHead>
                      <TableHead className="text-right">Counted</TableHead>
                      <TableHead className="text-right">Variance</TableHead>
                      <TableHead>Explanation</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.shifts.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="font-mono text-xs">{s.shift_number ?? "—"}</TableCell>
                        <TableCell>{s.cashier ?? "—"}</TableCell>
                        <TableCell>
                          <StatusPill tone={s.status === "closed" ? "success" : "warning"}>
                            {titleCase(s.status ?? "open")}
                          </StatusPill>
                        </TableCell>
                        <TableCell className="text-right">{money(s.opening_float ?? 0)}</TableCell>
                        <TableCell className="text-right">{money(s.expected_cash ?? 0)}</TableCell>
                        <TableCell className="text-right">{s.counted_cash == null ? "—" : money(s.counted_cash)}</TableCell>
                        <TableCell className="text-right">{s.variance == null ? "—" : money(s.variance)}</TableCell>
                        <TableCell className="text-muted-foreground">{s.variance_reason ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            )}
          </SectionCard>

          {(data.unbilled_delivery?.count ?? 0) > 0 ? (
            <SectionCard
              title="Delivery money not yet in the ledger"
              description="These deliveries were handed over and paid, but no invoice was raised, so their items and delivery fee are missing from the day's revenue. Raise the invoice from the delivery queue."
            >
              <div className="space-y-2 text-sm">
                {data.unbilled_delivery.orders.map((o) => (
                  <div
                    key={o.id}
                    className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-border/60 px-3 py-2"
                  >
                    <span className="font-medium">{o.order_number}</span>
                    <span className="text-muted-foreground">
                      Items {money(o.subtotal)} · Delivery fee {money(o.delivery_fee)}
                    </span>
                    <span className="font-semibold">{money(o.grand_total)}</span>
                  </div>
                ))}
                <p className="text-muted-foreground">
                  Total waiting to be billed: {money(data.unbilled_delivery.value)}
                </p>
                <Button asChild variant="outline" size="sm">
                  <Link to="/delivery/queue">Open the delivery queue to bill these</Link>
                </Button>
              </div>
            </SectionCard>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-3">
            <SectionCard
              title="Rider cash"
              description="Cash collected on delivery for this day, counted into the till by the cashier."
            >
              <div className="space-y-1 text-sm">
                <p>Collections: {data.rider_cash.count}</p>
                <p>Expected: {money(data.rider_cash.expected)}</p>
                <p>Collected: {money(data.rider_cash.collected)}</p>
                <p className="text-muted-foreground">
                  Still held by riders: {money(data.rider_cash.outstanding)}
                </p>
              </div>
            </SectionCard>
            <SectionCard title="Ledger" description="Journal entries dated to this day.">
              <div className="space-y-1 text-sm">
                <p>Entries: {data.journals.count}</p>
                <p>Posted: {data.journals.posted}</p>
                <p>Debits: {money(data.journals.total_debit)}</p>
                <p>Credits: {money(data.journals.total_credit)}</p>
              </div>
            </SectionCard>
            <SectionCard title="Order totals" description="What the day's orders were made of.">
              <div className="space-y-1 text-sm">
                <p>Gross: {money(data.orders.gross ?? 0)}</p>
                <p>Settled on orders: {money(data.orders.paid ?? 0)}</p>
                <p>Tax: {money(data.orders.tax ?? 0)}</p>
                <p>Service charge: {money(data.orders.service_charge ?? 0)}</p>
                <p>Discounts: {money(data.orders.discount ?? 0)}</p>
              </div>
            </SectionCard>
          </div>

          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5" /> Read-only, for this property only. Generated{" "}
            {new Date(data.generated_at).toLocaleString()}.
          </p>
        </>
      )}
    </div>
  );
}
