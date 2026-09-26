import { useMemo, useState } from "react";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import {
  InspectorField,
  InspectorSection,
  InspectorSheet,
} from "@/components/common/InspectorSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  financeHead,
} from "@/components/finance/FinanceShared";
import {
  JOURNAL_STATUSES,
  JOURNAL_TYPES,
  journalTotals,
  money,
  shortDate,
  titleCase,
} from "@/lib/finance";
import {
  useAccounts,
  useCreateJournal,
  useJournal,
  useJournalRegister,
  usePostJournal,
  useReverseJournal,
} from "@/lib/finance-data";

export const Route = createFileRoute("/_shell/finance/journals")({
  head: financeHead(
    "Journal Entries",
    "Double-entry journals with balance validation, period control, approval and reversal-only corrections.",
  ),
  component: () => (
    <FinanceGuard feature="journals" action="view">
      <JournalsPage />
    </FinanceGuard>
  ),
});

type Line = { account_id: string; description: string; debit: string; credit: string };

const emptyLine = (): Line => ({ account_id: "", description: "", debit: "", credit: "" });

type Lens = "none" | "draft" | "posted" | "manual" | "unbalanced";

const SOURCES = [
  { value: "all", label: "All sources" },
  { value: "manual", label: "Manual" },
  { value: "pms", label: "Rooms & deposits" },
  { value: "pos", label: "Point of sale" },
  { value: "procurement", label: "Goods received" },
  { value: "payables", label: "Payables" },
  { value: "events", label: "Events" },
  { value: "delivery", label: "Delivery" },
];

function JournalsPage() {
  const [status, setStatus] = useState("all");
  const [source, setSource] = useState("all");
  const [lens, setLens] = useState<Lens>("none");
  const [selected, setSelected] = useState<string | null>(null);
  const journals = useJournalRegister(status, source);

  const detail = useJournal(selected);
  const selectedRow = (journals.data ?? []).find((j) => j.id === selected) ?? null;
  const accounts = useAccounts();
  const post = usePostJournal();
  const reverse = useReverseJournal();

  const postable = (accounts.data ?? []).filter(
    (a) => a["postable"] !== false && a["active"] !== false,
  );

  const rows = journals.data ?? [];
  const draftCount = rows.filter((j) => j.status === "draft").length;
  const postedCount = rows.filter((j) => j.status === "posted").length;
  const manualCount = rows.filter((j) => (j.source_module ?? "manual") === "manual").length;
  const unbalanced = rows.filter((j) => j.status === "posted" && !j.balanced).length;

  const toggleLens = (next: Lens) => setLens((prev) => (prev === next ? "none" : next));

  const filteredRows = useMemo(() => {
    if (lens === "draft") return rows.filter((j) => j.status === "draft");
    if (lens === "posted") return rows.filter((j) => j.status === "posted");
    if (lens === "manual") return rows.filter((j) => (j.source_module ?? "manual") === "manual");
    if (lens === "unbalanced") return rows.filter((j) => j.status === "posted" && !j.balanced);
    return rows;
  }, [rows, lens]);

  const lead: SummaryFigure = {
    id: "count",
    label: "Journals",
    value: journals.isLoading ? "…" : rows.length,
  };
  const figures: SummaryFigure[] = [
    {
      id: "draft",
      label: "Draft",
      value: journals.isLoading ? "…" : draftCount,
      onSelect: () => toggleLens("draft"),
      active: lens === "draft",
    },
    {
      id: "posted",
      label: "Posted",
      value: journals.isLoading ? "…" : postedCount,
      tone: "success",
      onSelect: () => toggleLens("posted"),
      active: lens === "posted",
    },
    {
      id: "manual",
      label: "Manual",
      value: journals.isLoading ? "…" : manualCount,
      onSelect: () => toggleLens("manual"),
      active: lens === "manual",
    },
    {
      id: "unbalanced",
      label: "Out of balance",
      value: journals.isLoading ? "…" : unbalanced,
      tone: unbalanced > 0 ? "destructive" : "default",
      onSelect: () => toggleLens("unbalanced"),
      active: lens === "unbalanced",
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Finance"
        title="Journal Entries"
        description="A journal only reaches the ledger when debits equal credits and the accounting period is open. Posted journals are immutable — corrections are made with a reversal."
        actions={<NewJournalDialog accounts={postable} />}
      />

      <SummaryStrip lead={lead} figures={figures} />

      <div className="surface-panel rounded-2xl p-3 sm:p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-foreground">{filteredRows.length} journal(s)</p>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger className="h-9 w-52" aria-label="Filter journals by source module">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="h-9 w-48" aria-label="Filter journals by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {JOURNAL_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>


        <FinanceQueryState
          isLoading={journals.isLoading}
          error={journals.error}
          isEmpty={filteredRows.length === 0}
          empty={
            <FinanceEmpty
              title="No journals yet"
              description="Operational modules post automatically once account mappings are configured, or create a manual journal above."
            />
          }
        >
          <DataTable
            head={[
              "Journal",
              "Date",
              "Period",
              "Source",
              "Document",
              "Description",
              "Debit",
              "Credit",
              "Property",
              "Status",
              "",
            ]}
          >
            {filteredRows.map((j) => (
              <tr
                key={j.id}
                className="cursor-pointer hover:bg-muted/40"
                onClick={() => setSelected(j.id)}
              >
                <td className="py-2 pr-4 font-mono text-xs">{j.journal_number ?? "—"}</td>
                <td className="py-2 pr-4">{shortDate(j.accounting_date)}</td>
                <td className="py-2 pr-4 text-muted-foreground">
                  {j.period_name ?? "Unassigned"}
                </td>
                <td className="py-2 pr-4 text-muted-foreground">
                  {titleCase(String(j.source_module ?? "manual"))}
                </td>
                <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                  {j.document_number ?? j.source_document_type ?? "—"}
                </td>
                <td className="max-w-[22ch] truncate py-2 pr-4 text-muted-foreground">
                  {j.description ?? "—"}
                </td>
                <td className="py-2 pr-4 tabular-nums">{money(j.total_debit)}</td>
                <td className="py-2 pr-4 tabular-nums">
                  <span className={j.balanced ? "" : "font-semibold text-destructive"}>
                    {money(j.total_credit)}
                  </span>
                </td>
                <td className="py-2 pr-4 text-muted-foreground">{j.property ?? "—"}</td>
                <td className="py-2 pr-4">
                  <FinStatus value={j.status} />
                </td>
                <td className="py-2 pr-4 text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="flex justify-end gap-1">
                    {j.status === "draft" || j.status === "approved" ? (
                      <Button size="sm" onClick={() => post.mutate(j.id)} disabled={post.isPending}>
                        Post
                      </Button>
                    ) : null}
                    {j.status === "posted" && !j.reversed_by_journal_id ? (
                      <ReverseDialog
                        onConfirm={(reason) => reverse.mutate({ journalId: j.id, reason })}
                        busy={reverse.isPending}
                      />
                    ) : null}
                    {j.reversed_by_journal_number ? (
                      <span className="text-xs text-muted-foreground">
                        Reversed by {j.reversed_by_journal_number}
                      </span>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </DataTable>
        </FinanceQueryState>
      </div>

      <InspectorSheet
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(null)}
        title={`Journal ${String(detail.data?.["journal_number"] ?? "")}`}
        subtitle={String(detail.data?.["description"] ?? "Journal lines")}
        chips={detail.data ? <FinStatus value={String(detail.data["status"])} /> : null}
      >
        <FinanceQueryState
          isLoading={detail.isLoading}
          error={detail.error}
          isEmpty={!detail.data}
          empty={<FinanceEmpty title="Journal not found" description="It may have been removed." />}
        >
          <InspectorSection title="Posting trail">
            <InspectorField label="Accounting date">
              {shortDate(detail.data?.["accounting_date"])}
            </InspectorField>
            <InspectorField label="Type">
              {titleCase(String(detail.data?.["journal_type"] ?? ""))}
            </InspectorField>
            <InspectorField label="Source">
              {titleCase(String(detail.data?.["source_module"] ?? "manual"))}
            </InspectorField>
            <InspectorField label="Source document">
              {String(detail.data?.["document_number"] ?? detail.data?.["source_document_type"] ?? "—")}
            </InspectorField>
            <InspectorField label="Prepared by">
              {selectedRow?.created_by_name ?? "—"}
            </InspectorField>
            <InspectorField label="Posted by">
              {selectedRow?.posted_by_name ?? (selectedRow?.status === "posted" ? "System" : "Not posted")}
            </InspectorField>
            <InspectorField label="Posted at">{shortDate(selectedRow?.posted_at)}</InspectorField>
            <InspectorField label="Period">
              {selectedRow?.period_name ?? "Unassigned"}
              {selectedRow?.period_status ? ` · ${titleCase(selectedRow.period_status)}` : ""}
            </InspectorField>
            <InspectorField label="Balance check">
              {selectedRow
                ? selectedRow.balanced
                  ? "Debits equal credits"
                  : "Out of balance — this journal must be corrected by reversal"
                : "—"}
            </InspectorField>
            <InspectorField label="Reversal">
              {selectedRow?.reverses_journal_number
                ? `Reverses ${selectedRow.reverses_journal_number}`
                : selectedRow?.reversed_by_journal_number
                  ? `Reversed by ${selectedRow.reversed_by_journal_number}`
                  : "None"}
            </InspectorField>
          </InspectorSection>
          <InspectorSection title="Lines">
            <DataTable head={["#", "Account", "Description", "Debit", "Credit"]}>
              {((detail.data?.["journal_entry_lines"] ?? []) as Record<string, unknown>[])
                .slice()
                .sort((a, b) => Number(a["line_number"]) - Number(b["line_number"]))
                .map((l) => {
                  const acc = l["chart_of_accounts"] as { code?: string; name?: string } | null;
                  return (
                    <tr key={String(l["id"])}>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {String(l["line_number"])}
                      </td>
                      <td className="py-2 pr-4">{acc ? `${acc.code} — ${acc.name}` : "—"}</td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {String(l["description"] ?? "")}
                      </td>
                      <td className="py-2 pr-4">{money(l["debit"])}</td>
                      <td className="py-2 pr-4">{money(l["credit"])}</td>
                    </tr>
                  );
                })}
            </DataTable>
          </InspectorSection>
        </FinanceQueryState>
      </InspectorSheet>
    </div>
  );
}

function NewJournalDialog({ accounts }: { accounts: Record<string, unknown>[] }) {
  const create = useCreateJournal();
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [type, setType] = useState("general");
  const [description, setDescription] = useState("");

  const totals = journalTotals(lines);
  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  return (
    <FormDialog
      title="New journal"
      description="Manual journals must balance and land in an open accounting period. They are created as drafts."
    >
      {(close) => (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="j-date" className="text-xs text-muted-foreground">
                Accounting date
              </Label>
              <NeoDatePicker id="j-date" value={date} onChange={setDate} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="j-type" className="text-xs text-muted-foreground">
                Journal type
              </Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger id="j-type" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {JOURNAL_TYPES.filter((t) => t !== "reversal").map((t) => (
                    <SelectItem key={t} value={t}>
                      {titleCase(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-3">
              <Label htmlFor="j-desc" className="text-xs text-muted-foreground">
                Narration
              </Label>
              <Textarea
                id="j-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Reason for this journal"
              />
            </div>
          </div>

          <div className="space-y-2">
            {lines.map((l, i) => (
              <div
                key={i}
                className="grid gap-2 rounded-lg border border-border/70 p-2 sm:grid-cols-[2fr_2fr_1fr_1fr_auto]"
              >
                <Select value={l.account_id} onValueChange={(v) => setLine(i, { account_id: v })}>
                  <SelectTrigger className="h-9" aria-label={`Account for line ${i + 1}`}>
                    <SelectValue placeholder="Account" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((a) => (
                      <SelectItem key={String(a["id"])} value={String(a["id"])}>
                        {String(a["code"])} — {String(a["name"])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={l.description}
                  placeholder="Line description"
                  aria-label={`Description for line ${i + 1}`}
                  onChange={(e) => setLine(i, { description: e.target.value })}
                />
                <Input
                  value={l.debit}
                  type="number"
                  step="0.01"
                  placeholder="Debit"
                  aria-label={`Debit for line ${i + 1}`}
                  onChange={(e) => setLine(i, { debit: e.target.value, credit: "" })}
                />
                <Input
                  value={l.credit}
                  type="number"
                  step="0.01"
                  placeholder="Credit"
                  aria-label={`Credit for line ${i + 1}`}
                  onChange={(e) => setLine(i, { credit: e.target.value, debit: "" })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove line ${i + 1}`}
                  onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setLines((ls) => [...ls, emptyLine()])}
            >
              <Plus className="size-4" /> Add line
            </Button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted px-3 py-2 text-sm">
            <span>Debits {money(totals.debit)}</span>
            <span>Credits {money(totals.credit)}</span>
            <span className={totals.balanced ? "text-success" : "text-destructive"}>
              {totals.balanced
                ? "Balanced"
                : `Out of balance by ${money(Math.abs(totals.debit - totals.credit))}`}
            </span>
          </div>

          <Button
            disabled={!totals.balanced || create.isPending}
            onClick={() =>
              create.mutate(
                {
                  header: {
                    accounting_date: date,
                    journal_type: type,
                    description,
                    source_module: "manual",
                  },
                  lines: lines
                    .filter((l) => l.account_id && (Number(l.debit) > 0 || Number(l.credit) > 0))
                    .map((l) => ({
                      account_id: l.account_id,
                      description: l.description,
                      debit: Number(l.debit || 0),
                      credit: Number(l.credit || 0),
                    })),
                },
                { onSuccess: close },
              )
            }
          >
            Create draft journal
          </Button>
        </div>
      )}
    </FormDialog>
  );
}

function ReverseDialog({
  onConfirm,
  busy,
}: {
  onConfirm: (reason: string) => void;
  busy: boolean;
}) {
  const [reason, setReason] = useState("");
  return (
    <FormDialog
      trigger={
        <Button size="sm" variant="outline">
          Reverse
        </Button>
      }
      title="Reverse journal"
      description="Posted journals cannot be edited or deleted. A reversal journal with the opposite entries is posted instead, and both remain visible."
    >
      {(close) => (
        <div className="space-y-3">
          <Label htmlFor="rev-reason" className="text-xs text-muted-foreground">
            Reason (recorded in the audit trail)
          </Label>
          <Textarea
            id="rev-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
          />
          <Button
            disabled={reason.trim().length < 5 || busy}
            onClick={() => {
              onConfirm(reason.trim());
              close();
            }}
          >
            Post reversal
          </Button>
        </div>
      )}
    </FormDialog>
  );
}
