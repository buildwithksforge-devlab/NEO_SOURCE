import { formatTaxCodeRate, taxCodeFractionFromPercent } from "@/lib/tax-code-rate";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
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
import { dateTime, money, num, shortDate, titleCase } from "@/lib/finance";
import {
  useAccounts,
  useEtimsSubmissions,
  useFinanceInsert,
  useFinanceUpdate,
  useInvoices,
  useTaxCodes,
  useTaxTransactions,
} from "@/lib/finance-data";
import { FileWithKraButton } from "@/components/finance/FileWithKraButton";
import { SalesTaxProfiles } from "@/components/finance/SalesTaxProfiles";
import { SalesTaxReport } from "@/components/finance/SalesTaxReport";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_shell/finance/tax")({
  head: financeHead(
    "Tax & Compliance",
    "Tax codes, output and input tax transactions, and the status of every fiscal document submission.",
  ),
  component: () => (
    <FinanceGuard feature="tax" action="view">
      <TaxPage />
    </FinanceGuard>
  ),
});

function TaxPage() {
  const codes = useTaxCodes();
  const transactions = useTaxTransactions();
  const submissions = useEtimsSubmissions();
  const accounts = useAccounts();
  const invoices = useInvoices("all");
  const createCode = useFinanceInsert("tax_codes", "finance.tax_code.created", { branchScoped: false });
  const updateCode = useFinanceUpdate("tax_codes", "finance.tax_code.updated");

  const unfiled = (invoices.data ?? []).filter(
    (inv: Record<string, unknown>) =>
      String(inv["status"]) !== "draft" &&
      !["accepted", "not_required", "exempt"].includes(String(inv["etims_status"] ?? "")),
  );

  const output = (transactions.data ?? []).filter((t) => t["direction"] === "output");
  const input = (transactions.data ?? []).filter((t) => t["direction"] === "input");
  const outputTax = output.reduce((s, t) => s + num(t["tax_amount"]), 0);
  const inputTax = input.reduce((s, t) => s + num(t["tax_amount"]), 0);
  const failed = (submissions.data ?? []).filter((s) =>
    ["failed", "rejected", "retry_required"].includes(String(s["status"])),
  );
  const liabilityAccounts = (accounts.data ?? []).filter((account) =>
    account["category"] === "liability" && account["active"] && account["postable"] && !account["is_header"]
  );
  const taxAccountOptions = liabilityAccounts.map((account) => ({
    value: String(account["id"]), label: `${account["code"]} — ${account["name"]}`,
  }));

  const codeFields: FieldSpec[] = [
    { name: "code", label: "Tax code", required: true, placeholder: "VAT16" },
    { name: "name", label: "Name", required: true, placeholder: "VAT standard rate" },
    {
      name: "sales_calculation", label: "Calculation", type: "select", required: true,
      options: [{ value: "percentage", label: "Percentage" }, { value: "fixed", label: "Fixed per unit" }],
    },
    { name: "rate", label: "Percentage or fixed amount per unit", type: "number", required: true, min: 0, step: 0.01 },
    { name: "sales_description", label: "Description" },
    {
      name: "treatment",
      label: "Treatment",
      type: "select",
      required: true,
      options: ["standard", "zero_rated", "exempt", "withholding", "service_charge"].map((v) => ({
        value: v,
        label: titleCase(v),
      })),
    },
    { name: "inclusive", label: "Prices include this tax", type: "checkbox" },
    { name: "effective_from", label: "Effective from", type: "date", required: true },
    { name: "effective_to", label: "Effective to", type: "date" },
    {
      name: "tax_account_id",
      label: "Active, postable tax liability account",
      type: "select",
      options: taxAccountOptions,
    },
    { name: "etims_code", label: "Fiscal / eTIMS code", placeholder: "B" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Finance"
        title="Tax Management & Compliance"
        description="Configure sales tax codes and profiles, review liabilities, and track fiscal submissions."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Output tax" value={money(outputTax)} hint="Tax charged on sales" />
        <StatCard label="Input tax" value={money(inputTax)} hint="Tax paid on purchases" />
        <StatCard
          label="Net tax position"
          value={money(outputTax - inputTax)}
          tone={outputTax - inputTax > 0 ? "warning" : "success"}
        />
        <StatCard
          label="Submissions needing attention"
          value={String(failed.length)}
          tone="warning"
        />
      </div>

      <SectionCard
        title="Tax codes"
        description="Standard, zero-rated, exempt, withholding and service-charge codes with effective dating."
        actions={
          <FormDialog
            title="New tax code"
            description="Add a tax code. Existing documents keep the rate that applied when they were issued."
          >
            {(close) => (
              <RecordForm
                fields={codeFields}
                initial={{ sales_calculation: "percentage", treatment: "standard", inclusive: true }}
                submitLabel="Create tax code"
                busy={createCode.isPending}
                validate={(values) => values["sales_calculation"] !== "fixed" && num(values["rate"]) > 100
                  ? "Enter a percentage between 0 and 100." : null}
                onSubmit={async (values) => {
                  await createCode.mutateAsync({
                    ...values,
                    code: String(values["code"]).trim(),
                    name: String(values["name"]).trim(),
                    effective_to: values["effective_to"] || null,
                    tax_account_id: values["tax_account_id"] || null,
                    rate: values["sales_calculation"] === "fixed" ? 0 : taxCodeFractionFromPercent(values["rate"]),
                    sales_fixed_amount: values["sales_calculation"] === "fixed" ? num(values["rate"]) : 0,
                    active: true,
                  });
                  close();
                }}
              />
            )}
          </FormDialog>
        }
      >
        <FinanceQueryState
          isLoading={codes.isLoading}
          error={codes.error}
          isEmpty={(codes.data ?? []).length === 0}
          empty={
            <FinanceEmpty
              title="No tax codes"
              description="Create at least one tax code before issuing tax invoices."
            />
          }
        >
          <DataTable
            head={["Code", "Name", "Rate", "Treatment", "Inclusive", "Effective", "Status", ""]}
          >
            {(codes.data ?? []).map((c) => (
              <tr key={String(c["id"])}>
                <td className="py-2 pr-4 font-mono text-xs">{String(c["code"])}</td>
                <td className="py-2 pr-4">{String(c["name"])}</td>
                <td className="py-2 pr-4">{c["sales_calculation"] === "fixed" ? `${num(c["sales_fixed_amount"]).toFixed(2)} per unit` : formatTaxCodeRate(c["rate"])}</td>
                <td className="py-2 pr-4">{titleCase(String(c["treatment"]))}</td>
                <td className="py-2 pr-4">{c["inclusive"] ? "Yes" : "No"}</td>
                <td className="py-2 pr-4">
                  {shortDate(c["effective_from"])} –{" "}
                  {c["effective_to"] ? shortDate(c["effective_to"]) : "open"}
                </td>
                <td className="py-2 pr-4">
                  <FinStatus value={c["active"] ? "approved" : "cancelled"} />
                </td>
                <td className="py-2 pr-4">
                  <FormDialog
                    trigger={<Button variant="outline" size="sm">Tax account</Button>}
                    title={`Tax account for ${String(c["code"])}`}
                    description="Choose an active, postable liability account for this tax code before a new sale uses it."
                  >
                    {(close) => <RecordForm
                      key={String(c["id"])}
                      fields={[{ name: "tax_account_id", label: "Tax liability account", type: "select", required: true, options: taxAccountOptions }]}
                      initial={{ tax_account_id: c["tax_account_id"] ?? "" }}
                      submitLabel="Save tax account"
                      busy={updateCode.isPending}
                      onSubmit={async (values) => {
                        await updateCode.mutateAsync({ id: String(c["id"]), values: { tax_account_id: values["tax_account_id"] } });
                        await codes.refetch();
                        close();
                      }}
                    />}
                  </FormDialog>
                  <Button variant="ghost" size="sm" disabled={updateCode.isPending} onClick={() =>
                    updateCode.mutate({ id: String(c["id"]), values: { active: !c["active"] } },
                      { onSuccess: () => void codes.refetch() })
                  }>{c["active"] ? "Archive" : "Activate"}</Button>
                </td>
              </tr>
            ))}
          </DataTable>
        </FinanceQueryState>
      </SectionCard>

      <SalesTaxProfiles />
      <SalesTaxReport />

      <SectionCard
        title="Awaiting fiscalisation"
        description="Issued invoices that KRA has not yet accepted. Filing is only possible once eTIMS is configured and switched on in Administration."
      >
        <FinanceQueryState
          isLoading={invoices.isLoading}
          error={invoices.error}
          isEmpty={unfiled.length === 0}
          empty={
            <FinanceEmpty
              title="Nothing outstanding"
              description="Every issued invoice has been accepted by KRA or is not subject to fiscalisation."
            />
          }
        >
          <DataTable head={["Invoice", "Issued", "Total", "Fiscal status", ""]}>
            {unfiled.map((inv: Record<string, unknown>) => (
              <tr key={String(inv["id"])}>
                <td className="py-2 pr-4 font-mono text-xs">
                  {String(inv["invoice_number"] ?? "—")}
                </td>
                <td className="py-2 pr-4">{shortDate(inv["issue_date"])}</td>
                <td className="py-2 pr-4">{money(inv["total"])}</td>
                <td className="py-2 pr-4">
                  <FinStatus value={String(inv["etims_status"] ?? "pending")} />
                </td>
                <td className="py-2 pr-4">
                  <FileWithKraButton invoiceId={String(inv["id"])} />
                </td>
              </tr>
            ))}
          </DataTable>
        </FinanceQueryState>
      </SectionCard>

      <SectionCard
        title="Fiscal submissions"
        description="Every tax invoice and credit note submission, with its KRA reference, control unit data and retry history."
      >
        <FinanceQueryState
          isLoading={submissions.isLoading}
          error={submissions.error}
          isEmpty={(submissions.data ?? []).length === 0}
          empty={
            <FinanceEmpty
              title="No submissions"
              description="Documents are filed with KRA once eTIMS is configured in Administration → KRA eTIMS."
            />
          }
        >
          <DataTable
            head={["Document", "Kind", "Reference", "Attempts", "Last attempt", "Status", ""]}
          >
            {(submissions.data ?? []).map((s) => (
              <tr key={String(s["id"])}>
                <td className="py-2 pr-4 font-mono text-xs">
                  {String(s["document_number"] ?? "—")}
                </td>
                <td className="py-2 pr-4">{titleCase(String(s["document_kind"]))}</td>
                <td className="py-2 pr-4 font-mono text-xs">{String(s["kra_reference"] ?? "—")}</td>
                <td className="py-2 pr-4">{num(s["attempts"])}</td>
                <td className="py-2 pr-4">{dateTime(s["last_attempt_at"])}</td>
                <td className="py-2 pr-4">
                  <FinStatus value={String(s["status"])} />
                </td>
                <td className="py-2 pr-4">
                  {String(s["status"]) === "accepted" ? (
                    <span className="text-xs text-muted-foreground">Filed</span>
                  ) : (
                    <FileWithKraButton
                      invoiceId={s["invoice_id"] ? String(s["invoice_id"]) : null}
                      creditNoteId={s["credit_note_id"] ? String(s["credit_note_id"]) : null}
                      label="File"
                    />
                  )}
                </td>
              </tr>
            ))}
          </DataTable>
        </FinanceQueryState>
      </SectionCard>

      <SectionCard
        title="Tax transactions"
        description="Line-level tax captured from sales and purchases, ready for the filing return."
      >
        <FinanceQueryState
          isLoading={transactions.isLoading}
          error={transactions.error}
          isEmpty={(transactions.data ?? []).length === 0}
          empty={
            <FinanceEmpty
              title="No tax transactions"
              description="Tax is recorded automatically when documents post to the ledger."
            />
          }
        >
          <DataTable
            head={["Date", "Document", "Module", "Code", "Taxable", "Rate", "Tax", "Direction"]}
          >
            {(transactions.data ?? []).map((t) => {
              const code = t["tax_codes"] as { code?: string } | null;
              return (
                <tr key={String(t["id"])}>
                  <td className="py-2 pr-4">{shortDate(t["transaction_date"])}</td>
                  <td className="py-2 pr-4 font-mono text-xs">
                    {String(t["document_number"] ?? "—")}
                  </td>
                  <td className="py-2 pr-4">{titleCase(String(t["source_module"]))}</td>
                  <td className="py-2 pr-4">{code?.code ?? "—"}</td>
                  <td className="py-2 pr-4">{money(t["taxable_amount"])}</td>
                  <td className="py-2 pr-4">{num(t["tax_rate"])}%</td>
                  <td className="py-2 pr-4 font-medium">{money(t["tax_amount"])}</td>
                  <td className="py-2 pr-4">{titleCase(String(t["direction"]))}</td>
                </tr>
              );
            })}
          </DataTable>
        </FinanceQueryState>
      </SectionCard>
    </div>
  );
}
