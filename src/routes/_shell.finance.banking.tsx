import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BankTransferMatching } from "@/components/finance/BankTransferMatching";
import { Button } from "@/components/ui/button";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DataTable,
  FinanceEmpty,
  FinanceGuard,
  FinanceQueryState,
  FinStatus,
  FormDialog,
  RecordForm,
  financeHead,
  type FieldSpec,
} from "@/components/finance/FinanceShared";
import { money, num, RECONCILIATION_WORKSPACES, shortDate, titleCase } from "@/lib/finance";
import {
  useAccounts,
  useBankAccounts,
  useCashCounts,
  useCashDrawers,
  useCashTransfers,
  useFinanceInsert,
  useReconciliations,
  useStatementEntries,
} from "@/lib/finance-data";

export const Route = createFileRoute("/_shell/finance/banking")({
  head: financeHead(
    "Banking & Cash Control",
    "Bank, M-Pesa and card accounts, statement matching, cash drawers, blind counts and banking transfers.",
  ),
  component: () => (
    <FinanceGuard feature="banking" action="view">
      <BankingPage />
    </FinanceGuard>
  ),
});

function BankingPage() {
  const [bankAccountId, setBankAccountId] = useState<string | null>(null);
  const accounts = useBankAccounts();
  const entries = useStatementEntries(bankAccountId);
  const reconciliations = useReconciliations();
  const drawers = useCashDrawers();
  const counts = useCashCounts();
  const transfers = useCashTransfers();
  const gl = useAccounts();


  const createReconciliation = useFinanceInsert(
    "reconciliations",
    "finance.reconciliation.created",
  );
  const createDrawer = useFinanceInsert("cash_drawers", "finance.cash_drawer.created");

  const unreconciled = (entries.data ?? []).filter((e) => e["status"] === "unreconciled");
  const variances = (counts.data ?? []).filter((c) => Math.abs(num(c["variance"])) > 0.005);

  const reconciliationFields: FieldSpec[] = [
    {
      name: "workspace",
      label: "Workspace",
      type: "select",
      required: true,
      options: RECONCILIATION_WORKSPACES.map((w) => ({ value: w, label: titleCase(w) })),
    },
    {
      name: "bank_account_id",
      label: "Account",
      type: "select",
      options: (accounts.data ?? []).map((a) => ({
        value: String(a["id"]),
        label: String(a["name"]),
      })),
    },
    { name: "period_start", label: "Period start", type: "date", required: true },
    { name: "period_end", label: "Period end", type: "date", required: true },
    { name: "statement_balance", label: "Statement balance", type: "number", required: true },
    { name: "ledger_balance", label: "Ledger balance", type: "number", required: true },
    { name: "notes", label: "Notes", type: "textarea", span: true },
  ];

  const drawerFields: FieldSpec[] = [
    { name: "name", label: "Drawer name", required: true, placeholder: "Front desk drawer 1" },
    { name: "location", label: "Location", placeholder: "Reception" },
    {
      name: "gl_account_id",
      label: "General ledger account",
      type: "select",
      options: (gl.data ?? []).map((a) => ({
        value: String(a["id"]),
        label: `${a["code"]} — ${a["name"]}`,
      })),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Finance"
        title="Banking & Cash Control"
        description="Match every statement line to a ledger entry, and hold cashiers accountable with blind counts and audited banking transfers."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Accounts"
          value={String((accounts.data ?? []).length)}
          hint="Bank, M-Pesa, card and wallets"
        />
        <StatCard
          label="Unmatched statement lines"
          value={String(unreconciled.length)}
          tone="warning"
        />
        <StatCard
          label="Cash counts with variance"
          value={String(variances.length)}
          tone="warning"
        />
        <StatCard label="Banking transfers" value={String((transfers.data ?? []).length)} />
      </div>

      <SectionCard
        title="Accounts"
        description="Every collection channel is represented by an account mapped to the general ledger."
        actions={
          <Button asChild variant="secondary">
            <Link to="/finance/bank-accounts">Manage bank accounts</Link>
          </Button>
        }
      >
        <FinanceQueryState
          isLoading={accounts.isLoading}
          error={accounts.error}
          isEmpty={(accounts.data ?? []).length === 0}
          empty={
            <FinanceEmpty
              title="No accounts registered"
              description="Add the bank, M-Pesa and card settlement accounts you collect into."
            />
          }
        >
          <DataTable head={["Account", "Kind", "Provider", "Number", "Currency", "Status"]}>
            {(accounts.data ?? []).map((a) => (
              <tr key={String(a["id"])}>
                <td className="py-2 pr-4 font-medium">{String(a["name"])}</td>
                <td className="py-2 pr-4">{titleCase(String(a["account_kind"]))}</td>
                <td className="py-2 pr-4">{String(a["bank_name"] ?? "—")}</td>
                <td className="py-2 pr-4 font-mono text-xs">
                  {String(a["account_number_masked"] ?? "—")}
                </td>
                <td className="py-2 pr-4">{String(a["currency"] ?? "KES")}</td>
                <td className="py-2 pr-4">
                  <FinStatus value={a["active"] ? "approved" : "cancelled"} />
                </td>
              </tr>
            ))}
          </DataTable>
        </FinanceQueryState>
      </SectionCard>

      <SectionCard
        title="Statement lines"
        description="Imported statement activity awaiting matching against ledger entries."
        actions={
          <Select
            value={bankAccountId ?? "all"}
            onValueChange={(v) => setBankAccountId(v === "all" ? null : v)}
          >
            <SelectTrigger className="h-9 w-56" aria-label="Filter statement lines by account">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All accounts</SelectItem>
              {(accounts.data ?? []).map((a) => (
                <SelectItem key={String(a["id"])} value={String(a["id"])}>
                  {String(a["name"])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        <FinanceQueryState
          isLoading={entries.isLoading}
          error={entries.error}
          isEmpty={(entries.data ?? []).length === 0}
          empty={
            <FinanceEmpty
              title="No statement lines"
              description="Import a bank, M-Pesa or card settlement statement to begin reconciling."
            />
          }
        >
          <DataTable
            head={[
              "Value date",
              "Account",
              "Description",
              "Reference",
              "Direction",
              "Amount",
              "Status",
            ]}
          >
            {(entries.data ?? []).map((e) => {
              const acc = e["bank_accounts"] as { name?: string } | null;
              return (
                <tr key={String(e["id"])}>
                  <td className="py-2 pr-4">{shortDate(e["value_date"])}</td>
                  <td className="py-2 pr-4">{acc?.name ?? "—"}</td>
                  <td className="py-2 pr-4 text-muted-foreground">
                    {String(e["description"] ?? "")}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">
                    {String(e["external_reference"] ?? "—")}
                  </td>
                  <td className="py-2 pr-4">{titleCase(String(e["direction"]))}</td>
                  <td className="py-2 pr-4">{money(e["amount"])}</td>
                  <td className="py-2 pr-4">
                    <FinStatus value={String(e["status"])} />
                  </td>
                </tr>
              );
            })}
          </DataTable>
        </FinanceQueryState>
      </SectionCard>

      <BankTransferMatching
        accounts={(accounts.data ?? []).map((a) => ({
          id: String(a["id"]),
          name: String(a["name"] ?? "Account"),
        }))}
      />

      <SectionCard
        title="Reconciliations"
        description="A reconciliation is only complete when the difference between statement and ledger is zero."
        actions={
          <FormDialog
            title="Start reconciliation"
            description="Open a reconciliation for a channel and period."
          >
            {(close) => (
              <RecordForm
                fields={reconciliationFields}
                submitLabel="Open reconciliation"
                busy={createReconciliation.isPending}
                onSubmit={(values) =>
                  createReconciliation.mutate(
                    {
                      ...values,
                      difference:
                        Number(values["statement_balance"] ?? 0) -
                        Number(values["ledger_balance"] ?? 0),
                      status: "in_review",
                    },
                    { onSuccess: close },
                  )
                }
              />
            )}
          </FormDialog>
        }
      >
        <FinanceQueryState
          isLoading={reconciliations.isLoading}
          error={reconciliations.error}
          isEmpty={(reconciliations.data ?? []).length === 0}
          empty={
            <FinanceEmpty
              title="No reconciliations"
              description="Reconcile cash, bank, M-Pesa, card, OTA and supplier payments per period."
            />
          }
        >
          <DataTable
            head={[
              "Reference",
              "Workspace",
              "Period",
              "Statement",
              "Ledger",
              "Difference",
              "Status",
            ]}
          >
            {(reconciliations.data ?? []).map((r) => (
              <tr key={String(r["id"])}>
                <td className="py-2 pr-4 font-mono text-xs">
                  {String(r["reconciliation_number"] ?? "—")}
                </td>
                <td className="py-2 pr-4">{titleCase(String(r["workspace"]))}</td>
                <td className="py-2 pr-4">
                  {shortDate(r["period_start"])} – {shortDate(r["period_end"])}
                </td>
                <td className="py-2 pr-4">{money(r["statement_balance"])}</td>
                <td className="py-2 pr-4">{money(r["ledger_balance"])}</td>
                <td
                  className={
                    num(r["difference"]) === 0
                      ? "py-2 pr-4 text-success"
                      : "py-2 pr-4 text-destructive"
                  }
                >
                  {money(r["difference"])}
                </td>
                <td className="py-2 pr-4">
                  <FinStatus value={String(r["status"])} />
                </td>
              </tr>
            ))}
          </DataTable>
        </FinanceQueryState>
      </SectionCard>

      <div className="grid gap-6 xl:grid-cols-2">
        <SectionCard
          title="Cash drawers"
          description="Each drawer has an owner and a general ledger account."
          actions={
            <FormDialog title="New drawer" description="Register a cash drawer or float.">
              {(close) => (
                <RecordForm
                  fields={drawerFields}
                  submitLabel="Create drawer"
                  busy={createDrawer.isPending}
                  onSubmit={(values) =>
                    createDrawer.mutate({ ...values, active: true }, { onSuccess: close })
                  }
                />
              )}
            </FormDialog>
          }
        >
          <FinanceQueryState
            isLoading={drawers.isLoading}
            error={drawers.error}
            isEmpty={(drawers.data ?? []).length === 0}
            empty={
              <FinanceEmpty
                title="No drawers"
                description="Register the cash points used by reception, restaurant and bar."
              />
            }
          >
            <DataTable head={["Drawer", "Location", "Status"]}>
              {(drawers.data ?? []).map((d) => (
                <tr key={String(d["id"])}>
                  <td className="py-2 pr-4 font-medium">{String(d["name"])}</td>
                  <td className="py-2 pr-4 text-muted-foreground">
                    {String(d["location"] ?? "—")}
                  </td>
                  <td className="py-2 pr-4">
                    <FinStatus value={d["active"] ? "approved" : "cancelled"} />
                  </td>
                </tr>
              ))}
            </DataTable>
          </FinanceQueryState>
        </SectionCard>

        <SectionCard
          title="Blind cash counts"
          description="Counted totals are captured before the expected total is revealed; variances need a reason and review."
        >
          <FinanceQueryState
            isLoading={counts.isLoading}
            error={counts.error}
            isEmpty={(counts.data ?? []).length === 0}
            empty={
              <FinanceEmpty
                title="No cash counts"
                description="Shift close counts appear here with their variance and review status."
              />
            }
          >
            <DataTable head={["Drawer", "Counted", "Expected", "Variance", "Status"]}>
              {(counts.data ?? []).map((c) => {
                const drawer = c["cash_drawers"] as { name?: string } | null;
                return (
                  <tr key={String(c["id"])}>
                    <td className="py-2 pr-4">{drawer?.name ?? "—"}</td>
                    <td className="py-2 pr-4">{money(c["counted_total"])}</td>
                    <td className="py-2 pr-4">{money(c["expected_total"])}</td>
                    <td
                      className={
                        num(c["variance"]) === 0 ? "py-2 pr-4" : "py-2 pr-4 text-destructive"
                      }
                    >
                      {money(c["variance"])}
                    </td>
                    <td className="py-2 pr-4">
                      <FinStatus value={String(c["status"])} />
                    </td>
                  </tr>
                );
              })}
            </DataTable>
          </FinanceQueryState>
        </SectionCard>
      </div>

      <SectionCard
        title="Banking transfers"
        description="Cash handed from a drawer to the safe or bank is tracked until it is confirmed received."
      >
        <FinanceQueryState
          isLoading={transfers.isLoading}
          error={transfers.error}
          isEmpty={(transfers.data ?? []).length === 0}
          empty={
            <FinanceEmpty
              title="No transfers"
              description="Movements of cash between drawers, the safe and the bank appear here."
            />
          }
        >
          <DataTable
            head={["Reference", "From", "Destination", "Amount", "Sent", "Received", "Status"]}
          >
            {(transfers.data ?? []).map((t) => {
              const from = t["cash_drawers"] as { name?: string } | null;
              return (
                <tr key={String(t["id"])}>
                  <td className="py-2 pr-4 font-mono text-xs">
                    {String(t["transfer_number"] ?? "—")}
                  </td>
                  <td className="py-2 pr-4">{from?.name ?? "—"}</td>
                  <td className="py-2 pr-4">{titleCase(String(t["to_destination"] ?? ""))}</td>
                  <td className="py-2 pr-4">{money(t["amount"])}</td>
                  <td className="py-2 pr-4">{shortDate(t["sent_at"])}</td>
                  <td className="py-2 pr-4">{shortDate(t["received_at"])}</td>
                  <td className="py-2 pr-4">
                    <FinStatus value={String(t["status"])} />
                  </td>
                </tr>
              );
            })}
          </DataTable>
        </FinanceQueryState>
      </SectionCard>
    </div>
  );
}
