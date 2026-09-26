import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import {
  InspectorField,
  InspectorSection,
  InspectorSheet,
} from "@/components/common/InspectorSheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import {
  ageingBucket,
  ageInvoices,
  AGEING_LABELS,
  INVOICE_STATUSES,
  money,
  num,
  shortDate,
  titleCase,
} from "@/lib/finance";
import {
  useCollectionNotes,
  useCorporateAccounts,
  useCreditApplications,
  useCreditNotes,
  useFinanceInsert,
  useInvoices,
  useStatements,
} from "@/lib/finance-data";
import { DocumentPrintButton } from "@/components/common/DocumentPrintButton";
import { RecordReceiptDialog } from "@/components/finance/RecordReceiptDialog";
import { useCampaigns } from "@/lib/marketing-data";

export const Route = createFileRoute("/_shell/finance/receivables")({
  head: financeHead(
    "Accounts Receivable",
    "Invoices, credit notes, corporate credit applications, statements and collection follow-up.",
  ),
  component: () => (
    <FinanceGuard feature="receivables" action="view">
      <ReceivablesPage />
    </FinanceGuard>
  ),
});

type Bucket = "all" | "current" | "d30" | "d60" | "d90" | "over90";

function ReceivablesPage() {
  const [status, setStatus] = useState("all");
  const [bucket, setBucket] = useState<Bucket>("all");
  const [inspectId, setInspectId] = useState<string | null>(null);
  const invoices = useInvoices(status);
  const creditNotes = useCreditNotes();
  const applications = useCreditApplications();
  const statements = useStatements();
  const notes = useCollectionNotes();
  const corporates = useCorporateAccounts();
  // Money can be credited to the campaign that won the business, but only when
  // an operator names it — nothing is attributed by guesswork.
  const campaigns = useCampaigns();
  const campaignChoices = useMemo(
    () =>
      (campaigns.data ?? [])
        .filter((c) => ["running", "active", "completed"].includes(String(c["status"] ?? "")))
        .map((c) => ({ id: String(c["id"]), name: String(c["name"] ?? "Campaign") })),
    [campaigns.data],
  );
  const createNote = useFinanceInsert("collection_notes", "finance.collection_note.created", {
    branchScoped: false,
  });

  const rows = invoices.data ?? [];
  const open = rows.filter((i) =>
    ["issued", "partially_paid", "overdue"].includes(String(i["status"])),
  );
  const buckets = ageInvoices(open);
  const outstanding = open.reduce((s, i) => s + num(i["balance"]), 0);

  const filteredRows = useMemo(
    () => (bucket === "all" ? rows : rows.filter((i) => ageingBucket(i["due_date"]) === bucket)),
    [rows, bucket],
  );

  const toggleBucket = (b: Bucket) => setBucket((prev) => (prev === b ? "all" : b));

  const lead: SummaryFigure = {
    id: "outstanding",
    label: "Outstanding",
    value: invoices.isLoading ? "…" : money(outstanding),
    hint: `${open.length} open invoice(s)`,
  };
  const figures: SummaryFigure[] = (Object.keys(AGEING_LABELS) as Bucket[]).map((k) => ({
    id: k,
    label: AGEING_LABELS[k] ?? k,
    value: invoices.isLoading ? "…" : money(buckets[k] ?? 0),
    tone: k === "over90" || k === "d90" ? "warning" : "default",
    onSelect: () => toggleBucket(k),
    active: bucket === k,
  }));

  const inspected = filteredRows.find((i) => String(i["id"]) === inspectId) ?? null;
  const inspectedCust = inspected?.["customers"] as { full_name?: string } | null;
  const inspectedCorp = inspected?.["corporate_accounts"] as { legal_name?: string } | null;

  const noteFields: FieldSpec[] = [
    {
      name: "corporate_account_id",
      label: "Corporate account",
      type: "select",
      options: (corporates.data ?? []).map((c) => ({
        value: String(c["id"]),
        label: String(c["legal_name"]),
      })),
    },
    {
      name: "note_type",
      label: "Contact type",
      type: "select",
      required: true,
      options: ["call", "email", "visit", "letter", "promise", "dispute"].map((v) => ({
        value: v,
        label: titleCase(v),
      })),
    },
    { name: "promised_amount", label: "Promised amount", type: "number" },
    { name: "promised_date", label: "Promised date", type: "date" },
    { name: "note", label: "Note", type: "textarea", required: true, span: true },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Finance"
        title="Accounts Receivable"
        description="Invoices raised from folios, events and corporate billing, with ageing, statements and collection history."
      />

      <SummaryStrip lead={lead} figures={figures} />

      <Tabs defaultValue="invoices" className="w-full">
        <TabsList className="mb-3">
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="credit-notes">Credit notes</TabsTrigger>
          <TabsTrigger value="applications">Credit applications</TabsTrigger>
          <TabsTrigger value="statements">Statements</TabsTrigger>
          <TabsTrigger value="collections">Collection follow-up</TabsTrigger>
        </TabsList>

        <TabsContent value="invoices" className="mt-0">
          <div className="surface-panel rounded-2xl p-3 sm:p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-foreground">
                {filteredRows.length} invoice(s)
              </p>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="h-9 w-48" aria-label="Filter invoices by status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {INVOICE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {titleCase(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <FinanceQueryState
              isLoading={invoices.isLoading}
              error={invoices.error}
              isEmpty={filteredRows.length === 0}
              empty={
                <FinanceEmpty
                  title="No invoices"
                  description="Invoices are raised from folios at check-out, from event billing and from corporate accounts."
                />
              }
            >
              <DataTable
                head={[
                  "Invoice",
                  "Bill to",
                  "Type",
                  "Issued",
                  "Due",
                  "Total",
                  "Balance",
                  "Tax status",
                  "Status",
                  "Receipt",
                  "Document",
                ]}
              >
                {filteredRows.map((i) => {
                  const cust = i["customers"] as { full_name?: string } | null;
                  const corp = i["corporate_accounts"] as { legal_name?: string } | null;
                  return (
                    <tr
                      key={String(i["id"])}
                      className="cursor-pointer hover:bg-muted/40"
                      onClick={() => setInspectId(String(i["id"]))}
                    >
                      <td className="py-2 pr-4 font-mono text-xs">{String(i["invoice_number"])}</td>
                      <td className="py-2 pr-4">{corp?.legal_name ?? cust?.full_name ?? "—"}</td>
                      <td className="py-2 pr-4">{titleCase(String(i["document_type"]))}</td>
                      <td className="py-2 pr-4">{shortDate(i["issue_date"])}</td>
                      <td className="py-2 pr-4">{shortDate(i["due_date"])}</td>
                      <td className="py-2 pr-4">
                        {money(i["total"], String(i["currency"] ?? "KES"))}
                      </td>
                      <td className="py-2 pr-4 font-semibold">
                        {money(i["balance"], String(i["currency"] ?? "KES"))}
                      </td>
                      <td className="py-2 pr-4">
                        <FinStatus value={String(i["etims_status"] ?? "not_required")} />
                      </td>
                      <td className="py-2 pr-4">
                        <FinStatus value={String(i["status"])} />
                      </td>
                      <td className="py-2 pr-4" onClick={(e) => e.stopPropagation()}>
                        <RecordReceiptDialog invoice={i} campaigns={campaignChoices} />
                      </td>
                      <td className="py-2 pr-4" onClick={(e) => e.stopPropagation()}>
                        <DocumentPrintButton type="invoice" id={String(i["id"])} label="PDF" />
                      </td>
                    </tr>
                  );
                })}
              </DataTable>
            </FinanceQueryState>
          </div>
        </TabsContent>

        <TabsContent value="credit-notes" className="mt-0">
          <div className="surface-panel rounded-2xl p-3 sm:p-4">
            <FinanceQueryState
              isLoading={creditNotes.isLoading}
              error={creditNotes.error}
              isEmpty={(creditNotes.data ?? []).length === 0}
              empty={
                <FinanceEmpty
                  title="No credit notes"
                  description="Corrections to issued invoices are made with an approved credit note."
                />
              }
            >
              <DataTable head={["Note", "Kind", "Issued", "Total", "Status"]}>
                {(creditNotes.data ?? []).map((c) => (
                  <tr key={String(c["id"])}>
                    <td className="py-2 pr-4 font-mono text-xs">{String(c["note_number"])}</td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {titleCase(String(c["note_kind"]))}
                    </td>
                    <td className="py-2 pr-4">{shortDate(c["issue_date"])}</td>
                    <td className="py-2 pr-4">{money(c["total"])}</td>
                    <td className="py-2 pr-4">
                      <FinStatus value={String(c["status"])} />
                    </td>
                  </tr>
                ))}
              </DataTable>
            </FinanceQueryState>
          </div>
        </TabsContent>

        <TabsContent value="applications" className="mt-0">
          <div className="surface-panel rounded-2xl p-3 sm:p-4">
            <FinanceQueryState
              isLoading={applications.isLoading}
              error={applications.error}
              isEmpty={(applications.data ?? []).length === 0}
              empty={
                <FinanceEmpty
                  title="No credit applications"
                  description="Companies applying for billing terms appear here for review and approval."
                />
              }
            >
              <DataTable head={["Applicant", "Requested", "Terms", "Approved", "Status"]}>
                {(applications.data ?? []).map((a) => (
                  <tr key={String(a["id"])}>
                    <td className="py-2 pr-4">{String(a["applicant_name"])}</td>
                    <td className="py-2 pr-4">{money(a["requested_limit"])}</td>
                    <td className="py-2 pr-4">{num(a["requested_terms_days"])} days</td>
                    <td className="py-2 pr-4">
                      {a["approved_limit"] == null ? "—" : money(a["approved_limit"])}
                    </td>
                    <td className="py-2 pr-4">
                      <FinStatus value={String(a["status"])} />
                    </td>
                  </tr>
                ))}
              </DataTable>
            </FinanceQueryState>
          </div>
        </TabsContent>

        <TabsContent value="statements" className="mt-0">
          <div className="surface-panel rounded-2xl p-3 sm:p-4">
            <FinanceQueryState
              isLoading={statements.isLoading}
              error={statements.error}
              isEmpty={(statements.data ?? []).length === 0}
              empty={
                <FinanceEmpty
                  title="No statements generated"
                  description="Statements summarise opening balance, charges, payments and closing balance for a period."
                />
              }
            >
              <DataTable head={["Statement", "Account", "Period", "Closing", "Over 90", "Status"]}>
                {(statements.data ?? []).map((s) => {
                  const corp = s["corporate_accounts"] as { legal_name?: string } | null;
                  const cust = s["customers"] as { full_name?: string } | null;
                  return (
                    <tr key={String(s["id"])}>
                      <td className="py-2 pr-4 font-mono text-xs">
                        {String(s["statement_number"])}
                      </td>
                      <td className="py-2 pr-4">{corp?.legal_name ?? cust?.full_name ?? "—"}</td>
                      <td className="py-2 pr-4">
                        {shortDate(s["period_start"])} – {shortDate(s["period_end"])}
                      </td>
                      <td className="py-2 pr-4 font-semibold">{money(s["closing_balance"])}</td>
                      <td className="py-2 pr-4">{money(s["bucket_over_90"])}</td>
                      <td className="py-2 pr-4">
                        <FinStatus value={String(s["status"])} />
                      </td>
                    </tr>
                  );
                })}
              </DataTable>
            </FinanceQueryState>
          </div>
        </TabsContent>

        <TabsContent value="collections" className="mt-0">
          <div className="surface-panel rounded-2xl p-3 sm:p-4">
            <div className="mb-3 flex justify-end">
              <FormDialog
                title="Log follow-up"
                description="Record a collection contact and any payment promise."
              >
                {(close) => (
                  <RecordForm
                    fields={noteFields}
                    submitLabel="Save note"
                    busy={createNote.isPending}
                    onSubmit={(values) => createNote.mutate(values, { onSuccess: close })}
                  />
                )}
              </FormDialog>
            </div>
            <FinanceQueryState
              isLoading={notes.isLoading}
              error={notes.error}
              isEmpty={(notes.data ?? []).length === 0}
              empty={
                <FinanceEmpty
                  title="No follow-up logged"
                  description="Collection activity keeps an auditable history of every promise to pay."
                />
              }
            >
              <DataTable head={["Account", "Type", "Promised", "Due", "Note"]}>
                {(notes.data ?? []).map((n) => {
                  const corp = n["corporate_accounts"] as { legal_name?: string } | null;
                  const cust = n["customers"] as { full_name?: string } | null;
                  return (
                    <tr key={String(n["id"])}>
                      <td className="py-2 pr-4">{corp?.legal_name ?? cust?.full_name ?? "—"}</td>
                      <td className="py-2 pr-4">{titleCase(String(n["note_type"]))}</td>
                      <td className="py-2 pr-4">
                        {n["promised_amount"] == null ? "—" : money(n["promised_amount"])}
                      </td>
                      <td className="py-2 pr-4">{shortDate(n["promised_date"])}</td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {String(n["note"] ?? "")}
                      </td>
                    </tr>
                  );
                })}
              </DataTable>
            </FinanceQueryState>
          </div>
        </TabsContent>
      </Tabs>

      <InspectorSheet
        open={Boolean(inspected)}
        onOpenChange={(open) => !open && setInspectId(null)}
        title={inspected ? String(inspected["invoice_number"]) : ""}
        subtitle={inspectedCorp?.legal_name ?? inspectedCust?.full_name ?? undefined}
        chips={
          inspected ? (
            <>
              <FinStatus value={String(inspected["status"])} />
              <FinStatus value={String(inspected["etims_status"] ?? "not_required")} />
            </>
          ) : null
        }
        footer={
          inspected ? (
            <DocumentPrintButton
              type="invoice"
              id={String(inspected["id"])}
              label="Print invoice"
            />
          ) : null
        }
      >
        {inspected ? (
          <InspectorSection title="Invoice">
            <InspectorField label="Type">
              {titleCase(String(inspected["document_type"]))}
            </InspectorField>
            <InspectorField label="Issued">{shortDate(inspected["issue_date"])}</InspectorField>
            <InspectorField label="Due">{shortDate(inspected["due_date"])}</InspectorField>
            <InspectorField label="Total">
              {money(inspected["total"], String(inspected["currency"] ?? "KES"))}
            </InspectorField>
            <InspectorField label="Balance">
              {money(inspected["balance"], String(inspected["currency"] ?? "KES"))}
            </InspectorField>
          </InspectorSection>
        ) : null}
      </InspectorSheet>
    </div>
  );
}
