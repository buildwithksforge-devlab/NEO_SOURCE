/**
 * Hotel Data Onboarding Centre.
 *
 * Useful before a single file is uploaded: a property with nothing but a blank
 * workspace can read what NEØ expects, download a template or a worked
 * example, and prepare itself. A property that already keeps spreadsheets can
 * upload them exactly as they are.
 */
import { useMemo, useState } from "react";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { Download, FileSpreadsheet, RotateCcw, Trash2, Upload } from "lucide-react";
import { SectionCard, StatCard } from "@/components/common/DataDisplay";
import { AccessDenied, EmptyState, formatDateTime, humanise } from "@/components/platform/PlatformShared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import { ImportWizard } from "@/components/onboarding/ImportWizard";
import {
  ONBOARDING_DOMAINS,
  blankTemplateCsv,
  domainByKey,
  domainsByStage,
  prerequisiteDomains,
  exampleCsv,
  type OnboardingDomain,
} from "@/lib/onboarding/domains";
import { downloadCsv } from "@/lib/onboarding/parse";
import {
  DISCARDABLE_STAGES,
  isEngineBatch,
  useAdoptBatch,
  useDiscardBatch,
  useOnboardingBatches,
  useOnboardingBatchRows,
  useReverseBatch,
} from "@/lib/onboarding/data";

export const Route = createFileRoute("/_shell/platform/migration")({
  validateSearch: (search: Record<string, unknown>) => ({
    domain: typeof search["domain"] === "string" ? (search["domain"] as string) : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Hotel Data Onboarding — NEØ Administration" },
      {
        name: "description",
        content:
          "Prepare, map and import your existing hotel data — assets, people, rooms, stock, suppliers and guests — without restructuring your spreadsheets first.",
      },
      { property: "og:title", content: "Hotel Data Onboarding — NEØ Administration" },
      {
        property: "og:description",
        content: "Templates, field guides and intelligent mapping for onboarding an existing hotel into NEØ.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: OnboardingCentre,
});

const REQUIREMENT_TONE: Record<string, string> = {
  required: "text-destructive",
  recommended: "text-foreground",
  optional: "text-muted-foreground",
};

type BatchLike = Record<string, unknown>;

/** The one lifecycle every batch is described by, in plain words. */
function lifecycleOf(batch: BatchLike): { label: string; meaning: string } {
  const stage = String(batch["stage"] ?? "");
  const status = String(batch["status"] ?? "");
  const created = Number(batch["imported_rows"] ?? 0);
  if (batch["reversed_at"]) return { label: "Reversed", meaning: "Created records were safely undone." };
  if (status === "reconciled") return { label: "Reconciled", meaning: "Created records agree with what was approved." };
  if (stage === "completed") return { label: "Imported", meaning: `${created} record(s) created.` };
  if (stage === "completed_with_exceptions")
    return { label: "Completed with exceptions", meaning: `${created} created; blocked rows kept for correction.` };
  if (stage === "importing") return { label: "Importing", meaning: "Records are being created now." };
  if (stage === "failed") return { label: "Failed", meaning: "No records were created." };
  if (stage === "discarded") return { label: "Discarded", meaning: "Abandoned before anything was created." };
  if (stage === "ready") return { label: "Ready to import", meaning: "Approved and waiting to create records." };
  if (stage === "prepared" || stage === "draft")
    return { label: "Draft", meaning: "Being mapped and corrected; nothing created." };
  return { label: "Dry run", meaning: "Validated only — nothing was created." };
}

function asList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) =>
    typeof entry === "string" ? entry : typeof entry === "object" && entry ? JSON.stringify(entry) : String(entry),
  );
}

/** Valid, Warning or Blocked — the only three states a row is ever shown in. */
function rowState(row: BatchLike): { key: "valid" | "warning" | "blocked"; label: string; tone: string } {
  const status = String(row["status"] ?? "");
  const severity = String(row["severity"] ?? "");
  const blocked =
    severity === "blocker" ||
    ["invalid", "failed", "blocked"].includes(status) ||
    asList(row["errors"]).length > 0;
  if (blocked) return { key: "blocked", label: "Blocked", tone: "text-destructive" };
  if (asList(row["warnings"]).length > 0 || severity === "decision")
    return { key: "warning", label: "Warning", tone: "text-warning" };
  return { key: "valid", label: "Valid", tone: "text-success" };
}

function DomainCard({
  domain,
  selected,
  onSelect,
}: {
  domain: OnboardingDomain;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`rounded-lg border p-4 text-left transition ${
        selected ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium">{domain.label}</span>
        {domain.supported ? null : (
          <Badge variant="outline" className="text-[10px] font-normal">
            Coming soon
          </Badge>
        )}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">{domain.blurb}</p>
    </button>
  );
}

function OnboardingCentre() {
  const { can, isAdmin } = useAuth();
  const search = useSearch({ from: "/_shell/platform/migration" });
  const [domainKey, setDomainKey] = useState<string>(search.domain ?? "assets");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [selectedBatch, setSelectedBatch] = useState<string | null>(null);
  const [continueBatch, setContinueBatch] = useState<string | null>(null);
  const [rowFilter, setRowFilter] = useState<"all" | "blocked" | "warning" | "valid">("all");

  const batches = useOnboardingBatches();
  // Every uploaded row stays visible: nothing is hidden behind a page limit.
  const rows = useOnboardingBatchRows(selectedBatch, 10000);
  const reverse = useReverseBatch();
  const discard = useDiscardBatch();
  const adopt = useAdoptBatch();

  const domain = useMemo(() => domainByKey(domainKey) ?? ONBOARDING_DOMAINS[0]!, [domainKey]);
  const prerequisites = useMemo(() => prerequisiteDomains(domain), [domain]);
  const visibleRows = useMemo(
    () => (rows.data ?? []).filter((row) => rowFilter === "all" || rowState(row).key === rowFilter),
    [rowFilter, rows.data],
  );

  if (!isAdmin && !can("migration", "view")) {
    return (
      <AccessDenied
        title="Data onboarding is restricted"
        body="Ask an administrator for the data migration capability on your role."
      />
    );
  }

  const grouped = {
    required: domain.fields.filter((f) => f.requirement === "required"),
    recommended: domain.fields.filter((f) => f.requirement === "recommended"),
    optional: domain.fields.filter((f) => f.requirement === "optional"),
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Hotel Data Onboarding</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Choose what you are bringing into NEØ. Each data type tells you what is expected before you upload
          anything — and when you do upload, NEØ reads your file as you already keep it.
        </p>
      </div>

      <div className="space-y-6">
        {domainsByStage().map(({ stage, domains }, index) => (
          <div key={stage.key}>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Step {index + 1} · {stage.label}
            </p>
            <p className="mt-1 max-w-3xl text-xs text-muted-foreground">{stage.blurb}</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {domains.map((item) => (
                <DomainCard
                  key={item.key}
                  domain={item}
                  selected={item.key === domain.key}
                  onSelect={() => setDomainKey(item.key)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {prerequisites.length > 0 ? (
        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <p className="text-sm font-medium">Configure these first</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {domain.label} records refer to them, so NEØ can only match names it already has.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {prerequisites.map((item) => (
              <Button key={item.key} variant="outline" size="sm" onClick={() => setDomainKey(item.key)}>
                {item.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}


      <SectionCard
        title={`${domain.label} — what NEØ expects`}
        description={
          domain.supported
            ? "Required fields must be present for a record to be created. Everything else can follow later."
            : "This data type is documented but not yet importable. You can still prepare your file."
        }
      >
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => downloadCsv(`${domain.key}-template.csv`, blankTemplateCsv(domain))}
          >
            <Download aria-hidden className="mr-2 size-4" />
            Blank template
          </Button>
          <Button variant="secondary" onClick={() => downloadCsv(`${domain.key}-example.csv`, exampleCsv(domain))}>
            <FileSpreadsheet aria-hidden className="mr-2 size-4" />
            Completed example
          </Button>
          <Button disabled={!domain.supported} onClick={() => setWizardOpen(true)}>
            <Upload aria-hidden className="mr-2 size-4" />
            Upload existing data
          </Button>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-3">
          {(["required", "recommended", "optional"] as const).map((bucket) => (
            <div key={bucket} className="rounded-lg border border-border p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {bucket === "optional" ? "Optional / enrichment" : bucket} fields
              </p>
              <ul className="mt-3 space-y-3">
                {grouped[bucket].length === 0 ? (
                  <li className="text-sm text-muted-foreground">None.</li>
                ) : (
                  grouped[bucket].map((field) => (
                    <li key={field.key} className="text-sm">
                      <span className={`font-medium ${REQUIREMENT_TONE[bucket]}`}>{field.label}</span>
                      <span className="block text-xs text-muted-foreground">{field.meaning}</span>
                      <span className="block text-xs text-muted-foreground">
                        Format: {field.format} · e.g. {field.example || "—"}
                        {field.relationship ? ` · links to your ${humanise(field.relationship)} records` : ""}
                      </span>
                    </li>
                  ))
                )}
              </ul>
            </div>
          ))}
        </div>

        {domain.linksTo.length > 0 ? (
          <p className="mt-4 text-xs text-muted-foreground">
            Relationships resolved during import: {domain.linksTo.map((t) => humanise(t)).join(" · ")}. NEØ matches by
            name and proposes the closest record — it never creates a master you did not define.
          </p>
        ) : null}
      </SectionCard>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Import batches" value={String(batches.data?.length ?? 0)} />
        <StatCard
          label="Records created"
          value={String((batches.data ?? []).reduce((sum, b) => sum + Number(b["imported_rows"] ?? 0), 0))}
        />
        <StatCard
          label="With exceptions"
          value={String(
            (batches.data ?? []).filter((b) => String(b["stage"] ?? "") === "completed_with_exceptions").length,
          )}
        />
        <StatCard label="Reversed" value={String((batches.data ?? []).filter((b) => b["reversed_at"]).length)} />
      </div>

      <SectionCard
        title="Import batches"
        description="One lifecycle for every batch: dry run validates only, import creates records, completed with exceptions keeps blocked rows, reconciled means the created records agree with what was approved, and reversed means they were safely undone."
      >
        {(batches.data ?? []).length === 0 ? (
          <EmptyState title="No imports yet" body="Uploaded batches will be listed here with full lineage." />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Data type</TableHead>
                  <TableHead>Source file</TableHead>
                  <TableHead>Lifecycle</TableHead>
                  <TableHead>Rows</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(batches.data ?? []).map((batch) => {
                  const id = String(batch["id"]);
                  const stage = String(batch["stage"] ?? "");
                  const lifecycle = lifecycleOf(batch);
                  const continuable =
                    !batch["reversed_at"] &&
                    Number(batch["imported_rows"] ?? 0) === 0 &&
                    Number(batch["row_count"] ?? 0) >= 0 &&
                    !["importing", "completed", "discarded"].includes(stage);
                  return (
                    <TableRow key={id} data-state={selectedBatch === id ? "selected" : undefined}>
                      <TableCell className="font-medium">{String(batch["reference"] ?? "—")}</TableCell>
                      <TableCell>{humanise(String(batch["data_type"] ?? "—"))}</TableCell>
                      <TableCell className="max-w-[14rem] truncate text-xs text-muted-foreground">
                        {String(batch["source_filename"] ?? "—")}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[11px] font-normal">
                          {lifecycle.label}
                        </Badge>
                        <span className="mt-1 block text-xs text-muted-foreground">{lifecycle.meaning}</span>
                      </TableCell>
                      <TableCell className="text-sm">
                        {String(batch["imported_rows"] ?? 0)} created / {String(batch["row_count"] ?? 0)}
                        {Number(batch["failed_rows"] ?? 0) > 0 ? (
                          <span className="block text-xs text-destructive">
                            {String(batch["failed_rows"])} could not be created
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDateTime(String(batch["created_at"] ?? ""))}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => setSelectedBatch(id)}>
                          Inspect
                        </Button>
                        {continuable ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={adopt.isPending}
                            onClick={() => {
                              const type = String(batch["data_type"] ?? "");
                              if (domainByKey(type)) setDomainKey(type);
                              if (isEngineBatch(batch) && ["draft", "prepared"].includes(stage)) {
                                setContinueBatch(id);
                                setWizardOpen(true);
                                return;
                              }
                              adopt.mutate(id, {
                                onSuccess: () => {
                                  setContinueBatch(id);
                                  setWizardOpen(true);
                                },
                              });
                            }}
                          >
                            Continue
                          </Button>
                        ) : null}
                        {!batch["reversed_at"] && Number(batch["imported_rows"] ?? 0) > 0 ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={reverse.isPending}
                            onClick={() => reverse.mutate(id)}
                          >
                            <RotateCcw aria-hidden className="mr-1.5 size-3.5" />
                            Reverse
                          </Button>
                        ) : null}
                        {/* Setup mistakes are easy to undo; business history is not. */}
                        {Number(batch["imported_rows"] ?? 0) === 0 && DISCARDABLE_STAGES.includes(stage) ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            disabled={discard.isPending}
                            onClick={() => discard.mutate(id)}
                          >
                            <Trash2 aria-hidden className="mr-1.5 size-3.5" />
                            Discard
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      {selectedBatch ? (
        <SectionCard
          title="Batch rows"
          description="Every uploaded row is kept, with the exact value your file carried and the exact reason a row cannot be created."
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {(["all", "blocked", "warning", "valid"] as const).map((filter) => (
              <Button
                key={filter}
                size="sm"
                variant={rowFilter === filter ? "default" : "outline"}
                onClick={() => setRowFilter(filter)}
              >
                {filter === "all" ? "All rows" : humanise(filter)} (
                {filter === "all"
                  ? (rows.data ?? []).length
                  : (rows.data ?? []).filter((r) => rowState(r).key === filter).length}
                )
              </Button>
            ))}
            {rows.isLoading ? <span className="text-xs text-muted-foreground">Loading rows…</span> : null}
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Row</TableHead>
                  <TableHead className="w-28">State</TableHead>
                  <TableHead>What your file contained</TableHead>
                  <TableHead>What needs correcting</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-sm text-muted-foreground">
                      No rows in this state.
                    </TableCell>
                  </TableRow>
                ) : (
                  visibleRows.map((row) => {
                    const state = rowState(row);
                    const raw = (row["raw_values"] ?? {}) as Record<string, unknown>;
                    const errors = asList(row["errors"]);
                    const warnings = asList(row["warnings"]);
                    const message = String(row["error_message"] ?? "");
                    return (
                      <TableRow key={String(row["id"])} className="align-top">
                        <TableCell className="text-sm">{String(row["row_number"] ?? "—")}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-[11px] font-normal ${state.tone}`}>
                            {state.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-[28rem] text-xs text-muted-foreground">
                          {Object.keys(raw).length === 0
                            ? "—"
                            : Object.entries(raw)
                                .map(([column, value]) => `${column}: ${String(value ?? "")}`)
                                .join(" · ")}
                        </TableCell>
                        <TableCell className="max-w-[26rem] text-xs">
                          {errors.length === 0 && warnings.length === 0 && !message ? (
                            <span className="text-muted-foreground">Nothing outstanding.</span>
                          ) : (
                            <ul className="space-y-1">
                              {errors.map((text, index) => (
                                <li key={`e${index}`} className="text-destructive">
                                  {text}
                                </li>
                              ))}
                              {warnings.map((text, index) => (
                                <li key={`w${index}`} className="text-warning">
                                  {text}
                                </li>
                              ))}
                              {message ? <li className="text-muted-foreground">{message}</li> : null}
                            </ul>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            To correct these rows, use <strong>Continue</strong> on the batch above. Its rows are already stored, so
            the columns can be re-matched and the batch revalidated without uploading the file again.
          </p>
        </SectionCard>
      ) : null}

      <ImportWizard
        domain={domain}
        entryPoint="data_migration"
        open={wizardOpen}
        onOpenChange={(next) => {
          setWizardOpen(next);
          if (!next) setContinueBatch(null);
        }}
        openBatchId={continueBatch}
      />
    </div>
  );
}
