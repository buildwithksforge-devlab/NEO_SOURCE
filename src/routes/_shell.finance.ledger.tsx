import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, TableScroll } from "@/components/common/DataDisplay";
import { PagedRows } from "@/components/common/TablePager";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { ACCOUNT_CATEGORIES, titleCase } from "@/lib/finance";
import {
  useAccounts,
  useFinanceInsert,
  useFinanceUpdate,
  useSeedFinanceDefaults,
  useTaxCodes,
} from "@/lib/finance-data";

export const Route = createFileRoute("/_shell/finance/ledger")({
  head: financeHead(
    "Chart of Accounts",
    "The multi-level chart of accounts behind every posting: assets, liabilities, equity, revenue and expenses.",
  ),
  component: () => (
    <FinanceGuard feature="gl" action="view">
      <LedgerPage />
    </FinanceGuard>
  ),
});

function LedgerPage() {
  const accounts = useAccounts();
  const taxCodes = useTaxCodes();
  const create = useFinanceInsert("chart_of_accounts", "finance.account.created", {
    branchScoped: false,
  });
  const update = useFinanceUpdate("chart_of_accounts", "finance.account.updated");
  const seed = useSeedFinanceDefaults();
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const list = accounts.data ?? [];
    return list.filter((a) => {
      const catOk = category === "all" || a["category"] === category;
      const text = `${a["code"]} ${a["name"]}`.toLowerCase();
      return catOk && (search === "" || text.includes(search.toLowerCase()));
    });
  }, [accounts.data, category, search]);

  const fields: FieldSpec[] = [
    { name: "code", label: "Account code", required: true, placeholder: "4100" },
    { name: "name", label: "Account name", required: true, placeholder: "Room revenue" },
    {
      name: "category",
      label: "Category",
      type: "select",
      required: true,
      options: ACCOUNT_CATEGORIES.map((c) => ({ value: c, label: titleCase(c) })),
    },
    { name: "account_group", label: "Group", placeholder: "Rooms" },
    {
      name: "parent_id",
      label: "Parent account",
      type: "select",
      options: (accounts.data ?? []).map((a) => ({
        value: String(a["id"]),
        label: `${a["code"]} — ${a["name"]}`,
      })),
    },
    {
      name: "default_tax_code_id",
      label: "Default tax code",
      type: "select",
      options: (taxCodes.data ?? []).map((t) => ({
        value: String(t["id"]),
        label: `${t["code"]} — ${t["name"]}`,
      })),
    },
    { name: "is_header", label: "Header account (not postable)", type: "checkbox" },
    { name: "description", label: "Description", type: "textarea", span: true },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Finance"
        title="Chart of Accounts"
        description="Accounts drive every automatic posting from Front Office, POS, Events and Procurement. Accounts already used by a posted journal can be deactivated but never deleted."
        actions={
          <FormDialog
            title="New account"
            description="Add an account to the chart. Header accounts group children and cannot be posted to."
          >
            {(close) => (
              <RecordForm
                fields={fields}
                submitLabel="Create account"
                busy={create.isPending}
                onSubmit={(values) => {
                  create.mutate(
                    {
                      ...values,
                      postable: !values["is_header"],
                      active: true,
                    },
                    { onSuccess: close },
                  );
                }}
              />
            )}
          </FormDialog>
        }
      />

      <SectionCard
        title={`${rows.length} account(s)`}
        description="Filter by category or search by code and name."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search accounts"
              className="h-9 w-48"
              aria-label="Search accounts"
            />
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="h-9 w-44" aria-label="Filter by category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {ACCOUNT_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {titleCase(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      >
        <FinanceQueryState
          isLoading={accounts.isLoading}
          error={accounts.error}
          isEmpty={rows.length === 0}
          empty={
            <FinanceEmpty
              title="No accounts yet"
              description="Seed the standard hospitality chart of accounts, or create accounts one by one."
              action={
                <Button onClick={() => seed.mutate()} disabled={seed.isPending}>
                  Set up finance defaults
                </Button>
              }
            />
          }
        >
          <PagedRows rows={rows} unit="accounts">
            {(pageRows) => (
              <TableScroll>
                <DataTable head={["Code", "Name", "Category", "Group", "Postable", "Status", ""]}>
                  {pageRows.map((a) => (
                    <tr key={String(a["id"])}>
                      <td className="py-2 pr-4 font-mono text-xs">{String(a["code"])}</td>
                      <td className="py-2 pr-4 font-medium">{String(a["name"])}</td>
                      <td className="py-2 pr-4">{titleCase(String(a["category"]))}</td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {String(a["account_group"] ?? "—")}
                      </td>
                      <td className="py-2 pr-4">{a["postable"] ? "Yes" : "Header"}</td>
                      <td className="py-2 pr-4">
                        <FinStatus value={a["active"] ? "approved" : "cancelled"} />
                      </td>
                      <td className="py-2 pr-4 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            update.mutate({ id: String(a["id"]), values: { active: !a["active"] } })
                          }
                        >
                          {a["active"] ? "Deactivate" : "Reactivate"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </DataTable>
              </TableScroll>
            )}
          </PagedRows>
        </FinanceQueryState>
      </SectionCard>
    </div>
  );
}
