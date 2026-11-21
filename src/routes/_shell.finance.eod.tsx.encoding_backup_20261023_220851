import { useEffect, useRef, useState } from "react";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { createFileRoute } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import { AlertTriangle, CalendarCheck, Lock, PlayCircle, Unlock } from "lucide-react";
import {
  PageHeader,
  SectionCard,
  StatCard,
  StatusPill,
  TableScroll,
} from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FinanceEmpty, FinanceQueryState, financeHead } from "@/components/finance/FinanceShared";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useBranchScope } from "@/lib/branches";
import { money, titleCase } from "@/lib/finance";
import {
  EXCEPTION_LABELS,
  useBusinessDays,
  useOpenBusinessDay,
  useCloseBusinessDay,
  useNightAuditExceptions,
  useNightAuditRuns,
  useRunNightAudit,
} from "@/lib/finance-controls";

export const Route = createFileRoute("/_shell/finance/eod")({
  head: financeHead(
    "End of Day & Night Audit",
    "The automated night audit verifies cashier sessions, unsettled bills, guest folio balances, finance postings and revenue against collections, then locks the business day once nothing is outstanding.",
  ),
  component: GuardedPage,
});

const today = () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

function EndOfDayPage() {
  const { can } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const { setActiveBranchId } = useBranchScope();
  const runs = useNightAuditRuns();
  const days = useBusinessDays();
  const runAudit = useRunNightAudit();
  const openDay = useOpenBusinessDay();
  const closeDay = useCloseBusinessDay();

  const [date, setDate] = useState(today());
  const manuallySelectedDate = useRef(false);
  const selectedProperty = useRef<string | null>(null);

  const openBusinessDate = (days.data ?? [])
    .find((day) => day.branch_id === branchId && day.status === "open")
    ?.business_date;

  useEffect(() => {
    if (!branchId) return;

    if (selectedProperty.current !== branchId) {
      selectedProperty.current = branchId;
      manuallySelectedDate.current = false;
    }

    if (!manuallySelectedDate.current && openBusinessDate) {
      setDate(openBusinessDate);
    }
  }, [branchId, openBusinessDate]);

  const selectBusinessDate = (value: string) => {
    manuallySelectedDate.current = true;
    setDate(value);
  };
  const [note, setNote] = useState("");
  const [selectedRun, setSelectedRun] = useState<string | null>(null);

  const rows = runs.data ?? [];
  // Everything on this page reads the audit run for the business date on
  // screen â€” not simply the most recent run â€” so the counters, the exception
  // table and the close control can never disagree with one another.
  const dateRun = rows.find((r) => r.business_date === date) ?? null;
  const latest = dateRun ?? rows[0] ?? null;

  const selectedRunRecord =
    selectedRun !== null
      ? rows.find((r) => r.id === selectedRun) ?? null
      : null;

  const displayedRun =
    selectedRunRecord &&
      selectedRunRecord.business_date === date &&
      (!branchId || selectedRunRecord.branch_id === branchId)
      ? selectedRunRecord
      : latest;

  const activeRun = displayedRun?.id ?? null;


  const exceptions = useNightAuditExceptions(activeRun);
  // The outstanding list is always about the date on screen, even when the
  // history table is showing an older run.
  const dateExceptions = useNightAuditExceptions(dateRun?.id ?? null);
  const mayClose = can("finance", "eod", "close_business_day");
  // Opening and closing are deliberately the same high-trust authority: the
  // person who controls the Finance business date controls both edges of it.
  const mayOpen = mayClose;
  const selectedDay = (days.data ?? []).find((d) => d.business_date === date);
  const otherOpenDay = (days.data ?? []).find(
    (d) => d.status === "open" && d.business_date !== date,
  );
  const isOpen = selectedDay?.status === "open";
  const isClosed = selectedDay?.status === "closed";

  const summary = (displayedRun?.summary ?? {}) as Record<string, unknown>;
  const num = (key: string) =>
    Number((summary[key] as number | undefined) ?? 0); const blockingOnDate = dateRun?.blocking_count ?? 0;

  const record: [string, string][] = displayedRun
    ? [
      ["Audit ID", displayedRun.run_reference ?? "Not numbered"],
      ["Business date", displayedRun.business_date],
      ["Operator", displayedRun.operator_name ?? "â€”"],
      ["Started", new Date(displayedRun.started_at).toLocaleString()],
      [
        "Finished",
        displayedRun.completed_at
          ? new Date(displayedRun.completed_at).toLocaleString()
          : "Running",
      ],
      ["Rooms revenue", money(num("rooms_revenue"))],
      ["Point of sale revenue", money(num("pos_revenue"))],
      ["Collections", money(num("collections"))],
      ["Till variance", money(num("till_variance"))],
      ["Outstanding folios", money(num("outstanding_balances"))],
      [
        "Unposted transactions",
        `${num("unposted_count")} Â· ${money(num("unposted_amount"))}`,
      ],
      ["Failed postings", String(num("failed_postings"))],
      ["Accounts payable", money(num("accounts_payable"))],
      ["Accounts receivable", money(num("accounts_receivable"))],
      ["Goods received not invoiced", money(num("grni_balance"))],
      ["Blocking exceptions", String(displayedRun.blocking_count)],
      ["Warnings", String(displayedRun.warning_count)],
      ["Stage", titleCase(displayedRun.stage)],
      ["Attempts", String(displayedRun.rerun_count + 1)],
      [
        "Signed result",
        displayedRun.result_digest
          ? displayedRun.result_digest.slice(0, 16) + "â€¦"
          : "Not signed",
      ],
      [
        "Outcome",
        displayedRun.status === "exception"
          ? "Exception"
          : titleCase(displayedRun.status),
      ],
    ]
    : [];

  // Everything standing between this date and a locked day, in the order it
  // has to be dealt with. Nothing here is inferred â€” each entry is a real
  // record state, a real permission or a real audit exception.
  const outstanding: { title: string; detail: string }[] = [];
  if (!branchId) {
    outstanding.push({
      title: "Select a property",
      detail: "The audit is always run for one property â€” choose it in the workspace bar.",
    });
  } else if (!selectedDay) {
    outstanding.push({
      title: `Open the business day for ${date}`,
      detail: otherOpenDay
        ? `${otherOpenDay.business_date} is already open. Close it before opening another business date.`
        : "Finance must explicitly open the property business date before transactions are audited or closed.",
    });
  } else if (isOpen && !dateRun) {
    outstanding.push({
      title: `Run the night audit for ${date}`,
      detail: "An open day cannot be closed until its signed night audit is complete.",
    });
  }
  if (!mayClose) {
    outstanding.push({
      title: "Closing authority not granted",
      detail:
        "You can run and review the audit. Closing needs the finance.eod.close_business_day permission.",
    });
  }
  for (const e of dateExceptions.data ?? []) {
    if (e.severity !== "blocking") continue;
    outstanding.push({
      title: EXCEPTION_LABELS[e.category] ?? titleCase(e.category),
      detail: `${e.detail}${e.reference ? ` Â· ${e.reference}` : ""}${e.amount === null ? "" : ` Â· ${money(e.amount)}`
        }`,
    });
  }
  const canOpen = Boolean(branchId) && mayOpen && !selectedDay && !otherOpenDay;
  const canClose =
    Boolean(branchId) && mayClose && isOpen && Boolean(dateRun) && blockingOnDate === 0;

  const byMethod = Object.entries(
    (summary["payments_by_method"] as Record<string, number> | undefined) ?? {},
  );
  const byModule = Object.entries(
    (summary["revenue_by_module"] as Record<string, number> | undefined) ?? {},
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Finance"
        title="End of Day & Night Audit"
        description="The night audit is a system routine, not a night shift. It verifies the day, reports every exception for Finance to investigate and never adjusts a figure to force a balance."
      />

      <div className="grid gap-4 sm:grid-cols-4">
        <StatCard
          label="Audit ID"
          value={latest?.run_reference ?? "Awaiting data"}
          hint={latest ? `${latest.business_date} Â· ${titleCase(latest.run_mode)}` : "No audit recorded"}
          icon={CalendarCheck}
        />
        <StatCard
          label="Blocking exceptions"
          value={latest ? String(latest.blocking_count) : "â€”"}
          tone={latest && latest.blocking_count > 0 ? "warning" : "default"}
          icon={AlertTriangle}
        />
        <StatCard label="Recorded revenue" value={money(num("pos_revenue"))} />
        <StatCard label="Collections" value={money(num("pos_collections"))} />
      </div>


      <SectionCard
        title="Run the audit and close the day"
        description="Closing is refused while blocking exceptions remain. Closing authority is a separate permission an administrator grants deliberately."
        icon={Lock}
        accent
      >
        {isClosed ? (
          /* A locked day says one thing, clearly, and offers nothing to press. */
          <div className="neo-tint-success flex min-w-0 flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:gap-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
              <Lock className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">
                {date} is closed and locked
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                The business day is final. Nothing further can be posted to it â€” corrections are
                made on an open date and referenced back to this one.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
            {/* Left: the day being closed, and the single closing action. */}
            <div className="min-w-0 space-y-4">
              <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                <div className="grid min-w-0 gap-1.5">
                  <Label htmlFor="eod-date">Business date</Label>
                  <NeoDatePicker id="eod-date" value={date} onChange={selectBusinessDate} />
                </div>
                <div className="grid min-w-0 gap-1.5">
                  <Label htmlFor="eod-note">{isOpen ? "Closing note (optional)" : "Opening note (optional)"}</Label>
                  <Input id="eod-note" value={note} onChange={(e) => setNote(e.target.value)} />
                </div>
              </div>

              <div className="flex min-w-0 flex-wrap items-center gap-3">
                {isOpen ? (
                  <Button
                    size="lg"
                    className="min-w-48"
                    disabled={!canClose || closeDay.isPending}
                    onClick={() => closeDay.mutate({ branch: branchId!, date, note })}
                  >
                    <Lock className="mr-2 size-4" />
                    {closeDay.isPending ? "Closingâ€¦" : `Close ${date}`}
                  </Button>
                ) : (
                  <Button
                    size="lg"
                    className="min-w-48"
                    disabled={!canOpen || openDay.isPending}
                    onClick={() => openDay.mutate({ branch: branchId!, date, note })}
                  >
                    <Unlock className="mr-2 size-4" />
                    {openDay.isPending ? "Openingâ€¦" : `Open ${date}`}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  disabled={!branchId || !isOpen || runAudit.isPending}
                  onClick={() => runAudit.mutate({ branch: branchId!, date })}
                >
                  <PlayCircle className="mr-2 size-4" />
                  {runAudit.isPending ? "Runningâ€¦" : dateRun ? "Re-run audit" : "Run audit"}
                </Button>
              </div>
            </div>

            {/* Right: exactly what is standing in the way, numbered. */}
            <div className="min-w-0">
              {outstanding.length === 0 ? (
                <div className="neo-tint-success h-full rounded-xl border p-4">
                  <p className="text-sm font-semibold text-foreground">Nothing outstanding</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Cashier sessions, bills, folios and postings all reconcile. {date} is open and ready to
                    close.
                  </p>
                </div>
              ) : (
                <div className="neo-tint-warning h-full rounded-xl border p-4">
                  <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <AlertTriangle className="size-4 text-warning" />
                    {outstanding.length} item{outstanding.length === 1 ? "" : "s"} before this day
                    can close
                  </p>
                  <ol className="mt-3 space-y-2.5">
                    {outstanding.map((item, index) => (
                      <li key={`${item.title}-${index}`} className="flex min-w-0 gap-2.5">
                        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-warning/20 text-[0.68rem] font-semibold text-on-tint-warning">
                          {index + 1}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-foreground">
                            {item.title}
                          </span>
                          <span className="neo-contain block text-xs text-muted-foreground">
                            {item.detail}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          </div>
        )}
      </SectionCard>


      <SectionCard
        title="Audit record"
        description="The persistent record of this run â€” it survives refresh and is retained with its identifier."
      >
        {latest ? (
          <>
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
              {record.map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3 border-b border-border/50 py-1">
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
                  <dd className="truncate text-sm font-medium" title={value}>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-sm font-semibold">Revenue by module</p>
                {byModule.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No revenue recorded on this date.</p>
                ) : (
                  <ul className="mt-1 space-y-1 text-sm">
                    {byModule.map(([k, v]) => (
                      <li key={k} className="flex justify-between gap-3">
                        <span className="text-muted-foreground">{titleCase(k)}</span>
                        <span>{money(Number(v))}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <p className="text-sm font-semibold">Payments by method</p>
                {byMethod.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No payments recorded on this date.</p>
                ) : (
                  <ul className="mt-1 space-y-1 text-sm">
                    {byMethod.map(([k, v]) => (
                      <li key={k} className="flex justify-between gap-3">
                        <span className="text-muted-foreground">{titleCase(k)}</span>
                        <span>{money(Number(v))}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        ) : (
          <FinanceEmpty
            title="No audit recorded"
            description="Run the night audit for the selected property and business date."
          />
        )}
      </SectionCard>


      <SectionCard
        title="Exceptions"
        description="Blocking items must be resolved at source before the day can close. Warnings are reviewed and explained."
      >
        <FinanceQueryState
          isLoading={exceptions.isLoading}
          error={exceptions.error}
          isEmpty={(exceptions.data ?? []).length === 0}
          empty={
            <FinanceEmpty
              title={activeRun ? "No exceptions on this run" : "No audit has been run yet"}
              description={
                activeRun
                  ? "Cashier sessions, bills, folios, postings and approvals all reconciled."
                  : "Run the night audit for the selected property and business date."
              }
            />
          }
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Severity</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Detail</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(exceptions.data ?? []).map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>
                      <StatusPill tone={e.severity === "blocking" ? "destructive" : "warning"}>
                        {titleCase(e.severity)}
                      </StatusPill>
                    </TableCell>
                    <TableCell>{EXCEPTION_LABELS[e.category] ?? titleCase(e.category)}</TableCell>
                    <TableCell className="font-mono text-xs">{e.reference ?? "â€”"}</TableCell>
                    <TableCell className="text-muted-foreground">{e.detail}</TableCell>
                    <TableCell className="text-right">
                      {e.amount === null ? "â€”" : money(e.amount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </FinanceQueryState>
      </SectionCard>

      <SectionCard
        title="Audit history"
        description="Every run is retained with its result and counts."
      >
        <FinanceQueryState
          isLoading={runs.isLoading}
          error={runs.error}
          isEmpty={rows.length === 0}
          empty={
            <FinanceEmpty
              title="No audit history"
              description="Completed night audits appear here with their exception counts."
            />
          }
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Business date</TableHead>
                  <TableHead>Run</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="text-right">Blocking</TableHead>
                  <TableHead className="text-right">Warnings</TableHead>
                  <TableHead className="text-right">Exceptions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.business_date}</TableCell>
                    <TableCell>{new Date(r.started_at).toLocaleString()}</TableCell>
                    <TableCell>
                      <StatusPill tone={r.status === "exception" || r.status === "failed" ? "destructive" : "success"}>
                        {r.status === "exception" ? "Exception" : titleCase(r.status)}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="text-right">{r.blocking_count}</TableCell>
                    <TableCell className="text-right">{r.warning_count}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setActiveBranchId(r.branch_id);
                          setDate(r.business_date);
                          setSelectedRun(r.id);
                        }}
                      >
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </FinanceQueryState>
      </SectionCard>
    </div>
  );
}

// Money and customer records: the screen asks for the capability its route
// declares, so the menu and the page can never disagree.
function GuardedPage() {
  return (
    <OpsGuard path="/finance/eod">
      <EndOfDayPage />
    </OpsGuard>
  );
}
