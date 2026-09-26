/**
 * Revenue.
 *
 * Recognised revenue for the chosen dates, grouped by property and by the
 * module that earned it — rooms, point of sale, room charges, events,
 * delivery, deposits released to revenue. Every figure is a projection of the
 * very same `neo_general_ledger` rows the General Ledger page renders, so the
 * two can never disagree: this page filters the ledger to revenue accounts and
 * sums credits less debits. Nothing here recalculates a revenue figure from an
 * operational table.
 *
 * Beneath it, `neo_revenue_reconciliation` shows what each module took
 * operationally against what actually reached the ledger, so a gap is named
 * rather than hidden.
 */
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/DataDisplay";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import { Label } from "@/components/ui/label";
import {
  DataTable,
  FinanceEmpty,
  FinanceGuard,
  FinanceQueryState,
  financeHead,
} from "@/components/finance/FinanceShared";
import { money, titleCase } from "@/lib/finance";
import { useGeneralLedger, type GeneralLedgerLine } from "@/lib/finance-data";
import { useRevenueReconciliation } from "@/lib/finance-posting";
import { useActivePropertyFilter } from "@/lib/branch-filter";

export const Route = createFileRoute("/_shell/finance/revenue")({
  head: financeHead(
    "Revenue",
    "Recognised revenue by property and by source module — rooms, point of sale, room charges, events and deposits — reconciled against what each module took operationally.",
  ),
  component: () => (
    <FinanceGuard feature="dashboard" action="view">
      <RevenuePage />
    </FinanceGuard>
  ),
});

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** How a ledger source module reads to an operator. */
const MODULE_LABEL: Record<string, string> = {
  pms: "Rooms & stays",
  folio: "Room charges",
  folios: "Room charges",
  pos: "Point of sale",
  payments: "Guest payments",
  deposit: "Pre-arrival deposits",
  deposits: "Pre-arrival deposits",
  events: "Events & banqueting",
  delivery: "Delivery",
  laundry: "Guest laundry",
  inventory: "Inventory & stores",
  payables: "Supplier payments",
};

const label = (module: string | null | undefined) =>
  MODULE_LABEL[String(module ?? "")] ?? titleCase(String(module ?? "Other"));

/** A revenue line is a credit to an income account, net of any reversal. */
const isRevenue = (l: GeneralLedgerLine) =>
  ["income", "revenue"].includes(String(l.account_category ?? "").toLowerCase());

const netOf = (lines: GeneralLedgerLine[]) =>
  lines.reduce((s, l) => s + Number(l.credit ?? 0) - Number(l.debit ?? 0), 0);

function RevenuePage() {
  const { branchId } = useActivePropertyFilter();
  const now = new Date();
  const [from, setFrom] = useState(iso(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(iso(now));

  const ledger = useGeneralLedger(from, to);
  const reconciliation = useRevenueReconciliation({ branchId, from, to });

  const revenue = useMemo(() => (ledger.data ?? []).filter(isRevenue), [ledger.data]);
  const total = netOf(revenue);

  /** Property → module → amount, from the same rows the ledger shows. */
  const byProperty = useMemo(() => {
    const map = new Map<string, { property: string; total: number; modules: Map<string, number> }>();
    for (const l of revenue) {
      const key = l.property ?? "Unattributed";
      const entry = map.get(key) ?? { property: key, total: 0, modules: new Map() };
      const amount = Number(l.credit ?? 0) - Number(l.debit ?? 0);
      entry.total += amount;
      const m = label(l.source_module);
      entry.modules.set(m, (entry.modules.get(m) ?? 0) + amount);
      map.set(key, entry);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [revenue]);

  const byAccount = useMemo(() => {
    const map = new Map<string, { code: string; name: string; amount: number }>();
    for (const l of revenue) {
      const entry = map.get(l.account_id) ?? {
        code: l.account_code,
        name: l.account_name,
        amount: 0,
      };
      entry.amount += Number(l.credit ?? 0) - Number(l.debit ?? 0);
      map.set(l.account_id, entry);
    }
    return [...map.values()].sort((a, b) => b.amount - a.amount);
  }, [revenue]);

  const rows = reconciliation.data ?? [];
  const awaiting = rows.reduce((s, r) => s + Number(r.awaiting_amount ?? 0), 0);
  const unrecognised = rows.reduce(
    (s, r) => s + Number(r.blocked_amount ?? 0) + Number(r.failed_amount ?? 0),
    0,
  );

  const lead: SummaryFigure = {
    id: "recognised",
    label: "Recognised revenue",
    value: ledger.isLoading ? "…" : money(total),
    hint: "Credits to income accounts on the general ledger for these dates",
  };
  const figures: SummaryFigure[] = [
    {
      id: "properties",
      label: "Properties earning",
      value: ledger.isLoading ? "…" : byProperty.length,
    },
    {
      id: "awaiting",
      label: "Taken, not yet posted",
      value: reconciliation.isLoading ? "…" : money(awaiting),
      tone: awaiting > 0.009 ? "warning" : "success",
    },
    {
      id: "unrecognised",
      label: "Blocked or failed",
      value: reconciliation.isLoading ? "…" : money(unrecognised),
      tone: unrecognised > 0.009 ? "destructive" : "success",
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Finance"
        title="Revenue"
        description="What the business actually earned, by property and by the module that earned it. Every figure is the same ledger line the general ledger shows — this page never re-adds an operational total."
      />
      <SummaryStrip lead={lead} figures={figures} />

      <div className="grid gap-3 rounded-xl border border-border/70 bg-card p-4 sm:grid-cols-2 sm:max-w-xl">
        <div className="grid gap-1.5">
          <Label htmlFor="rev-from">From</Label>
          <NeoDatePicker id="rev-from" value={from} onChange={setFrom} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="rev-to">To</Label>
          <NeoDatePicker id="rev-to" value={to} onChange={setTo} />
        </div>
      </div>

      <div className="rounded-xl border border-border/70 bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">By property and source</h2>
        <FinanceQueryState
          isLoading={ledger.isLoading}
          error={ledger.error}
          isEmpty={byProperty.length === 0}
          empty={
            <FinanceEmpty
              title="No recognised revenue"
              description="Nothing has been posted to an income account for these dates. Anything taken operationally but not yet posted is listed in the reconciliation below."
            />
          }
        >
          <div className="space-y-5">
            {byProperty.map((p) => (
              <div key={p.property}>
                <div className="flex items-baseline justify-between border-b border-border/60 pb-1">
                  <h3 className="text-sm font-semibold">{p.property}</h3>
                  <span className="text-sm font-semibold tabular-nums">{money(p.total)}</span>
                </div>
                <DataTable unit="revenue sources" head={["Source", "Recognised", "Share"]}>
                  {[...p.modules.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([m, amount]) => (
                      <tr key={`${p.property}:${m}`}>
                        <td className="py-2 pr-4">{m}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{money(amount)}</td>
                        <td className="py-2 pr-4 text-right text-muted-foreground">
                          {p.total ? `${((amount / p.total) * 100).toFixed(1)}%` : "—"}
                        </td>
                      </tr>
                    ))}
                </DataTable>
              </div>
            ))}
          </div>
        </FinanceQueryState>
      </div>

      <div className="rounded-xl border border-border/70 bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold">By income account</h2>
        <FinanceQueryState
          isLoading={ledger.isLoading}
          error={ledger.error}
          isEmpty={byAccount.length === 0}
          empty={<FinanceEmpty title="No income accounts posted" description="" />}
        >
          <DataTable unit="income accounts" head={["Code", "Account", "Recognised"]}>
            {byAccount.map((a) => (
              <tr key={a.code}>
                <td className="py-2 pr-4 font-mono text-xs">{a.code}</td>
                <td className="py-2 pr-4">{a.name}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{money(a.amount)}</td>
              </tr>
            ))}
            <tr className="border-t border-border font-semibold">
              <td className="py-2 pr-4" colSpan={2}>
                Total recognised
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">{money(total)}</td>
            </tr>
          </DataTable>
        </FinanceQueryState>
      </div>

      <div className="rounded-xl border border-border/70 bg-card p-4">
        <h2 className="mb-1 text-sm font-semibold">Operational against recognised</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          What each module took, what reached the ledger, and where the difference is sitting.
        </p>
        <FinanceQueryState
          isLoading={reconciliation.isLoading}
          error={reconciliation.error}
          isEmpty={rows.length === 0}
          empty={<FinanceEmpty title="Nothing to reconcile" description="" />}
        >
          <DataTable
            unit="modules"
            head={["Module", "Operational", "Recognised", "Difference", "Waiting", "Blocked / failed", "Why"]}
          >
            {rows.map((r) => (
              <tr key={r.module}>
                <td className="py-2 pr-4">{label(r.module)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{money(r.operational_amount)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{money(r.posted_amount)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{money(r.variance)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{money(r.awaiting_amount)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {money(Number(r.blocked_amount) + Number(r.failed_amount))}
                </td>
                <td className="py-2 pr-4 text-muted-foreground">{r.explanation}</td>
              </tr>
            ))}
          </DataTable>
        </FinanceQueryState>
      </div>

      <p className="text-xs text-muted-foreground">
        Anything waiting, blocked or failed is worked from the{" "}
        <Link to="/finance/queue" className="underline underline-offset-4">
          payment queue
        </Link>
        , and every line above can be opened on the{" "}
        <Link to="/finance/general-ledger" className="underline underline-offset-4">
          general ledger
        </Link>
        .
      </p>
    </div>
  );
}
