/**
 * Commerce reconciliation monitor.
 *
 * Read-only. It runs `public.neo_commerce_reconciliation`, which compares the
 * canonical records a guest or restaurant order must produce — production
 * tickets, receipts, journals, ledger lines, stock movements and the guest's
 * own tracker — and reports every disagreement. It changes nothing.
 */
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NeoDatePicker, toIso } from "@/components/common/DatePicker";
import { ErrorState, LoadingState } from "@/components/common/StateSystem";
import { FinanceEmpty, FinanceGuard, financeHead } from "@/components/finance/FinanceShared";
import { useFinanceFactScope } from "@/lib/finance-data";
import { guardedRpc } from "@/lib/rpc-guard";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_shell/finance/commerce-check")({
  head: financeHead(
    "Commerce reconciliation monitor",
    "Check that every order produced its production ticket, receipt, journal, ledger lines and stock movement — and that the guest tracker agrees with operations.",
  ),
  component: () => (
    <FinanceGuard feature="reconciliation" action="view">
      <CommerceCheck />
    </FinanceGuard>
  ),
});

type Finding = {
  check_key: string;
  severity: string;
  subject: string;
  detail: string;
  record_id: string | null;
  reference: string | null;
  occurred_at: string | null;
};

const LABELS: Record<string, string> = {
  order_without_ticket: "Order without production ticket",
  ticket_without_order: "Production ticket without order",
  paid_order_without_receipt: "Paid order without receipt",
  receipt_without_journal: "Receipt without journal",
  journal_without_lines: "Journal without ledger lines",
  journal_lines_disagree: "Ledger lines disagree with journal",
  inventory_posting_failed: "Inventory posting did not complete",
  closed_order_without_stock_movement: "Closed order without stock movement",
  duplicate_stock_movement: "Duplicate stock movement",
  guest_status_mismatch: "Guest status differs from operations",
  cross_property_mismatch: "Cross-property mismatch",
  cart_produced_duplicate_orders: "Cart produced more than one order",
};

function daysAgoIso(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return toIso(date);
}

function CommerceCheck() {
  const scope = useFinanceFactScope();
  const [from, setFrom] = useState(daysAgoIso(7));
  const [to, setTo] = useState(toIso(new Date()));

  const findings = useQuery({
    queryKey: ["finance", "commerce-check", scope.branchId ?? "all", from, to],
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_commerce_reconciliation", {
        _branch: scope.branchId ?? null,
        _from: new Date(`${from}T00:00:00`).toISOString(),
        _to: new Date(`${to}T23:59:59`).toISOString(),
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as Finding[];
    },
  });

  const rows = findings.data ?? [];
  const errors = rows.filter((r) => r.severity === "error");
  const warnings = rows.filter((r) => r.severity !== "error");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Finance"
        title="Commerce reconciliation"
        description="One read across ordering, production, payment, finance and inventory. Anything listed here is a real disagreement between records that should match — nothing on this page changes data."
        actions={
          <Button variant="outline" onClick={() => void findings.refetch()} disabled={findings.isFetching}>
            <RefreshCw className="mr-2 size-4" /> Re-run
          </Button>
        }
      />

      <SectionCard title="Period" description="Choose the window to reconcile.">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="cc-from">From</Label>
            <NeoDatePicker id="cc-from" value={from} onChange={(value) => setFrom(value ?? "")} />
          </div>
          <div>
            <Label htmlFor="cc-to">To</Label>
            <NeoDatePicker id="cc-to" value={to} onChange={(value) => setTo(value ?? "")} />
          </div>
        </div>
      </SectionCard>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Breaks" value={findings.isLoading ? "…" : String(errors.length)} />
        <StatCard label="Warnings" value={findings.isLoading ? "…" : String(warnings.length)} />
        <StatCard
          label="Checks run"
          value={String(Object.keys(LABELS).length)}
        />
      </div>

      <SectionCard
        title="Findings"
        description="Each line names the record, its reference and when it happened, so it can be opened and corrected at source."
      >
        {findings.isLoading ? (
          <LoadingState />
        ) : findings.error ? (
          <ErrorState error={findings.error} onRetry={() => void findings.refetch()} inline />
        ) : rows.length === 0 ? (
          <FinanceEmpty
            title="Everything agrees"
            description="For this property and period, every order produced its ticket, receipt, journal, ledger lines and stock movement, and the guest tracker matches operations."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3">Check</th>
                  <th className="py-2 pr-3">Record</th>
                  <th className="py-2 pr-3">Reference</th>
                  <th className="py-2 pr-3">What it means</th>
                  <th className="py-2 pr-3">When</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.check_key}-${r.record_id ?? i}`} className="border-t align-top">
                    <td className="py-2 pr-3">
                      <StatusPill tone={r.severity === "error" ? "destructive" : "warning"}>
                        {LABELS[r.check_key] ?? r.check_key}
                      </StatusPill>
                    </td>
                    <td className="py-2 pr-3">{r.subject}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{r.reference ?? "—"}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{r.detail}</td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">
                      {r.occurred_at ? new Date(r.occurred_at).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="size-3.5" /> Read-only: this monitor never creates, edits or reverses a record.
      </p>
    </div>
  );
}
