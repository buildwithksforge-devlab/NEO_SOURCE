/**
 * Reconciliation.
 *
 * Reconciliation is the question "does the bank agree with us?", asked out
 * loud. Every figure here comes from imported statement lines and recorded
 * payments — nothing is assumed reconciled because it looks tidy, and anything
 * the two sides disagree about is listed rather than netted away.
 */
import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Landmark } from "lucide-react";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTable,
  FinanceEmpty,
  FinanceGuard,
  FinanceQueryState,
  financeHead,
} from "@/components/finance/FinanceShared";
import { BankTransferMatching } from "@/components/finance/BankTransferMatching";
import { BankMatchGrid } from "@/components/finance/BankMatchGrid";
import { SettlementAccountReview } from "@/components/finance/SettlementAccountReview";
import { useBankReconciliationOverview } from "@/lib/bank-reconciliation";
import { useBankAccounts } from "@/lib/finance-data";
import { money, shortDate } from "@/lib/finance";

export const Route = createFileRoute("/_shell/finance/reconciliation")({
  head: financeHead(
    "Bank Reconciliation",
    "Match recorded payments to imported bank statement lines, review flagged discrepancies and see how much of the bank NEØ can explain.",
  ),
  component: () => (
    <FinanceGuard feature="banking" action="view">
      <ReconciliationPage />
    </FinanceGuard>
  ),
});

const SEVERITY: Record<string, string> = {
  high: "border-destructive/40 bg-destructive/5",
  medium: "border-warning/40 bg-warning/5",
};

function ReconciliationPage() {
  const [days, setDays] = useState(90);
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const overview = useBankReconciliationOverview({ from });
  const accounts = useBankAccounts();

  const data = overview.data;
  const accountRows = data?.accounts ?? [];
  const issues = data?.issues ?? [];
  const transfers = data?.transfers;

  const matched = accountRows.reduce((s, a) => s + a.matched_lines, 0);
  const open = accountRows.reduce((s, a) => s + a.open_lines, 0);
  const explained = matched + open === 0 ? null : Math.round((matched / (matched + open)) * 100);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bank Reconciliation"
        description="What the bank says, what NEØ recorded, and every place the two disagree."
        actions={
          <div className="flex gap-2">
            {[30, 90, 180].map((d) => (
              <Button
                key={d}
                size="sm"
                variant={days === d ? "default" : "outline"}
                onClick={() => setDays(d)}
              >
                {d} days
              </Button>
            ))}
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Statement lines explained"
          value={explained === null ? "No statement yet" : `${explained}%`}
        />
        <StatCard label="Lines still open" value={String(open)} />
        <StatCard
          label="Transfers awaiting the bank"
          value={money(transfers?.awaiting_amount ?? 0)}
          hint={`${transfers?.awaiting_count ?? 0} payments`}
        />
        <StatCard
          label="Verified against the bank"
          value={money(transfers?.verified_amount ?? 0)}
          hint={`${transfers?.verified_count ?? 0} payments`}
        />
      </div>

      <SectionCard
        title="Discrepancies"
        description="Each of these is a real disagreement between NEØ and the bank. None of them clears itself."
      >
        <FinanceQueryState
          isLoading={overview.isLoading}
          error={overview.error}
          isEmpty={issues.length === 0}
          empty={
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <CheckCircle2 className="size-4 text-success" />
              {accountRows.length === 0
                ? "No bank account is set up yet, so there is nothing to reconcile against."
                : "Nothing is in dispute for this period."}
            </div>
          }
        >
          <div className="space-y-2">
            {issues.map((issue, i) => (
              <div
                key={`${issue.kind}-${i}`}
                className={`flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3 ${
                  SEVERITY[issue.severity] ?? "border-border"
                }`}
              >
                <div className="flex gap-3">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                  <div>
                    <p className="text-sm font-medium text-foreground">{issue.title}</p>
                    <p className="text-xs text-muted-foreground">{issue.detail}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium">{money(issue.amount)}</p>
                  <p className="text-xs text-muted-foreground">{shortDate(issue.occurred_at)}</p>
                </div>
              </div>
            ))}
          </div>
        </FinanceQueryState>
      </SectionCard>

      <SectionCard
        title="By bank account"
        description="How much of each account's movement is matched to a recorded payment."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/finance/banking">
              <Landmark className="mr-1.5 size-4" /> Accounts & cash
            </Link>
          </Button>
        }
      >
        <FinanceQueryState
          isLoading={overview.isLoading}
          error={overview.error}
          isEmpty={accountRows.length === 0}
          empty={
            <FinanceEmpty
              title="No bank account"
              description="Add a bank account under Banking & Cash, then import a statement to reconcile against it."
            />
          }
        >
          <DataTable head={["Account", "Money in", "Money out", "Matched", "Open", "Explained"]}>
            {accountRows.map((a) => {
              const total = a.matched_lines + a.open_lines;
              return (
                <tr key={a.account_id}>
                  <td className="py-2 pr-4">
                    <p className="font-medium text-foreground">{a.name}</p>
                    <p className="text-xs text-muted-foreground">{a.bank_name ?? "—"}</p>
                  </td>
                  <td className="py-2 pr-4">{money(a.money_in)}</td>
                  <td className="py-2 pr-4">{money(a.money_out)}</td>
                  <td className="py-2 pr-4">{a.matched_lines}</td>
                  <td className="py-2 pr-4">{a.open_lines}</td>
                  <td className="py-2 pr-4">
                    <Badge variant={a.open_lines === 0 && total > 0 ? "default" : "outline"}>
                      {total === 0 ? "No lines" : `${Math.round((a.matched_lines / total) * 100)}%`}
                    </Badge>
                  </td>
                </tr>
              );
            })}
          </DataTable>
        </FinanceQueryState>
      </SectionCard>

      <SettlementAccountReview from={from} />

      <BankMatchGrid />

      <BankTransferMatching
        accounts={(accounts.data ?? []).map((a) => ({
          id: String(a["id"]),
          name: String(a["name"] ?? "Account"),
        }))}
      />
    </div>
  );
}
