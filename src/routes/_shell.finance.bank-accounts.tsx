import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NeoDatePicker } from "@/components/common/DatePicker";
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
import { money, shortDate, titleCase } from "@/lib/finance";
import { useAuth } from "@/lib/auth";
import {
  useAccounts,
  useBankAccounts,
  useFinanceFactScope,
  useFinanceInsert,
  useFinanceUpdate,
  useGeneralLedger,
} from "@/lib/finance-data";

export const Route = createFileRoute("/_shell/finance/bank-accounts")({
  head: financeHead(
    "Bank Accounts",
    "Bank, mobile money and card settlement accounts with their posted balance, their transactions and the details needed to pay suppliers.",
  ),
  component: () => (
    <FinanceGuard feature="banking" action="view">
      <BankAccountsPage />
    </FinanceGuard>
  ),
});

const ACCOUNT_KINDS = ["bank", "mpesa", "card_clearing", "cash", "ota_clearing"] as const;

function BankAccountsPage() {
  const { can, isAdmin } = useAuth();
  const mayEdit = isAdmin || can("finance", "banking", "edit");

  const accounts = useBankAccounts();
  const gl = useAccounts();
  const createAccount = useFinanceInsert("bank_accounts", "finance.bank_account.created");
  const updateAccount = useFinanceUpdate("bank_accounts", "finance.bank_account.updated");

  const scope = useFinanceFactScope();
  const [from, setFrom] = useState(scope.from);
  const [to, setTo] = useState(scope.to);
  const [selected, setSelected] = useState<string | null>(null);
  const ledger = useGeneralLedger(from, to, null);

  const rows = accounts.data ?? [];
  const active = rows.filter((a) => Boolean(a["active"]));
  // Only an account with a holder name and a number can actually be paid from.
  const payable = active.filter(
    (a) => String(a["account_holder"] ?? "").trim() !== "" && String(a["account_number"] ?? "").trim() !== "",
  );

  /**
   * The balance of a bank account is the posted position of the ledger account
   * it is mapped to — never a figure typed in here. An account with no ledger
   * mapping has no balance, and says so rather than showing zero.
   */
  const positionByGl = useMemo(() => {
    const map = new Map<string, { opening: number; in: number; out: number; balance: number; lines: number }>();
    for (const l of ledger.data ?? []) {
      const entry = map.get(l.account_id) ?? { opening: l.opening_balance, in: 0, out: 0, balance: 0, lines: 0 };
      entry.in += l.debit;
      entry.out += l.credit;
      entry.balance = l.running_balance;
      entry.lines += 1;
      map.set(l.account_id, entry);
    }
    return map;
  }, [ledger.data]);

  const unmapped = active.filter((a) => !a["gl_account_id"]).length;
  // Two bank accounts may point at one ledger account; that shared position is
  // one sum of money, so it is counted once, not once per card.
  const countedGlIds = new Set(
    active.map((a) => String(a["gl_account_id"] ?? "")).filter((glId) => glId && positionByGl.has(glId)),
  );
  const totalBalance = [...countedGlIds].reduce((sum, glId) => sum + (positionByGl.get(glId)?.balance ?? 0), 0);
  // A mapped account with no posted line inside the chosen dates has no
  // position to show here — it is never reported as zero money.
  const quiet = active.filter((a) => {
    const glId = String(a["gl_account_id"] ?? "");
    return Boolean(glId) && !positionByGl.has(glId);
  }).length;

  const selectedAccount = rows.find((a) => String(a["id"]) === selected) ?? null;
  const selectedGl = String(selectedAccount?.["gl_account_id"] ?? "");
  const transactions = useMemo(
    () => (selectedGl ? (ledger.data ?? []).filter((l) => l.account_id === selectedGl) : []),
    [ledger.data, selectedGl],
  );

  const fields: FieldSpec[] = [
    { name: "name", label: "Account label", required: true, placeholder: "Main current account" },
    {
      name: "account_kind",
      label: "Account kind",
      type: "select",
      required: true,
      options: ACCOUNT_KINDS.map((v) => ({ value: v, label: titleCase(v) })),
    },
    { name: "bank_name", label: "Bank / provider", required: true, placeholder: "Equity Bank" },
    { name: "account_holder", label: "Account name (as held at the bank)", required: true, span: true },
    { name: "account_number", label: "Account number", required: true, placeholder: "0123456789" },
    { name: "bank_branch", label: "Bank branch", placeholder: "Westlands" },
    { name: "branch_code", label: "Branch / sort code", placeholder: "068" },
    { name: "swift_bic", label: "SWIFT / BIC", placeholder: "EQBLKENA" },
    { name: "iban", label: "IBAN (if used)" },
    { name: "paybill_number", label: "Paybill / till (mobile money)" },
    { name: "currency", label: "Currency", required: true, placeholder: "KES" },
    {
      name: "gl_account_id",
      label: "General ledger account",
      type: "select",
      options: (gl.data ?? []).map((a) => ({
        value: String(a["id"]),
        label: `${a["code"]} — ${a["name"]}`,
      })),
    },
    {
      name: "payment_instructions",
      label: "Payment instructions for the person making the transfer",
      type: "textarea",
      span: true,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Finance"
        title="Bank Accounts"
        description="Hold the real details of every account you pay from and collect into. Payments are made in your bank and captured here with their reference — NEØ does not connect to a bank."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Accounts" value={String(rows.length)} hint="Bank, mobile money, card and wallets" />
        <StatCard label="Active" value={String(active.length)} />
        <StatCard
          label="Ready to pay suppliers from"
          value={String(payable.length)}
          tone={payable.length === 0 ? "warning" : "default"}
          hint="Active, with an account name and number"
        />
        <StatCard
          label="Posted balance in period"
          value={money(totalBalance)}
          tone={unmapped > 0 || quiet > 0 ? "warning" : "default"}
          hint={
            unmapped > 0
              ? `${unmapped} active account${unmapped === 1 ? "" : "s"} not mapped to a ledger account`
              : quiet > 0
                ? `Excludes ${quiet} account${quiet === 1 ? "" : "s"} with no posting in the chosen dates`
                : "Ledger accounts with postings in the chosen dates, each counted once"
          }
        />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label>From</Label>
          <NeoDatePicker value={from} onChange={setFrom} />
        </div>
        <div className="space-y-1">
          <Label>To</Label>
          <NeoDatePicker value={to} onChange={setTo} />
        </div>
      </div>

      <SectionCard
        title="Balances"
        description="What each account holds according to the books. The balance is the posted position of the ledger account it is mapped to — nothing here is typed in or estimated."
      >
        <FinanceQueryState
          isLoading={accounts.isLoading || ledger.isLoading}
          error={accounts.error ?? ledger.error}
          isEmpty={rows.length === 0}
          empty={
            <FinanceEmpty
              title="No accounts yet"
              description="Add an account below, then map it to a general ledger account so its balance can be read from the books."
            />
          }
        >
          <DataTable head={["Account", "Ledger account", "Opening", "In", "Out", "Balance", ""]} unit="accounts">
            {rows.map((a) => {
              const id = String(a["id"]);
              const glId = String(a["gl_account_id"] ?? "");
              const glAccount = (gl.data ?? []).find((g) => String(g["id"]) === glId);
              const position = glId ? positionByGl.get(glId) : undefined;
              return (
                <tr key={`bal-${id}`} className="align-top">
                  <td className="py-2 pr-4">
                    <div className="font-medium">{String(a["name"])}</div>
                    <div className="text-xs text-muted-foreground">
                      {titleCase(String(a["account_kind"] ?? "bank"))}
                      {a["bank_name"] ? ` · ${String(a["bank_name"])}` : ""}
                    </div>
                  </td>
                  <td className="py-2 pr-4">
                    {glAccount ? (
                      <span className="text-xs">
                        <span className="font-mono">{String(glAccount["code"])}</span> {String(glAccount["name"])}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-destructive">
                        <AlertTriangle className="size-3.5" aria-hidden />
                        Not mapped
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-4 tabular-nums">{position ? money(position.opening) : "—"}</td>
                  <td className="py-2 pr-4 tabular-nums">{position ? money(position.in) : "—"}</td>
                  <td className="py-2 pr-4 tabular-nums">{position ? money(position.out) : "—"}</td>
                  <td className="py-2 pr-4 font-medium tabular-nums">
                    {!glId ? (
                      "No balance"
                    ) : position ? (
                      money(position.balance)
                    ) : (
                      <span className="text-xs font-normal text-muted-foreground">No posting in these dates</span>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-right">
                    {glId ? (
                      <Button
                        size="sm"
                        variant={selected === id ? "default" : "secondary"}
                        onClick={() => setSelected(selected === id ? null : id)}
                      >
                        {selected === id ? "Hide transactions" : "Transactions"}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </DataTable>
        </FinanceQueryState>
      </SectionCard>

      {selectedAccount ? (
        <SectionCard
          title={`Transactions — ${String(selectedAccount["name"])}`}
          description={`Every posted movement through this account between ${shortDate(from)} and ${shortDate(to)}, with the running balance after each one.`}
        >
          <FinanceQueryState
            isLoading={ledger.isLoading}
            error={ledger.error}
            isEmpty={transactions.length === 0}
            empty={
              <FinanceEmpty
                title="No movements"
                description="Nothing was posted through this account in the chosen period."
              />
            }
          >
            <DataTable head={["Date", "Document", "Description", "In", "Out", "Balance"]} unit="transactions">
              {transactions.map((l) => (
                <tr key={l.line_id}>
                  <td className="py-2 pr-4 whitespace-nowrap">{shortDate(l.accounting_date ?? "")}</td>
                  <td className="py-2 pr-4">{l.document_number ?? l.journal_number ?? "—"}</td>
                  <td className="py-2 pr-4">{l.description ?? "—"}</td>
                  <td className="py-2 pr-4 tabular-nums">{l.debit ? money(l.debit) : "—"}</td>
                  <td className="py-2 pr-4 tabular-nums">{l.credit ? money(l.credit) : "—"}</td>
                  <td className="py-2 pr-4 tabular-nums">{money(l.running_balance)}</td>
                </tr>
              ))}
            </DataTable>
          </FinanceQueryState>
        </SectionCard>
      ) : null}


      <SectionCard
        title="Accounts"
        description="Every account carries the details a bank needs for a transfer, and the general ledger account it posts to."
        actions={
          mayEdit ? (
            <FormDialog
              title="New account"
              description="Enter the account exactly as it is held at the bank or mobile money provider."
            >
              {(close) => (
                <RecordForm
                  fields={fields}
                  initial={{ currency: "KES", account_kind: "bank" }}
                  submitLabel="Save account"
                  busy={createAccount.isPending}
                  onSubmit={(values) => createAccount.mutate({ ...values, active: true }, { onSuccess: close })}
                />
              )}
            </FormDialog>
          ) : null
        }
      >
        <FinanceQueryState
          isLoading={accounts.isLoading}
          error={accounts.error}
          isEmpty={rows.length === 0}
          empty={
            <FinanceEmpty
              title="No accounts yet"
              description="Add the bank, mobile money and card settlement accounts this property uses."
            />
          }
        >
          <DataTable
            head={["Account", "Kind", "Bank", "Account name", "Number", "Branch", "SWIFT", "Currency", "Status", ""]}
          >
            {rows.map((a) => {
              const id = String(a["id"]);
              const isActive = Boolean(a["active"]);
              return (
                <tr key={id}>
                  <td className="py-2 pr-4 font-medium">{String(a["name"])}</td>
                  <td className="py-2 pr-4">{titleCase(String(a["account_kind"] ?? "bank"))}</td>
                  <td className="py-2 pr-4">{String(a["bank_name"] ?? "") || "—"}</td>
                  <td className="py-2 pr-4">{String(a["account_holder"] ?? "") || "—"}</td>
                  <td className="py-2 pr-4 font-mono text-xs">
                    {String(a["account_number"] ?? "") || String(a["account_number_masked"] ?? "") || "—"}
                  </td>
                  <td className="py-2 pr-4">{String(a["bank_branch"] ?? "") || "—"}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{String(a["swift_bic"] ?? "") || "—"}</td>
                  <td className="py-2 pr-4">{String(a["currency"] ?? "KES")}</td>
                  <td className="py-2 pr-4">
                    <FinStatus value={isActive ? "approved" : "cancelled"} />
                  </td>
                  <td className="py-2 pr-4 text-right">
                    {mayEdit ? (
                      <div className="flex justify-end gap-2">
                        <FormDialog
                          trigger={
                            <Button size="sm" variant="secondary">
                              Edit
                            </Button>
                          }
                          title="Edit account"
                          description="Correct the details held for this account."
                        >
                          {(close) => (
                            <RecordForm
                              fields={fields}
                              initial={a}
                              submitLabel="Save changes"
                              busy={updateAccount.isPending}
                              onSubmit={(values) =>
                                updateAccount.mutate({ id, values }, { onSuccess: close })
                              }
                            />
                          )}
                        </FormDialog>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={updateAccount.isPending}
                          onClick={() =>
                            updateAccount.mutate({
                              id,
                              values: { active: !isActive },
                              reason: isActive ? "Account taken out of use" : "Account put back in use",
                            })
                          }
                        >
                          {isActive ? "Deactivate" : "Reactivate"}
                        </Button>
                      </div>
                    ) : null}
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
