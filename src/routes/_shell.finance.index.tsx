import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, Sparkles } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Tooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AXIS_PROPS,
  BAR_PROPS,
  chartSeriesColor,
  ChartCard,
  GRID_PROPS,
  TOOLTIP_PROPS,
} from "@/components/charts/ChartKit";
import {
  DataTable,
  FinanceEmpty,
  FinanceGuard,
  FinanceQueryState,
  FinStatus,
  financeHead,
} from "@/components/finance/FinanceShared";
import {
  FactReconciliation,
  FactSection,
  SHARED_FACT_PATHS,
} from "@/components/common/FactSection";
import { ReconciliationStatusPanel } from "@/components/finance/ReconciliationStatus";
import {
  CardBoard,
  NeoCard,
  NeoCardActions,
  NeoCardBody,
  NeoCardDescription,
  NeoCardFooter,
  NeoCardHeader,
  NeoCardMetric,
  NeoCardStatus,
  NeoCardTitle,
} from "@/components/common/CardSystem";
import { useFinanceExceptions, usePostingQueue } from "@/lib/finance-posting";
import { RevenueVariancePanel } from "@/components/finance/RevenueVariance";
import { useFinanceFactScope, useFinanceReadiness } from "@/lib/finance-data";
import {
  ageInvoices,
  AGEING_LABELS,
  dateTime,
  financeInsights,
  money,
  num,
  titleCase,
} from "@/lib/finance";
import {
  useAccounts,
  useFinanceMetrics,
  useFinancialAlerts,
  useInvoices,
  useOtaReceivables,
  useSeedFinanceDefaults,
} from "@/lib/finance-data";

export const Route = createFileRoute("/_shell/finance/")({
  head: financeHead(
    "Finance & Accounting",
    "Live revenue, receivables, payables, cash position and compliance status from the posted ledger.",
  ),
  component: () => (
    <FinanceGuard feature="dashboard" action="view">
      <FinanceOverview />
    </FinanceGuard>
  ),
});

function FinanceOverview() {
  const metrics = useFinanceMetrics();
  const invoices = useInvoices("all");
  const ota = useOtaReceivables();
  const alerts = useFinancialAlerts();
  const accounts = useAccounts();
  const seed = useSeedFinanceDefaults();
  const factScope = useFinanceFactScope();

  const m = metrics.data ?? {};
  const openInvoices = (invoices.data ?? []).filter((i) =>
    ["issued", "partially_paid", "overdue"].includes(String(i["status"])),
  );
  const buckets = ageInvoices(openInvoices);
  const insights = financeInsights({
    metrics: m,
    invoices: openInvoices,
    otaReceivables: ota.data ?? [],
  });
  const methods = (m["revenue_by_method"] ?? {}) as Record<string, number>;
  const readiness = useFinanceReadiness();
  const notSetUp = !accounts.isLoading && (accounts.data ?? []).length === 0;
  const ready = readiness.data ?? {};
  const blocking = (ready["blocking"] ?? []) as string[];
  const BLOCKING_COPY: Record<string, string> = {
    chart_of_accounts: "Chart of accounts",
    tax_codes: "Tax codes",
    financial_year: "Financial year",
    accounting_periods: "Accounting periods",
    open_period_today: "An open period covering today",
    payment_methods: "Payment methods",
  };
  const notOperational = !readiness.isLoading && ready["ready"] === false;

  const ageingChartData = (Object.keys(AGEING_LABELS) as (keyof typeof AGEING_LABELS)[]).map(
    (k) => ({ key: k, label: AGEING_LABELS[k], value: buckets[k] ?? 0 }),
  );
  const methodChartData = Object.entries(methods).map(([k, v]) => ({
    key: k,
    label: titleCase(k),
    value: v,
  }));

  // One register, three counters. The dashboard never counts exceptions of
  // its own — it reads exactly what /finance/posting and End of Day read.
  const exceptions = useFinanceExceptions(factScope);
  const postingQueue = usePostingQueue(factScope);
  const exceptionRows = exceptions.data ?? [];
  const blockedCount = exceptionRows.filter((r) => r.kind === "blocked").length;
  const failedCount = exceptionRows.filter((r) => r.kind === "failed").length;
  const readyCount = (postingQueue.data ?? []).filter((r) => r.eligible).length;

  const lead: SummaryFigure = {
    id: "revenue-today",
    label: "Revenue today",
    value: metrics.isLoading ? "…" : money(m["revenue_today"]),
    hint: "Posted revenue journals",
    tone: "success",
  };
  const figures: SummaryFigure[] = [
    {
      id: "revenue-period",
      label: "Revenue this period",
      value: metrics.isLoading ? "…" : money(m["revenue_period"]),
      hint: `YTD ${money(m["revenue_ytd"])}`,
    },
    {
      id: "ar-outstanding",
      label: "Receivables outstanding",
      value: metrics.isLoading ? "…" : money(m["ar_outstanding"]),
      hint: `${money(m["ar_overdue"])} overdue`,
      tone: "warning",
    },
    {
      id: "ap-outstanding",
      label: "Payables outstanding",
      value: metrics.isLoading ? "…" : money(m["ap_outstanding"]),
      hint: "Approved supplier invoices",
    },
    {
      id: "payments-period",
      label: "Payments collected",
      value: metrics.isLoading ? "…" : money(m["payments_period"]),
      hint: "Confirmed receipts this period",
      tone: "success",
    },
    {
      id: "folio-balances",
      label: "Open folio balances",
      value: metrics.isLoading ? "…" : money(m["folio_balances"]),
      hint: "In-house and open accounts",
    },
    {
      id: "unreconciled",
      label: "Unreconciled bank lines",
      value: metrics.isLoading ? "…" : String(num(m["unreconciled"])),
      hint:
        num(m["unreconciled"]) > 0
          ? "Awaiting matching — import the bank statement in Banking"
          : "Nothing awaiting matching",
      tone: num(m["unreconciled"]) > 0 ? "warning" : "success",
    },
    {
      id: "open-alerts",
      label: "Open financial alerts",
      value: metrics.isLoading ? "…" : String(num(m["open_alerts"])),
      hint: `${num(m["pending_approvals"])} pending approvals`,
      tone: "warning",
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Commercial"
        title="Finance & Accounting"
        description="Every figure below is derived from posted double-entry journals, issued invoices and confirmed payments. Nothing here is estimated."
        actions={
          m["period_status"] ? (
            <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs">
              <span className="text-muted-foreground">Current period</span>{" "}
              <span className="font-semibold">{titleCase(String(m["period_status"]))}</span>
            </div>
          ) : null
        }
      />

      {notSetUp ? (
        <SectionCard
          title="Finance is not configured yet"
          description="Create the chart of accounts, tax codes, financial year and accounting periods before posting."
        >
          <FinanceEmpty
            title="No chart of accounts"
            description="Seed the standard hospitality chart of accounts, VAT codes and monthly periods. You can rename, add or deactivate anything afterwards."
            action={
              <Button onClick={() => seed.mutate()} disabled={seed.isPending}>
                Set up finance defaults
              </Button>
            }
          />
        </SectionCard>
      ) : notOperational ? (
        <SectionCard
          title="Finance is not operational yet"
          description="Transactions cannot post until the workspace has a financial year, accounting periods, tax codes and payment methods in place."
        >
          <ul className="mb-3 list-disc pl-5 text-sm text-muted-foreground">
            {blocking.map((b) => (
              <li key={b}>{BLOCKING_COPY[b] ?? b} — missing</li>
            ))}
          </ul>
          <Button onClick={() => seed.mutate()} disabled={seed.isPending}>
            Complete finance setup
          </Button>
        </SectionCard>
      ) : null}

      <SummaryStrip
        lead={lead}
        figures={figures}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link to="/finance/queue">Cashier queue</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/finance/till">Cashier till</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/finance/sessions">Cashier sessions</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/finance/eod">End of day & night audit</Link>
            </Button>
          </>
        }
      />

      {/* Ready to post, blocked and failed are the same three numbers the
          posting screen, the reconciliation report and End of Day show — they
          are counted from one register, never recomputed per surface. */}
      <CardBoard columns={3} className="mb-4">
        <NeoCard tone="default">
          <NeoCardHeader>
            <NeoCardTitle hint="Eligible operational records">Ready to post</NeoCardTitle>
            <NeoCardStatus tone={readyCount > 0 ? "info" : "success"}>
              {readyCount > 0 ? "Waiting" : "Clear"}
            </NeoCardStatus>
          </NeoCardHeader>
          <NeoCardBody>
            <NeoCardMetric>{postingQueue.isLoading ? "…" : String(readyCount)}</NeoCardMetric>
            <NeoCardDescription>
              Finalised records that satisfy every eligibility rule and will post on the next run
              or at End of Day.
            </NeoCardDescription>
          </NeoCardBody>
          <NeoCardFooter>
            <span className="neo-line-1 text-xs text-muted-foreground">Posting queue</span>
            <NeoCardActions>
              <Button asChild size="sm" variant="outline">
                <Link to="/finance/queue">Open</Link>
              </Button>
            </NeoCardActions>
          </NeoCardFooter>
        </NeoCard>

        <NeoCard tone={blockedCount > 0 ? "warning" : "default"}>
          <NeoCardHeader>
            <NeoCardTitle hint="Held by an eligibility rule">Blocked</NeoCardTitle>
            <NeoCardStatus tone={blockedCount > 0 ? "warning" : "success"}>
              {blockedCount > 0 ? "Action needed" : "Clear"}
            </NeoCardStatus>
          </NeoCardHeader>
          <NeoCardBody>
            <NeoCardMetric>{exceptions.isLoading ? "…" : String(blockedCount)}</NeoCardMetric>
            <NeoCardDescription>
              Each item names the rule that holds it and the person responsible for clearing it at
              source.
            </NeoCardDescription>
          </NeoCardBody>
          <NeoCardFooter>
            <span className="neo-line-1 text-xs text-muted-foreground">Exception register</span>
            <NeoCardActions>
              <Button asChild size="sm" variant="outline">
                <Link to="/finance/posting" search={{ kind: "blocked", module: undefined }}>
                  Investigate
                </Link>
              </Button>
            </NeoCardActions>
          </NeoCardFooter>
        </NeoCard>

        <NeoCard tone={failedCount > 0 ? "destructive" : "default"}>
          <NeoCardHeader>
            <NeoCardTitle hint="Attempted and rejected">Failed</NeoCardTitle>
            <NeoCardStatus tone={failedCount > 0 ? "destructive" : "success"}>
              {failedCount > 0 ? "Retry required" : "Clear"}
            </NeoCardStatus>
          </NeoCardHeader>
          <NeoCardBody>
            <NeoCardMetric>{exceptions.isLoading ? "…" : String(failedCount)}</NeoCardMetric>
            <NeoCardDescription>
              Failed attempts are retained with their error so the retry is deliberate, never a
              silent second posting.
            </NeoCardDescription>
          </NeoCardBody>
          <NeoCardFooter>
            <span className="neo-line-1 text-xs text-muted-foreground">Exception register</span>
            <NeoCardActions>
              <Button asChild size="sm" variant="outline">
                <Link to="/finance/posting" search={{ kind: "failed", module: undefined }}>
                  Investigate
                </Link>
              </Button>
            </NeoCardActions>
          </NeoCardFooter>
        </NeoCard>
      </CardBoard>

      <Tabs defaultValue="ledger" className="w-full">
        <TabsList className="mb-3">
          <TabsTrigger value="ledger">Canonical ledger</TabsTrigger>
          <TabsTrigger value="cash-flow">Ageing & collections</TabsTrigger>
          <TabsTrigger value="advisory">Advisory & alerts</TabsTrigger>
        </TabsList>

        <TabsContent value="ledger" className="mt-0 space-y-4">
          <FactSection
            title="Canonical facts"
            description="Identical to the figures on the dashboards and /analytics — one scoped fact layer, one period, one currency."
            paths={SHARED_FACT_PATHS}
            scope={factScope}
            scopeLabel={factScope.branchId ? "Selected property" : "All authorised properties"}
          />

          <SectionCard
            title="Reconciliation"
            description="Operational eligible → posted → reversals → net recognised → collected → outstanding receivable, for the selected period and property."
          >
            <FactReconciliation scope={factScope} />
            <RevenueVariancePanel scope={factScope} />
            <ReconciliationStatusPanel scope={factScope} compact />
          </SectionCard>
        </TabsContent>

        <TabsContent value="cash-flow" className="mt-0">
          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard
              title="Receivables ageing"
              subtitle="Outstanding invoice balances by days past due"
              empty={!invoices.isLoading && openInvoices.length === 0}
              emptyTitle="No outstanding invoices"
              emptyDescription="Issued invoices with a balance will be aged here automatically."
              source="Invoices"
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={ageingChartData} margin={{ left: -18, right: 8, top: 6 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis dataKey="label" {...AXIS_PROPS} />
                  <YAxis {...AXIS_PROPS} width={48} />
                  <Tooltip {...TOOLTIP_PROPS} formatter={(v: number) => money(v)} />
                  <Bar dataKey="value" name="Balance" {...BAR_PROPS}>
                    {ageingChartData.map((d, i) => (
                      <Cell
                        key={d.key}
                        fill={
                          d.key === "over90" || d.key === "d90"
                            ? "var(--color-destructive)"
                            : chartSeriesColor(i)
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard
              title="Collections by payment method"
              subtitle="Confirmed receipts recorded in this period"
              empty={!metrics.isLoading && methodChartData.length === 0}
              emptyTitle="No payments recorded yet"
              emptyDescription="Payments captured in Front Office, POS or Finance appear here once confirmed."
              source="Confirmed payments"
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={methodChartData} margin={{ left: -18, right: 8, top: 6 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis dataKey="label" {...AXIS_PROPS} />
                  <YAxis {...AXIS_PROPS} width={48} />
                  <Tooltip {...TOOLTIP_PROPS} formatter={(v: number) => money(v)} />
                  <Bar dataKey="value" name="Amount" {...BAR_PROPS}>
                    {methodChartData.map((d, i) => (
                      <Cell key={d.key} fill={chartSeriesColor(i)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>
        </TabsContent>

        <TabsContent value="advisory" className="mt-0 space-y-4">
          <SectionCard
            title="AI finance advisory"
            description="Advisory only — the assistant never posts, approves or submits anything."
            actions={<Sparkles className="size-4 text-primary" />}
          >
            {insights.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No anomalies detected in receivables, collections, tax filing or reconciliation.
              </p>
            ) : (
              <ul className="space-y-3">
                {insights.map((i) => (
                  <li key={i.title} className="rounded-lg border border-border/70 p-3">
                    <div className="flex items-center gap-2">
                      <FinStatus
                        value={
                          i.tone === "destructive"
                            ? "failed"
                            : i.tone === "warning"
                              ? "pending"
                              : "submitted"
                        }
                      />
                      <p className="text-sm font-semibold">{i.title}</p>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{i.detail}</p>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            title="Financial alerts"
            description="Variances, limits and exceptions raised by the system."
            actions={<AlertTriangle className="size-4 text-warning" />}
          >
            <FinanceQueryState
              isLoading={alerts.isLoading}
              error={alerts.error}
              isEmpty={(alerts.data ?? []).length === 0}
              empty={
                <FinanceEmpty
                  title="No alerts"
                  description="Cash variances, credit limit breaches and failed submissions are raised here."
                />
              }
            >
              <DataTable head={["Raised", "Type", "Severity", "Message", "Amount", "Status"]}>
                {(alerts.data ?? []).map((a) => (
                  <tr key={String(a["id"])}>
                    <td className="py-2 pr-4 text-muted-foreground">{dateTime(a["created_at"])}</td>
                    <td className="py-2 pr-4">{titleCase(String(a["alert_type"]))}</td>
                    <td className="py-2 pr-4">{titleCase(String(a["severity"]))}</td>
                    <td className="py-2 pr-4">{String(a["message"] ?? a["title"] ?? "")}</td>
                    <td className="py-2 pr-4">{a["amount"] == null ? "—" : money(a["amount"])}</td>
                    <td className="py-2 pr-4">
                      <FinStatus value={String(a["status"])} />
                    </td>
                  </tr>
                ))}
              </DataTable>
            </FinanceQueryState>
          </SectionCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}
