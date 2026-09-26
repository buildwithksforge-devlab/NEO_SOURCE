/**
 * The shared import experience.
 *
 * One engine, several entry points: Administration → Data Migration and the
 * "Import" action inside a module both open this wizard. Every stage is
 * review-first — nothing is written until the administrator approves the
 * import plan, and every proposal NEØ makes can be overridden.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  Info,
  Loader2,
  RotateCcw,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { OnboardingWorkspace } from "@/components/onboarding/OnboardingWorkspace";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import type { OnboardingDomain } from "@/lib/onboarding/domains";
import {
  SEVERITY_META,
  buildImportPlan,
  commitReadiness,
  identifierPreview,
  prepareRows,
  profileRows,
  proposeColumnMapping,
  relevantTransforms,
  semanticProfile,
  suspectIdentifierFields,
  type ColumnProposal,
  type DecisionGroup,
  type IdentifierChoice,
  type MasterOption,
  type PreparedRow,
  type SheetTable,
  type TransformKey,
  type ValueFill,
} from "@/lib/onboarding/engine";
import { classifyFile, extractUniqueValues } from "@/lib/onboarding/intent";
import { missingValueGroups, resolutionContract, summaryCounters } from "@/lib/onboarding/resolution";
import { readWorkbook } from "@/lib/onboarding/parse";
import {
  useDiscardBatch,
  useExistingIdentities,
  useOnboardingBatch,
  useOnboardingBatchRows,
  useOnboardingDrafts,
  useOnboardingMasters,
  useCreateMaster,
  useRunImport,
  useSaveDraft,
  useStageBatch,
  useMappingTemplates,
  useSaveMappingTemplate,
  workingStateOf,
  type WorkingState,
} from "@/lib/onboarding/data";
import { MasterPicker } from "@/components/onboarding/MasterPicker";
import {
  CreateMasterDialog,
  type CreateMasterRequest,
} from "@/components/onboarding/CreateMasterDialog";
import { useBranchScope } from "@/lib/branches";

type Step = "upload" | "review" | "resolve" | "plan" | "run";

const STEP_LABEL: Record<Step, string> = {
  upload: "Upload",
  review: "Analysis & mapping",
  resolve: "Resolve values",
  plan: "Import plan",
  run: "Import",
};

function SeverityBadge({ severity }: { severity: keyof typeof SEVERITY_META }) {
  const meta = SEVERITY_META[severity];
  return (
    <span className="whitespace-nowrap text-xs">
      {meta.dot} {meta.label}
    </span>
  );
}

export function ImportWizard({
  domain,
  entryPoint,
  open,
  onOpenChange,
  onSwitchDomain,
  openBatchId,
}: {
  domain: OnboardingDomain;
  entryPoint: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Offered when the uploaded file is plainly a different kind of data. The
   * wizard never switches on its own — the administrator chooses.
   */
  onSwitchDomain?: (domainKey: string) => void;
  /** Continue an existing batch instead of starting from an upload. */
  openBatchId?: string | null;
}) {
  const [step, setStep] = useState<Step>("upload");
  const [tables, setTables] = useState<SheetTable[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [filename, setFilename] = useState("");
  const [reading, setReading] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [transforms, setTransforms] = useState<TransformKey[]>([]);
  const [ignoredFields, setIgnoredFields] = useState<string[]>([]);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  /** The inline-creation confirmation currently open, if any. */
  const [createRequest, setCreateRequest] = useState<
    (CreateMasterRequest & { groupKey: string; target: string }) | null
  >(null);
  const [rowDecisions, setRowDecisions] = useState<Record<number, "skip" | "import" | "update">>({});
  // Undecided by default: how identifiers are supplied is the hotel's call.
  const [identifierChoice, setIdentifierChoice] = useState<IdentifierChoice>("undecided");
  const generateIdentifiers = identifierChoice === "generate";
  const [autoAccept, setAutoAccept] = useState(true);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [valueSearch, setValueSearch] = useState("");
  const [valuePage, setValuePage] = useState(0);
  const [rowPage, setRowPage] = useState(0);
  // Values the administrator supplied for fields their file left empty, and
  // the acknowledgement that they have seen what NEØ thinks this file is.
  const [valueFills, setValueFills] = useState<ValueFill[]>([]);
  const [fillDrafts, setFillDrafts] = useState<Record<string, string>>({});
  const [intentSettled, setIntentSettled] = useState(false);
  // Set while a saved draft is being restored, so the mapping proposal below
  // does not overwrite decisions the administrator already made.
  const restoring = useRef(false);

  const masters = useOnboardingMasters(domain);
  const identities = useExistingIdentities(domain);
  const stage = useStageBatch();
  const run = useRunImport();
  const createMasterMutation = useCreateMaster();
  const branchScope = useBranchScope();
  /** Named so the administrator can see which workspace and property gains the record. */
  const createScopeNote = branchScope.activeBranch?.name
    ? `${branchScope.activeBranch.name} — this workspace`
    : "This workspace";
  const batch = useOnboardingBatch(batchId);
  const drafts = useOnboardingDrafts(open ? domain.key : undefined);
  const mappingTemplates = useMappingTemplates(open ? domain.key : undefined);
  const saveMappingTemplate = useSaveMappingTemplate();
  const [templateName, setTemplateName] = useState("");
  const saveDraft = useSaveDraft();
  const discard = useDiscardBatch();
  const resumeBatch = useOnboardingBatch(resumeId);
  const resumeRows = useOnboardingBatchRows(resumeId, 10000);

  const table = tables[sheetIndex];

  const proposals: ColumnProposal[] = useMemo(
    () => (table ? proposeColumnMapping(domain, table.headers, table.rows) : []),
    [domain, table],
  );

  // A batch the page asked the wizard to continue — an engine draft or an
  // older batch whose rows were preserved. Either way the file is never
  // requested a second time.
  useEffect(() => {
    if (!open || !openBatchId) return;
    if (openBatchId === batchId) return;
    setResumeId(openBatchId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, openBatchId]);

  // Reopening saved work: the source rows were stored when the draft was
  // created, so nobody is asked for the same file twice.
  useEffect(() => {
    if (!resumeId) return;
    const saved = workingStateOf(resumeBatch.data);
    const rows = resumeRows.data;
    if (!rows || !resumeBatch.data) return;
    const sourceRows = rows.map((r) => (r["raw_values"] ?? {}) as Record<string, string>);
    if (sourceRows.length === 0) return;
    // A batch stored before the engine existed carries its rows but no working
    // state. Its columns are read back from the rows themselves, and the
    // mapping step then runs normally rather than being restored.
    const headers = saved?.headers?.length
      ? saved.headers
      : Array.from(new Set(sourceRows.flatMap((r) => Object.keys(r))));
    restoring.current = Boolean(saved);
    setTables([
      {
        sheet: saved?.sheet || "Sheet 1",
        headers,
        rows: sourceRows,
      },
    ]);
    setSheetIndex(0);
    setFilename(saved?.filename ?? String(resumeBatch.data["source_filename"] ?? ""));
    if (saved) {
      setMapping(saved.mapping ?? {});
      setTransforms(saved.transforms ?? []);
      setIgnoredFields(saved.ignoredFields ?? []);
      setDecisions(saved.decisions ?? {});
      setRowDecisions(
        Object.fromEntries(
          Object.entries(saved.rowDecisions ?? {}).map(([key, value]) => [Number(key), value]),
        ),
      );
      setIdentifierChoice((saved.identifierChoice as IdentifierChoice) ?? "undecided");
      setAutoAccept(saved.autoAccept ?? true);
    }
    setBatchId(resumeId);
    setStep((saved?.step as Step) ?? "review");
    setResumeId(null);
  }, [resumeBatch.data, resumeId, resumeRows.data]);

  useEffect(() => {
    if (!table) return;
    if (restoring.current) {
      restoring.current = false;
      return;
    }
    const next: Record<string, string> = {};
    for (const proposal of proposals) next[proposal.column] = proposal.fieldKey ?? "";
    setMapping(next);
    setDecisions({});
    setRowDecisions({});
  }, [proposals, table]);

  // Only clean-up that can act on the fields actually mapped is offered.
  const applicableTransforms = useMemo(() => relevantTransforms(domain, mapping), [domain, mapping]);
  useEffect(() => {
    setTransforms((prev) => {
      const allowed = applicableTransforms.map((t) => t.key);
      const kept = prev.filter((t) => allowed.includes(t));
      return kept.length === prev.length && prev.length > 0 ? prev : allowed;
    });
  }, [applicableTransforms]);

  const semantic = useMemo(
    () => (table ? semanticProfile(domain, mapping, table.rows) : []),
    [domain, mapping, table],
  );
  const suspectFields = useMemo(() => suspectIdentifierFields(semantic), [semantic]);

  const prepared: PreparedRow[] = useMemo(() => {
    if (!table) return [];
    return prepareRows(domain, mapping, table.rows, {
      transforms: new Set(transforms),
      masters: masters.data ?? {},
      ignoredFields: new Set(ignoredFields),
      autoAcceptFrom: autoAccept ? 0.9 : 1.01,
      generateIdentifiers,
      identifierChoice,
      existingKeys: identities.data ?? new Map(),
      decisions,
      suspectFields,
      rowDecisions,
      valueFills,
    });
  }, [
    autoAccept,
    decisions,
    domain,
    generateIdentifiers,
    identifierChoice,
    identities.data,
    ignoredFields,
    mapping,
    masters.data,
    rowDecisions,
    suspectFields,
    table,
    transforms,
    valueFills,
  ]);

  const profile = useMemo(
    () => profileRows(prepared, proposals, { domain, semantic }),
    [domain, prepared, proposals, semantic],
  );
  const plan = useMemo(() => buildImportPlan(prepared, domain), [domain, prepared]);
  const readiness = useMemo(() => commitReadiness(profile, plan), [profile, plan]);
  const identifierPlan = useMemo(() => identifierPreview(domain, prepared), [domain, prepared]);

  /** What NEØ believes this file actually is, and the safe ways forward. */
  const intent = useMemo(
    () => (table ? classifyFile(domain, table.headers, table.rows) : null),
    [domain, table],
  );

  /** Required values the file left empty, grouped so one decision settles many rows. */
  const missingGroups = useMemo(
    () =>
      missingValueGroups(domain, prepared, {
        masters: masters.data ?? {},
        availableColumns: table?.headers ?? [],
        mappedColumns: Object.keys(mapping).filter((c) => mapping[c]),
      }),
    [domain, mapping, masters.data, prepared, table],
  );

  const counters = useMemo(
    () => summaryCounters(profile, plan, Object.keys(rowDecisions).map(Number)),
    [plan, profile, rowDecisions],
  );

  const applyFill = (fieldKey: string, rows: "all" | number[], value?: string, fromColumn?: string) =>
    setValueFills((prev) => [
      ...prev.filter((f) => f.field !== fieldKey),
      fromColumn ? { field: fieldKey, rows, fromColumn } : { field: fieldKey, rows, value: value ?? "" },
    ]);
  const clearFill = (fieldKey: string) => setValueFills((prev) => prev.filter((f) => f.field !== fieldKey));

  /**
   * Lifts the distinct values of one column into their own table, keeping the
   * rows they came from visible. Nothing is written — it simply becomes the
   * file being imported for this foundation data type.
   */
  const extractValues = (column: string) => {
    if (!table) return;
    const { values, blankRows } = extractUniqueValues(table.rows, column);
    if (!values.length) {
      toast.error(`No values were found in "${column}".`);
      return;
    }
    setTables([
      {
        sheet: `Unique values from ${column}`,
        headers: [column, "Times used", "Source rows"],
        rows: values.map((v) => ({
          [column]: v.value,
          "Times used": String(v.occurrences),
          "Source rows": v.sourceRows.join(", "),
        })),
      },
    ]);
    setSheetIndex(0);
    setMapping({});
    setIntentSettled(true);
    toast.success(
      `${values.length} distinct value(s) prepared as ${domain.label}` +
        (blankRows.length ? ` · ${blankRows.length} source row(s) carried no value.` : "."),
    );
  };

  const filteredGroups = useMemo(() => {
    const term = valueSearch.trim().toLowerCase();
    return term
      ? profile.decisionGroups.filter(
          (g) => g.value.toLowerCase().includes(term) || g.fieldLabel.toLowerCase().includes(term),
        )
      : profile.decisionGroups;
  }, [profile.decisionGroups, valueSearch]);
  const pagedGroups = filteredGroups.slice(valuePage * 25, valuePage * 25 + 25);

  const attentionRows = useMemo(
    () => prepared.filter((row) => row.severity === "blocker" || row.severity === "decision"),
    [prepared],
  );
  const pagedRows = attentionRows.slice(rowPage * 25, rowPage * 25 + 25);

  const decideGroup = (group: DecisionGroup, value: string) =>
    setDecisions((prev) => ({ ...prev, [`${group.target}::${group.value.toLowerCase()}`]: value }));
  const clearGroup = (group: DecisionGroup) =>
    setDecisions((prev) => {
      const next = { ...prev };
      delete next[`${group.target}::${group.value.toLowerCase()}`];
      return next;
    });
  /**
   * Inline creation, offered only where the shared resolution contract grants
   * it. The action opens a confirmation that proposes a canonical spelling,
   * names the destination, searches the hotel's records once more and refuses
   * duplicates. Nothing is written until the administrator confirms; on
   * confirmation the value is settled, so one decision clears every row
   * carrying that spelling.
   */
  const openCreate = (group: DecisionGroup) =>
    setCreateRequest({
      policy: group.policy,
      value: group.value,
      occurrences: group.occurrences,
      fieldLabel: group.fieldLabel,
      groupKey: `${group.target}::${group.value.toLowerCase()}`,
      target: group.target,
      // Batch context, so canonicalisation can spot other spellings of the same
      // concept before a second near-identical record is ever created.
      batchValues: profile.decisionGroups
        .filter((other) => other.target === group.target)
        .map((other) => other.value),
    });

  const confirmCreate = (name: string) => {
    const request = createRequest;
    if (!request) return;
    createMasterMutation.mutate(
      { target: request.target as never, label: name },
      {
        onSuccess: (option) => {
          setDecisions((prev) => ({ ...prev, [request.groupKey]: option.id }));
          setCreateRequest(null);
          toast.success(
            `${request.policy.label} “${option.label}” created and applied to ${request.occurrences} row(s)`,
          );
        },
      },
    );
  };
  /** Hands off to the module that owns a governed master. The batch is saved. */
  const openOwningModule = (route: string) => {
    window.open(route, "_blank", "noopener");
    toast.message("Your batch stays here", {
      description: "Create the record in its own module, then come back and resolve the value.",
    });
  };
  const decideRows = (rowNumbers: number[], choice: "skip" | "import" | "update") =>
    setRowDecisions((prev) => {
      const next = { ...prev };
      for (const n of rowNumbers) next[n] = choice;
      return next;
    });

  /** Clears the workspace only. A saved draft is removed by discarding it. */
  const reset = () => {
    setStep("upload");
    setTables([]);
    setFilename("");
    setBatchId(null);
    setResumeId(null);
    setMapping({});
    setTransforms([]);
    setIgnoredFields([]);
    setDecisions({});
    setRowDecisions({});
    setIdentifierChoice("undecided");
    setValueSearch("");
    setValuePage(0);
    setRowPage(0);
    setValueFills([]);
    setFillDrafts({});
    setIntentSettled(false);
  };

  const onFile = async (file: File) => {
    setReading(true);
    try {
      const parsed = await readWorkbook(file);
      if (parsed.length === 0) {
        toast.error("NEØ could not find a header row and data rows in that file.");
        return;
      }
      setTables(parsed);
      setSheetIndex(0);
      setFilename(file.name);
      setStep("review");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That file could not be read.");
    } finally {
      setReading(false);
    }
  };

  const masterFor = (target: string): MasterOption[] =>
    ((masters.data ?? {}) as Record<string, MasterOption[]>)[target] ?? [];

  const working: WorkingState = useMemo(
    () => ({
      filename,
      sheet: table?.sheet ?? "",
      headers: table?.headers ?? [],
      mapping,
      transforms,
      ignoredFields,
      decisions,
      rowDecisions: Object.fromEntries(
        Object.entries(rowDecisions).map(([key, value]) => [String(key), value]),
      ),
      identifierChoice,
      autoAccept,
      step,
    }),
    [
      autoAccept,
      decisions,
      filename,
      identifierChoice,
      ignoredFields,
      mapping,
      rowDecisions,
      step,
      table,
      transforms,
    ],
  );

  const batchStageNow = String(batch.data?.["stage"] ?? "draft");

  // Autosave: every mapping and every decision survives a close or a refresh.
  useEffect(() => {
    if (!batchId || !table) return;
    if (!["draft", "prepared"].includes(batchStageNow)) return;
    const timer = setTimeout(() => {
      saveDraft.mutate({ batchId, domain, entryPoint, working, sourceRows: [] });
    }, 1200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId, batchStageNow, working]);

  /** Creates the durable draft the first time the administrator moves past mapping. */
  const ensureDraft = async (): Promise<string | null> => {
    if (batchId) return batchId;
    if (!table) return null;
    const created = await saveDraft.mutateAsync({
      domain,
      entryPoint,
      working,
      sourceRows: table.rows as unknown as Record<string, unknown>[],
    });
    const id = String(created["id"]);
    setBatchId(id);
    return id;
  };

  const goResolve = async () => {
    setStep("resolve");
    try {
      await ensureDraft();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The draft could not be saved.");
    }
  };

  const stageBatch = async () => {
    // Without this guard a failure to save the draft rejected silently, so the
    // button looked dead instead of reporting why nothing happened.
    let id: string | null;
    try {
      id = await ensureDraft();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The draft could not be saved.");
      return;
    }
    if (!id && !table) {
      toast.error("Load a file before preparing the batch.");
      return;
    }
    stage.mutate(
      {
        batchId: id,
        domain,
        filename,
        sheet: table?.sheet ?? "",
        mapping,
        transforms,
        decisions,
        generateIdentifiers,
        ignoredFields,
        prepared,
        profile: { ...profile, plan, rowDecisions } as unknown as Record<string, unknown>,
        working,
        ready: readiness.ready,
        entryPoint,
      },
      {
        onSuccess: (created) => {
          setBatchId(String((created as Record<string, unknown>)["id"]));
          setStep("run");
        },
      },
    );
  };

  const discardWork = () => {
    if (!batchId) {
      reset();
      onOpenChange(false);
      return;
    }
    discard.mutate(batchId, {
      onSuccess: () => {
        reset();
        onOpenChange(false);
      },
    });
  };

  const processed = Number(batch.data?.["processed_rows"] ?? 0);
  const totalRows = Number(batch.data?.["row_count"] ?? prepared.length);
  const batchStage = String(batch.data?.["stage"] ?? "ready");

  // The action bar is owned by the shared shell, so it stays reachable at any
  // content length, in every adapter and at every viewport size.
  const footerActions = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          {batchId ? "Save & close" : "Close"}
        </Button>
        {table && step !== "run" ? (
          <Button variant="ghost" onClick={reset}>
            <RotateCcw aria-hidden className="mr-1 size-4" /> Start again
          </Button>
        ) : null}
        {batchId && step !== "run" ? (
          <Button
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={discard.isPending}
            onClick={discardWork}
          >
            <Trash2 aria-hidden className="mr-1 size-4" /> Discard this work
          </Button>
        ) : null}
        {saveDraft.isPending ? (
          <span className="text-xs text-muted-foreground">Saving…</span>
        ) : batchId ? (
          <span className="text-xs text-muted-foreground">Your decisions are saved</span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {step === "review" ? (
          <Button onClick={goResolve} disabled={prepared.length === 0 || saveDraft.isPending}>
            Review values
          </Button>
        ) : null}
        {step === "resolve" ? (
          <>
            <Button variant="secondary" onClick={() => setStep("review")}>
              Back
            </Button>
            <Button onClick={() => setStep("plan")}>See import plan</Button>
          </>
        ) : null}
        {step === "plan" ? (
          <>
            <Button variant="secondary" onClick={() => setStep("resolve")}>
              Back
            </Button>
            {/* A disabled button with no reason reads as "the import is
                broken". State the blocker instead of hiding it. */}
            {plan.create + plan.update === 0 ? (
              <span className="max-w-[26rem] text-xs text-muted-foreground">
                Nothing to prepare yet: no row in this file is set to create or update a record.
                Go back and set at least one row to create or update.
              </span>
            ) : null}
            <Button onClick={stageBatch} disabled={stage.isPending || plan.create + plan.update === 0}>
              {stage.isPending ? <Loader2 aria-hidden className="mr-2 size-4 animate-spin" /> : null}
              Prepare batch
            </Button>
          </>
        ) : null}
        {step === "run" && batchId ? (
          <span className="flex flex-wrap items-center gap-3">
            {readiness.ready ? null : (
              <span className="text-xs text-muted-foreground">
                Import is locked until every row has a known outcome.
              </span>
            )}
            <Button
              onClick={() => run.mutate({ batchId, generateIdentifiers })}
              disabled={run.isPending || batchStage === "completed" || !readiness.ready}
            >
              {run.isPending ? <Loader2 aria-hidden className="mr-2 size-4 animate-spin" /> : null}
              {batchStage === "completed" ? "Imported" : "Import now"}
            </Button>
          </span>
        ) : null}
      </div>
    </div>
  );

  return (
    <>
    <CreateMasterDialog
      request={createRequest}
      options={createRequest ? masterFor(createRequest.target as never) : []}
      onOpenChange={(next) => {
        if (!next) setCreateRequest(null);
      }}
      onConfirm={confirmCreate}
      onUseExisting={(optionId) => {
        if (!createRequest) return;
        setDecisions((prev) => ({ ...prev, [createRequest.groupKey]: optionId }));
        setCreateRequest(null);
      }}
      pending={createMasterMutation.isPending}
      scopeNote={createScopeNote}
    />
    <OnboardingWorkspace
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
      title={`Import ${domain.label}`}
      description="NEØ reads your existing file as it is. It may clean, match and propose — it will never invent a value you never recorded."
      steps={(Object.keys(STEP_LABEL) as Step[]).map((key) => (
        <Badge key={key} variant={key === step ? "default" : "outline"} className="text-[11px] font-normal">
          {STEP_LABEL[key]}
        </Badge>
      ))}
      footer={footerActions}
    >
      <></>
            {step === "upload" ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-dashed border-border p-8 text-center">
                  <FileSpreadsheet aria-hidden className="mx-auto size-8 text-muted-foreground" />
                  <p className="mt-3 text-sm font-medium">Upload your existing register</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Excel or CSV, exactly as you keep it today. You do not need to rename a single column.
                  </p>
                  <label className="mt-4 inline-block">
                    <input
                      type="file"
                      accept=".csv,.tsv,.txt,.xls,.xlsx"
                      className="sr-only"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void onFile(file);
                      }}
                    />
                    <Button asChild disabled={reading}>
                      <span>
                        {reading ? (
                          <Loader2 aria-hidden className="mr-2 size-4 animate-spin" />
                        ) : (
                          <Upload aria-hidden className="mr-2 size-4" />
                        )}
                        Choose file
                      </span>
                    </Button>
                  </label>
                </div>

                {(drafts.data ?? []).length > 0 ? (
                  <section className="space-y-2 rounded-lg border border-border p-4">
                    <p className="text-sm font-medium">Continue where you left off</p>
                    <p className="text-xs text-muted-foreground">
                      Saved work that has not created any records yet. Nothing here has been written to
                      your {domain.label.toLowerCase()}.
                    </p>
                    <ul className="divide-y divide-border">
                      {(drafts.data ?? []).map((draft) => (
                        <li
                          key={String(draft["id"])}
                          className="flex flex-wrap items-center justify-between gap-2 py-2"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm">{String(draft["source_filename"] ?? "Saved draft")}</p>
                            <p className="text-xs text-muted-foreground">
                              {String(draft["reference"] ?? "")} · {Number(draft["row_count"] ?? 0)} rows ·{" "}
                              {String(draft["stage"] ?? "draft") === "prepared" ? "decisions outstanding" : "draft"}
                            </p>
                          </div>
                          <div className="flex gap-2">
                            <Button size="sm" variant="outline" onClick={() => setResumeId(String(draft["id"]))}>
                              Resume
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive hover:text-destructive"
                              disabled={discard.isPending}
                              onClick={() => discard.mutate(String(draft["id"]))}
                            >
                              <Trash2 aria-hidden className="mr-1 size-4" /> Discard
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </div>
            ) : null}

            {step === "review" && table ? (
              <div className="space-y-5">
                <section className="space-y-3 rounded-lg border border-border/70 bg-muted/30 p-4">
                  <div>
                    <p className="text-sm font-medium">Saved column mappings</p>
                    <p className="text-xs text-muted-foreground">
                      Reuse the way your spreadsheet's columns were matched last time. Applying a saved mapping only
                      sets the column matches — it never decides a relationship for you.
                    </p>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Select
                      value=""
                      onValueChange={(id) => {
                        const template = (mappingTemplates.data ?? []).find((t) => String(t["id"]) === id);
                        if (!template) return;
                        const saved = (template["mapping"] ?? {}) as Record<string, string>;
                        const headers = new Set(table.headers);
                        const next: Record<string, string> = {};
                        let applied = 0;
                        for (const [column, field] of Object.entries(saved)) {
                          if (!headers.has(column)) continue;
                          next[column] = field;
                          if (field) applied += 1;
                        }
                        setMapping((prev) => ({ ...prev, ...next }));
                        const ignored = (template["ignored_fields"] ?? []) as string[];
                        if (Array.isArray(ignored)) setIgnoredFields(ignored);
                        toast.success(`${applied} column match(es) applied from "${String(template["name"])}"`);
                      }}
                    >
                      <SelectTrigger aria-label="Apply a saved mapping">
                        <SelectValue
                          placeholder={
                            (mappingTemplates.data ?? []).length ? "Apply a saved mapping" : "No saved mappings yet"
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {(mappingTemplates.data ?? []).map((t) => (
                          <SelectItem key={String(t["id"])} value={String(t["id"])}>
                            {String(t["name"])}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex gap-2">
                      <Input
                        value={templateName}
                        onChange={(e) => setTemplateName(e.target.value)}
                        placeholder="Name this mapping"
                        aria-label="Name for the saved mapping"
                      />
                      <Button
                        variant="secondary"
                        disabled={!templateName.trim() || saveMappingTemplate.isPending}
                        onClick={() =>
                          saveMappingTemplate.mutate(
                            {
                              dataType: domain.key,
                              name: templateName,
                              mapping,
                              transforms,
                              ignoredFields,
                            },
                            { onSuccess: () => setTemplateName("") },
                          )
                        }
                      >
                        Save
                      </Button>
                    </div>
                  </div>
                </section>
                {tables.length > 1 ? (
                  <div className="space-y-1.5">
                    <Label>Sheet</Label>
                    <Select value={String(sheetIndex)} onValueChange={(v) => setSheetIndex(Number(v))}>
                      <SelectTrigger className="max-w-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {tables.map((t, index) => (
                          <SelectItem key={t.sheet} value={String(index)}>
                            {t.sheet} · {t.rows.length} rows
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}

                {intent && intent.verdict !== "strong_match" && !intentSettled ? (
                  <section className="space-y-3 rounded-lg border border-warning/50 bg-warning/5 p-4">
                    <div className="flex items-start gap-2">
                      <AlertTriangle aria-hidden className="mt-0.5 size-4 text-warning" />
                      <div>
                        <p className="text-sm font-medium">{intent.headline}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{intent.explanation}</p>
                      </div>
                    </div>
                    {intent.secondaryEntities.length ? (
                      <p className="text-xs text-muted-foreground">
                        It also carries information about{" "}
                        {intent.secondaryEntities.map((s) => s.domainLabel).join(", ")}. Those are imported separately,
                        under their own data types.
                      </p>
                    ) : null}
                    <div className="grid gap-2">
                      {intent.options.map((option) => {
                        const act = () => {
                          if (option.kind === "extract_values" && option.column) extractValues(option.column);
                          else if (option.kind === "switch_domain" && option.domainKey && onSwitchDomain)
                            onSwitchDomain(option.domainKey);
                          else if (option.kind === "continue") setIntentSettled(true);
                          else if (option.kind === "choose_other") onOpenChange(false);
                          else if (option.kind === "cancel") reset();
                        };
                        const unavailable = option.kind === "switch_domain" && !onSwitchDomain;
                        return (
                          <div
                            key={`${option.kind}-${option.domainKey ?? ""}`}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background p-3"
                          >
                            <span className="min-w-[14rem] flex-1">
                              <span className="flex items-center gap-2 text-sm font-medium">
                                {option.label}
                                {option.recommended ? <Badge variant="secondary">Suggested</Badge> : null}
                              </span>
                              <span className="mt-0.5 block text-xs text-muted-foreground">
                                {unavailable
                                  ? "Close this import and open the matching data type from the onboarding list."
                                  : option.detail}
                              </span>
                            </span>
                            <Button size="sm" variant="secondary" disabled={unavailable} onClick={act}>
                              {option.label}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ) : null}

                <section className="rounded-lg border border-border p-4">
                  <p className="text-sm font-medium">We analysed your data. Here is what we found.</p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    <Figure label="Rows detected" value={profile.total} />
                    <Figure label="Import-ready" value={profile.ready} />
                    <Figure label="Missing recommended information" value={profile.missingRecommended} />
                    <Figure label="Values requiring a decision" value={profile.needsDecision} />
                    <Figure label="Possible duplicates" value={profile.duplicates} />
                    <Figure label="Cannot be created" value={profile.blockers} />
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">
                    {profile.columnsMapped} of {profile.columnsMapped + profile.columnsUnmapped} columns matched a NEØ
                    field. Unmatched columns are simply left out of this import.
                  </p>
                </section>

                <section className="space-y-3">
                  <p className="text-sm font-medium">Column mapping</p>
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Your column</TableHead>
                          <TableHead>Example values</TableHead>
                          <TableHead>NEØ field</TableHead>
                          <TableHead>Why</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {proposals.map((proposal) => (
                          <TableRow key={proposal.column}>
                            <TableCell className="font-medium">{proposal.column}</TableCell>
                            <TableCell className="max-w-[16rem] truncate text-xs text-muted-foreground">
                              {proposal.samples.join(" · ") || "—"}
                            </TableCell>
                            <TableCell>
                              <Select
                                value={mapping[proposal.column] || "__none"}
                                onValueChange={(value) =>
                                  setMapping((prev) => ({ ...prev, [proposal.column]: value === "__none" ? "" : value }))
                                }
                              >
                                <SelectTrigger className="w-56" aria-label={`Map ${proposal.column}`}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__none">Do not import</SelectItem>
                                  {domain.fields.map((field) => (
                                    <SelectItem key={field.key} value={field.key}>
                                      {field.label}
                                      {field.requirement === "required" ? " *" : ""}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell className="max-w-[18rem] text-xs text-muted-foreground">
                              {proposal.fieldKey ? `${Math.round(proposal.confidence * 100)}% — ${proposal.reason}` : proposal.reason}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </section>

                {semantic.length ? (
                  <section className="space-y-2 rounded-lg border border-warning/40 p-4">
                    <p className="text-sm font-medium">What the values themselves suggest</p>
                    <p className="text-xs text-muted-foreground">
                      A heading can say one thing while the values say another. NEØ never changes your mapping on its
                      own — check these and adjust above if needed.
                    </p>
                    <ul className="space-y-1.5 text-sm">
                      {semantic.slice(0, 12).map((warning) => (
                        <li key={`${warning.column}-${warning.kind}`} className="flex items-start gap-2">
                          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                          <span>{warning.message}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                <section className="space-y-3 rounded-lg border border-border p-4">
                  <p className="text-sm font-medium">Bulk clean-up applied to every row</p>
                  <p className="text-xs text-muted-foreground">
                    Only the clean-up that can act on the columns you mapped is offered.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {applicableTransforms.map((transform) => (
                      <label key={transform.key} className="flex items-start gap-3 text-sm">
                        <Switch
                          checked={transforms.includes(transform.key)}
                          onCheckedChange={(checked) =>
                            setTransforms((prev) =>
                              checked ? [...prev, transform.key] : prev.filter((t) => t !== transform.key),
                            )
                          }
                          aria-label={transform.label}
                        />
                        <span>
                          <span className="block font-medium">{transform.label}</span>
                          <span className="block text-xs text-muted-foreground">{transform.detail}</span>
                        </span>
                      </label>
                    ))}
                    <label className="flex items-start gap-3 text-sm">
                      <Switch checked={autoAccept} onCheckedChange={setAutoAccept} aria-label="Accept high-confidence matches" />
                      <span>
                        <span className="block font-medium">Accept high-confidence matches</span>
                        <span className="block text-xs text-muted-foreground">
                          Applies matches NEØ is at least 90% sure of. Anything less still comes to you.
                        </span>
                      </span>
                    </label>
                    {domain.fields.some((f) => f.generatable) ? (
                      <div className="space-y-2 text-sm">
                        <Label htmlFor="identifier-choice">Missing identifiers</Label>
                        <Select
                          value={identifierChoice}
                          onValueChange={(value) => setIdentifierChoice(value as IdentifierChoice)}
                        >
                          <SelectTrigger id="identifier-choice">
                            <SelectValue placeholder="Choose how identifiers are supplied" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="undecided">Not decided yet</SelectItem>
                            <SelectItem value="generate">NEØ generates them for me</SelectItem>
                            <SelectItem value="blank">Import blank, complete later</SelectItem>
                            <SelectItem value="external">I supply them separately</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                          NEØ never issues identifiers on your behalf until you choose. Generated values follow
                          your configured numbering, shown in the import plan before anything is written.
                        </p>
                      </div>
                    ) : null}
                  </div>
                </section>
              </div>
            ) : null}

            {step === "resolve" ? (
              <div className="space-y-5">
                <div className="grid gap-2 sm:grid-cols-4">
                  <Figure label="Unresolved reference values" value={counters.unresolvedReferenceValues} />
                  <Figure label="Duplicate candidates awaiting a decision" value={counters.undecidedDuplicates} />
                  <Figure label="Blocked rows" value={counters.blockedRows} />
                  <Figure label="Decisions made" value={Object.keys(decisions).length + Object.keys(rowDecisions).length + valueFills.length} />
                </div>

                {/*
                  Empty identifiers are one decision about many rows, not a
                  warning repeated on every row. Shared: any adapter with a
                  generatable field inherits this grouping.
                */}
                {identifierPlan.map((preview) => (
                  <section
                    key={preview.fieldKey}
                    data-onboarding-identifier-group={preview.fieldKey}
                    className="space-y-3 rounded-lg border border-border p-4"
                  >
                    <div>
                      <p className="font-medium">
                        {preview.affected} row(s) have no {preview.fieldLabel.toLowerCase()}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Pattern {preview.pattern} · example {preview.firstSample} to {preview.lastSample}.{" "}
                        {preview.note}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        value={identifierChoice}
                        onValueChange={(value) => setIdentifierChoice(value as IdentifierChoice)}
                      >
                        <SelectTrigger className="w-72" aria-label={`How ${preview.fieldLabel} is supplied`}>
                          <SelectValue placeholder="Choose how identifiers are supplied" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="undecided">Not decided yet</SelectItem>
                          <SelectItem value="generate">NEØ generates them for me</SelectItem>
                          <SelectItem value="blank">Import blank, complete later</SelectItem>
                          <SelectItem value="external">I supply them separately</SelectItem>
                        </SelectContent>
                      </Select>
                      <span className="text-xs text-muted-foreground">
                        {identifierChoice === "undecided"
                          ? "Nothing is issued until you choose."
                          : identifierChoice === "generate"
                            ? `Numbering continues from the highest ${preview.fieldLabel.toLowerCase()} already in NEØ, so no value can collide.`
                            : "These rows import without this value."}
                      </span>
                    </div>
                  </section>
                ))}


                <p className="text-sm text-muted-foreground">{counters.statement}</p>

                <p className="text-sm text-muted-foreground">
                  Decide once per value and NEØ applies it to every occurrence in this file. You can change any
                  decision until you press Import.
                </p>

                {missingGroups.length ? (
                  <section className="space-y-3">
                    <p className="text-sm font-medium">Required values your file does not contain</p>
                    {missingGroups.map((group) => {
                      const fill = valueFills.find((f) => f.field === group.fieldKey);
                      return (
                        <div key={group.fieldKey} className="space-y-3 rounded-lg border border-border p-4 text-sm">
                          <div>
                            <p className="font-medium">
                              {group.fieldLabel} · {group.occurrences} row(s) empty
                            </p>
                            <p className="text-xs text-muted-foreground">
                              Rows {group.rowNumbers.slice(0, 12).join(", ")}
                              {group.rowNumbers.length > 12 ? ` and ${group.rowNumbers.length - 12} more` : ""}. NEØ
                              will not invent this value.
                            </p>
                          </div>

                          {group.evidence.length ? (
                            <div className="space-y-1">
                              <p className="text-xs font-medium">Suggested from the rest of each row</p>
                              {group.evidence.map((e) => (
                                <p key={e.label} className="text-xs text-muted-foreground">
                                  {e.label} — {e.reason} ({Math.round(e.confidence * 100)}% similar)
                                </p>
                              ))}
                            </div>
                          ) : null}

                          <div className="flex flex-wrap items-center gap-2">
                            <Input
                              className="max-w-xs"
                              placeholder={`Value to use for ${group.fieldLabel.toLowerCase()}`}
                              value={fillDrafts[group.fieldKey] ?? ""}
                              onChange={(event) =>
                                setFillDrafts((prev) => ({ ...prev, [group.fieldKey]: event.target.value }))
                              }
                            />
                            <Button
                              size="sm"
                              disabled={!(fillDrafts[group.fieldKey] ?? "").trim()}
                              onClick={() => applyFill(group.fieldKey, "all", fillDrafts[group.fieldKey])}
                            >
                              Apply to all {group.occurrences} rows
                            </Button>
                            {group.alternativeColumns.length ? (
                              <Select onValueChange={(column) => applyFill(group.fieldKey, "all", undefined, column)}>
                                <SelectTrigger className="w-[15rem]">
                                  <SelectValue placeholder="Take it from another column" />
                                </SelectTrigger>
                                <SelectContent>
                                  {group.alternativeColumns.map((column) => (
                                    <SelectItem key={column} value={column}>
                                      {column}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : null}
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => decideRows(group.rowNumbers, "skip")}
                            >
                              Skip these rows
                            </Button>
                            {fill ? (
                              <Button size="sm" variant="ghost" onClick={() => clearFill(group.fieldKey)}>
                                Undo
                              </Button>
                            ) : null}
                          </div>

                          {fill ? (
                            <p className="text-xs text-muted-foreground">
                              {fill.fromColumn
                                ? `Taken from the "${fill.fromColumn}" column, only where your file was empty.`
                                : `"${fill.value}" applied, only where your file was empty.`}
                            </p>
                          ) : null}
                        </div>
                      );
                    })}
                  </section>
                ) : null}

                {profile.decisionGroups.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-lg border border-border p-4 text-sm">
                    <CheckCircle2 aria-hidden className="size-4 text-success" />
                    Every value resolved against your existing records.
                  </div>
                ) : (
                  <section className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Search aria-hidden className="size-4 text-muted-foreground" />
                      <Input
                        value={valueSearch}
                        onChange={(event) => {
                          setValueSearch(event.target.value);
                          setValuePage(0);
                        }}
                        placeholder="Search the values still to decide"
                        className="max-w-sm"
                        aria-label="Search values"
                      />
                      <span className="text-xs text-muted-foreground">
                        {filteredGroups.length} value(s)
                      </span>
                    </div>

                    <div className="overflow-x-auto rounded-lg border border-border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Value in your file</TableHead>
                            <TableHead>Goes to</TableHead>
                            <TableHead>Rows</TableHead>
                            <TableHead>What NEØ found</TableHead>
                            <TableHead>Your decision</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {pagedGroups.map((group) => {
                            const key = `${group.target}::${group.value.toLowerCase()}`;
                            const decided = decisions[key];
                            return (
                              <TableRow key={key}>
                                <TableCell className="font-medium">{group.value}</TableCell>
                                <TableCell className="text-xs text-muted-foreground">{group.fieldLabel}</TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                  {group.occurrences} row(s) · {group.rowNumbers.slice(0, 5).join(", ")}
                                  {group.rowNumbers.length > 5 ? "…" : ""}
                                </TableCell>
                                <TableCell className="max-w-[20rem] text-xs text-muted-foreground">
                                  {group.reason}
                                  {group.credible ? null : (
                                    <span className="mt-1 block">
                                      {resolutionContract(group.policy).explanation}
                                    </span>
                                  )}
                                </TableCell>
                                <TableCell>
                                  {(() => {
                                    const contract = resolutionContract(group.policy);
                                    return (
                                  <div className="w-64 space-y-2">
                                    <MasterPicker
                                      options={masterFor(group.target)}
                                      value={decided}
                                      label={`Match ${group.value}`}
                                      onSelect={(id) => decideGroup(group, id)}
                                      createLabel={
                                        contract.canCreateInline ? group.policy.label.toLowerCase() : undefined
                                      }
                                      emptyHint={contract.explanation}
                                      onCreate={
                                        contract.canCreateInline ? () => openCreate(group) : undefined
                                      }
                                    />
                                    <div className="flex flex-wrap gap-1">
                                      {group.suggestion ? (
                                        <Button
                                          size="sm"
                                          variant="secondary"
                                          onClick={() => decideGroup(group, group.suggestion!.id)}
                                        >
                                          Use {group.suggestion.label} ·{" "}
                                          {Math.round(group.suggestion.confidence * 100)}%
                                        </Button>
                                      ) : null}
                                      {contract.canCreateInline ? (
                                        <Button
                                          size="sm"
                                          disabled={createMasterMutation.isPending}
                                          onClick={() => openCreate(group)}
                                        >
                                          Create {group.policy.label.toLowerCase()} “{group.value}”
                                        </Button>
                                      ) : null}
                                      {!contract.canCreateInline && contract.handoff ? (
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          onClick={() => openOwningModule(contract.handoff!.route)}
                                        >
                                          Open {contract.handoff.module}
                                        </Button>
                                      ) : null}
                                      {contract.canLeaveUnassigned ? (
                                        <Button size="sm" variant="outline" onClick={() => decideGroup(group, "")}>
                                          Leave unassigned
                                        </Button>
                                      ) : null}
                                      {decided !== undefined ? (
                                        <Button variant="ghost" size="sm" onClick={() => clearGroup(group)}>
                                          Undo
                                        </Button>
                                      ) : null}
                                    </div>
                                  </div>
                                    );
                                  })()}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>

                    {filteredGroups.length > 25 ? (
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>
                          Showing {valuePage * 25 + 1}–{Math.min(filteredGroups.length, valuePage * 25 + 25)} of{" "}
                          {filteredGroups.length}
                        </span>
                        <span className="flex gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={valuePage === 0}
                            onClick={() => setValuePage((p) => Math.max(0, p - 1))}
                          >
                            Previous
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={(valuePage + 1) * 25 >= filteredGroups.length}
                            onClick={() => setValuePage((p) => p + 1)}
                          >
                            Next
                          </Button>
                        </span>
                      </div>
                    ) : null}
                  </section>
                )}

                {profile.duplicateGroups.length ? (
                  <section className="space-y-3">
                    <p className="text-sm font-medium">Possible duplicates</p>
                    {profile.duplicateGroups.map((group) => (
                      <div
                        key={`${group.label}-${group.scope}-${group.classification}`}
                        className="space-y-2 rounded-lg border border-border p-4 text-sm"
                      >
                        <p className="font-medium">
                          {group.count} row(s) · matched on {group.label.toLowerCase()} ·{" "}
                          {group.classification === "exact"
                            ? "certain"
                            : group.classification === "probable"
                              ? "probable"
                              : "possible"}{" "}
                          {group.scope === "existing" ? "match with an existing record" : "duplicate inside this file"}
                        </p>
                        <p className="text-xs text-muted-foreground">{group.explain}</p>
                        <div className="flex flex-wrap gap-2">
                          <Button variant="secondary" size="sm" onClick={() => decideRows(group.rowNumbers, "import")}>
                            Import all as separate records
                          </Button>
                          <Button variant="secondary" size="sm" onClick={() => decideRows(group.rowNumbers, "skip")}>
                            Skip all
                          </Button>
                          {group.scope === "existing" ? (
                            <Button variant="secondary" size="sm" onClick={() => decideRows(group.rowNumbers, "update")}>
                              Update the existing records
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </section>
                ) : null}

                <section className="space-y-3">
                  <p className="text-sm font-medium">Rows still needing attention ({attentionRows.length})</p>
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Row</TableHead>
                          <TableHead>Severity</TableHead>
                          <TableHead>What NEØ found</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pagedRows.map((row) => (
                          <TableRow key={row.rowNumber}>
                            <TableCell>{row.rowNumber}</TableCell>
                            <TableCell>
                              <SeverityBadge severity={row.severity} />
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {row.issues
                                .filter((issue) => issue.severity === "blocker" || issue.severity === "decision")
                                .map((issue) => issue.message)
                                .join(" · ")}
                            </TableCell>
                          </TableRow>
                        ))}
                        {attentionRows.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={3} className="text-sm text-muted-foreground">
                              Nothing outstanding.
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </TableBody>
                    </Table>
                  </div>
                  {attentionRows.length > 25 ? (
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        Showing {rowPage * 25 + 1}–{Math.min(attentionRows.length, rowPage * 25 + 25)} of{" "}
                        {attentionRows.length}
                      </span>
                      <span className="flex gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={rowPage === 0}
                          onClick={() => setRowPage((p) => Math.max(0, p - 1))}
                        >
                          Previous
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={(rowPage + 1) * 25 >= attentionRows.length}
                          onClick={() => setRowPage((p) => p + 1)}
                        >
                          Next
                        </Button>
                      </span>
                    </div>
                  ) : null}
                </section>
              </div>
            ) : null}

            {step === "plan" ? (
              <div className="space-y-4">
                <p className="text-sm font-medium">This is exactly what pressing Import will do.</p>

                <section className="space-y-2 rounded-lg border border-border p-4">
                  <p className="text-sm font-medium">
                    Every row accounted for — {plan.accountedFor} of {plan.total}
                  </p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Outcome</TableHead>
                        <TableHead className="w-20 text-right">Rows</TableHead>
                        <TableHead>What happens</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {plan.buckets
                        .filter((bucket) => bucket.count > 0)
                        .map((bucket) => (
                          <TableRow key={bucket.key}>
                            <TableCell className="font-medium">{bucket.label}</TableCell>
                            <TableCell className="text-right tabular-nums">{bucket.count}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">{bucket.explain}</TableCell>
                          </TableRow>
                        ))}
                      <TableRow>
                        <TableCell className="font-medium">Total source rows</TableCell>
                        <TableCell className="text-right tabular-nums font-medium">{plan.total}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {plan.reconciled
                            ? "Reconciled — nothing is unexplained."
                            : "Not reconciled — NEØ will not write this batch."}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </section>

                <div className="grid gap-2 sm:grid-cols-2">
                  <Figure label="Records to create" value={plan.create} />
                  <Figure label="Existing records to update" value={plan.update} />
                  <Figure label="Optional fields left blank" value={plan.blankOptionalFields} />
                  <Figure label="Values matched to your records" value={plan.mappedValues} />
                </div>

                {plan.relationshipOutcomes.length ? (
                  <section className="space-y-2 rounded-lg border border-border p-4 text-sm">
                    <p className="font-medium">
                      Unresolved links — {plan.mayRemainUnassigned} optional ({plan.awaitingOptionalDecision}{" "}
                      row(s) awaiting your choice), {plan.requiresResolution} required (
                      {plan.awaitingRequiredValue} row(s) held)
                    </p>

                    {plan.relationshipOutcomes.slice(0, 12).map((link) => (
                      <p key={`${link.fieldKey}-${link.value}`} className="text-xs text-muted-foreground">
                        “{link.value}” ({link.fieldLabel}, {link.occurrences} row(s)) —{" "}
                        {link.disposition === "may_remain_unassigned"
                          ? "records import with this left unassigned."
                          : "must be resolved before those records can be created."}
                      </p>
                    ))}
                    {plan.relationshipOutcomes.length > 12 ? (
                      <p className="text-xs text-muted-foreground">
                        and {plan.relationshipOutcomes.length - 12} more.
                      </p>
                    ) : null}
                  </section>
                ) : null}

                {plan.fieldOutcomes.length ? (
                  <section className="space-y-2 rounded-lg border border-border p-4 text-sm">
                    <p className="font-medium">What happens to everything analysis flagged</p>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Field</TableHead>
                          <TableHead className="w-20 text-right">Rows</TableHead>
                          <TableHead>Handling</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {plan.fieldOutcomes.slice(0, 25).map((outcome) => (
                          <TableRow key={`${outcome.fieldKey}-${outcome.handling}`}>
                            <TableCell>
                              <span className="block font-medium">{outcome.fieldLabel}</span>
                              <SeverityBadge severity={outcome.severity} />
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{outcome.rows}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              <span className="block">{outcome.handling}</span>
                              <span className="block">{outcome.sample}</span>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </section>
                ) : null}

                <div className="flex items-start gap-2 rounded-lg border border-border p-4 text-sm text-muted-foreground">
                  <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
                  Blank fields stay blank. NEØ does not estimate a cost, a serial, a warranty or a supplier it was
                  never given.
                </div>

                {identifierPlan.length ? (
                  <div className="space-y-2 rounded-lg border border-border p-4 text-sm">
                    <p className="font-medium">
                      {identifierChoice === "generate"
                        ? "Identifiers NEØ will issue"
                        : identifierChoice === "undecided"
                          ? "Identifiers — awaiting your choice"
                          : "Identifiers — not generated"}
                    </p>
                    {identifierPlan.map((preview) => (
                      <p key={preview.fieldKey} className="text-xs text-muted-foreground">
                        {preview.affected} record(s) have no {preview.fieldLabel.toLowerCase()}.{" "}
                        {identifierChoice === "generate"
                          ? `They would receive ${preview.pattern}, from ${preview.firstSample} to ${preview.lastSample}. `
                          : identifierChoice === "undecided"
                            ? `Nothing is issued until you choose. If generated they would follow ${preview.pattern}. `
                            : identifierChoice === "external"
                              ? "They import blank because you are supplying them separately. "
                              : "They import blank, to complete in NEØ later. "}
                        {preview.note}
                      </p>
                    ))}
                  </div>
                ) : null}

                {readiness.ready ? null : (
                  <div className="space-y-1 rounded-lg border border-warning/40 p-4 text-sm">
                    <p className="font-medium">Decisions are still open — nothing will be written</p>
                    {readiness.reasons.map((reason) => (
                      <p key={reason} className="text-xs text-muted-foreground">
                        {reason}
                      </p>
                    ))}
                    <p className="text-xs text-muted-foreground">
                      You can still prepare the batch for review; the import itself stays locked until these are
                      decided.
                    </p>
                  </div>
                )}
                {plan.blocked > 0 ? (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/40 p-4 text-sm">
                    <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
                    {plan.blocked} row(s) cannot be created and will be skipped. They stay in the batch so you can
                    correct the file and import just those later.
                  </div>
                ) : null}
              </div>
            ) : null}

            {step === "run" ? (
              <div className="space-y-4">
                <p className="text-sm font-medium">
                  {batchStage === "completed"
                    ? "Import completed."
                    : batchStage === "completed_with_exceptions"
                      ? "Import completed with exceptions."
                      : batchStage === "failed"
                        ? "Import failed."
                        : batchStage === "importing"
                          ? "Importing…"
                          : "Batch prepared and ready to import."}
                </p>
                <Progress value={totalRows ? Math.round((processed / totalRows) * 100) : 0} className="h-2" />
                <p className="text-sm text-muted-foreground">
                  {processed} / {totalRows} processed · reference {String(batch.data?.["reference"] ?? "—")}
                </p>
                <p className="text-xs text-muted-foreground">
                  This batch is saved. If you close this window or refresh, it continues from where it stopped and can
                  never create the same record twice.
                </p>
                {run.isPending ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 aria-hidden className="size-4 animate-spin" /> Writing records…
                  </p>
                ) : null}
              </div>
            ) : null}
    </OnboardingWorkspace>
    </>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <p className="numeric text-lg font-semibold leading-none">{value.toLocaleString()}</p>
      <p className="mt-1 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
