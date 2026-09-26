import { useMemo, useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  Code2,
  FlaskConical,
  Loader2,
  Play,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { SectionCard, StatCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  useCleanTestEnvironment,
  useCreateTestEnvironment,
  useRunSystemTest,
  useTestEnvironments,
  useTestResults,
  useTestRunsHistory,
  type TestResult,
} from "@/lib/simulation-data";

export const Route = createFileRoute("/_shell/platform/simulation")({
  component: GuardedPage,
  head: () => ({
    meta: [
      { title: "Simulation Centre — NEØ System Test" },
      {
        name: "description",
        content:
          "Run the full NEØ system test in an isolated test workspace and review every workflow, permission and isolation check.",
      },
    ],
  }),
});

const STATUS_LABEL: Record<string, string> = {
  pass: "Passed",
  warn: "Configuration required",
  fail: "Failed",
  critical: "Critical",
  skip: "Not run",
};

/** What a reader should do about each outcome. */
const STATUS_MEANING: Record<string, string> = {
  pass: "The workflow behaved exactly as designed.",
  warn: "The product is fine — something outside it is not set up yet, so this could not be proven.",
  fail: "A workflow did not do what it promises. This is a product defect to fix.",
  critical: "Data or authority crossed a boundary it must never cross. Fix before anything else.",
  skip: "A prerequisite was missing, so this area is unverified.",
};

const STATUS_RANK: Record<string, number> = { critical: 0, fail: 1, warn: 2, skip: 3, pass: 4 };

function statusBadge(status: string) {
  const tone =
    status === "pass"
      ? "bg-success/15 text-success"
      : status === "warn"
        ? "bg-warning/15 text-warning"
        : status === "skip"
          ? "bg-muted text-muted-foreground"
          : status === "critical"
            ? "bg-destructive text-destructive-foreground"
            : "bg-destructive/15 text-destructive";
  return <Badge className={tone}>{STATUS_LABEL[status] ?? status}</Badge>;
}

function evidenceString(row: TestResult, key: string): string | null {
  const value = (row.evidence ?? {})[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** A plain-text report a reader can paste straight into a fix request. */
function reportFor(row: TestResult): string {
  const failed = row.assertions.filter((a) => !a.ok);
  return [
    `${STATUS_LABEL[row.status] ?? row.status} — ${row.suite} · ${row.name}`,
    `Check key: ${row.case_key}`,
    row.detail ? `Detail: ${row.detail}` : null,
    evidenceString(row, "_failed_at") ? `Failed at: ${evidenceString(row, "_failed_at")}` : null,
    evidenceString(row, "_case_source") ? `Defined in: ${evidenceString(row, "_case_source")}` : null,
    failed.length
      ? `Failing checks:\n${failed
          .map((a) => `  - ${a.label} (expected ${JSON.stringify(a.expected)}, saw ${JSON.stringify(a.actual)})`)
          .join("\n")}`
      : null,
    `Evidence: ${JSON.stringify(row.evidence ?? {}, null, 2)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function CopyButton({ text, label }: { text: string; label: string }) {
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(text).then(
          () => toast.success("Copied"),
          () => toast.error("Could not copy"),
        );
      }}
    >
      <ClipboardCopy className="mr-2 h-3.5 w-3.5" />
      {label}
    </Button>
  );
}

function SourceRef({ row }: { row: TestResult }) {
  const at = evidenceString(row, "_failed_at") ?? evidenceString(row, "_case_source");
  if (!at) return null;
  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
      <Code2 className="h-3.5 w-3.5" />
      {at}
    </span>
  );
}

function SimulationCentre() {
  const environments = useTestEnvironments();
  const runs = useTestRunsHistory();
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [detail, setDetail] = useState<TestResult | null>(null);
  const [filter, setFilter] = useState<"attention" | "all" | "pass">("attention");
  const [search, setSearch] = useState("");
  const [showAllEnvironments, setShowAllEnvironments] = useState(false);

  const activeRun = selectedRun ?? runs.data?.[0]?.id ?? null;
  const results = useTestResults(activeRun);

  const create = useCreateTestEnvironment();
  const run = useRunSystemTest();
  const clean = useCleanTestEnvironment();

  const allEnvironments = environments.data ?? [];
  const active = allEnvironments.filter((e) => e.status === "active");
  const shownEnvironments = showAllEnvironments ? allEnvironments : active;
  const current = (runs.data ?? []).find((r) => r.id === activeRun) ?? null;
  const totals = current?.totals ?? {};
  const running = current?.status === "running";

  const rows = results.data ?? [];
  const attention = useMemo(
    () =>
      rows
        .filter((r) => r.status !== "pass")
        .sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)),
    [rows],
  );

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "attention" && r.status === "pass") return false;
      if (filter === "pass" && r.status !== "pass") return false;
      if (!term) return true;
      return `${r.suite} ${r.name} ${r.case_key} ${r.detail ?? ""}`.toLowerCase().includes(term);
    });
  }, [rows, filter, search]);

  const suites = useMemo(() => {
    const groups = new Map<string, TestResult[]>();
    for (const row of visible) {
      const list = groups.get(row.suite) ?? [];
      list.push(row);
      groups.set(row.suite, list);
    }
    return Array.from(groups.entries());
  }, [visible]);

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 rounded-lg border border-info/40 bg-info/5 p-4 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-info" />
        <p>
          Every check runs inside a dedicated <strong>test workspace</strong> with its own property,
          staff accounts and TEST records. Live operational data is never read into a result, no real
          message is sent and no real payment is ever taken.
        </p>
      </div>

      <SectionCard
        title="NEØ System Test"
        description="Create the isolated workspaces, run every workflow end to end, then remove the workspaces and prove nothing was left behind."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={create.isPending}
              onClick={() =>
                create.mutate(undefined, {
                  onSuccess: () => toast.success("Test environment created"),
                  onError: (e) => toast.error((e as Error).message),
                })
              }
            >
              <FlaskConical className="mr-2 h-4 w-4" />
              {create.isPending ? "Creating…" : "Create test environment"}
            </Button>
            <Button
              disabled={run.isPending || active.length < 2}
              onClick={() =>
                run.mutate(undefined, {
                  onSuccess: (r) => {
                    setSelectedRun((r as { runId: string }).runId);
                    setFilter("attention");
                    toast.success("System test finished");
                  },
                  onError: (e) => toast.error((e as Error).message),
                })
              }
            >
              {run.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              {run.isPending ? "Running…" : "Run full system test"}
            </Button>
            <Button
              variant="ghost"
              disabled={clean.isPending || active.length === 0}
              onClick={() =>
                clean.mutate(undefined, {
                  onSuccess: (r) => {
                    const result = r as { removed: number; problems: string[]; verified: boolean };
                    if (result.verified)
                      toast.success(
                        `Removed ${result.removed} test workspace(s) — verified, nothing left behind`,
                      );
                    else
                      toast.error(
                        `Cleanup incomplete: ${result.problems.slice(0, 2).join("; ") || "verification failed"}`,
                      );
                  },
                  onError: (e) => toast.error((e as Error).message),
                })
              }
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Clean test environment
            </Button>
          </div>
        }
      >
        {allEnvironments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No test environment exists yet. Create one to run the system test.
          </p>
        ) : (
          <div className="space-y-2">
            {active.length < 2 ? (
              <p className="text-sm text-warning">
                Two workspaces are needed to prove that one hotel can never see another. Create the
                test environment before running.
              </p>
            ) : null}
            <ul className="space-y-1 text-sm">
              {shownEnvironments.map((env) => {
                const problems = (env as { cleanup_problems?: string[] }).cleanup_problems ?? [];
                return (
                  <li key={env.id} className="text-muted-foreground">
                    {env.label} —{" "}
                    {env.status === "active"
                      ? "in use"
                      : env.status === "purged"
                        ? "removed and verified"
                        : env.status === "cleanup_failed"
                          ? "cleanup incomplete"
                          : env.status}
                    {problems.length > 0 ? (
                      <span className="block text-xs text-destructive">{problems.join("; ")}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {allEnvironments.length > active.length ? (
              <Button
                variant="link"
                className="h-auto p-0 text-xs"
                onClick={() => setShowAllEnvironments((v) => !v)}
              >
                {showAllEnvironments
                  ? "Show only workspaces in use"
                  : `Show ${allEnvironments.length - active.length} removed workspace(s)`}
              </Button>
            ) : null}
          </div>
        )}
      </SectionCard>

      {current ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <StatCard label="Tests" value={String(totals.tests ?? 0)} />
            <StatCard label="Passed" value={String(totals.passed ?? 0)} />
            <StatCard label="Configuration required" value={String(totals.warnings ?? 0)} />
            <StatCard label="Failed" value={String(totals.failed ?? 0)} />
            <StatCard label="Critical" value={String(totals.critical ?? 0)} />
            <StatCard label="Not run" value={String(totals.skipped ?? 0)} />
          </div>

          {running ? (
            <div className="flex items-center gap-2 rounded-lg border border-info/40 bg-info/10 p-4 text-sm text-info">
              <Loader2 className="h-4 w-4 animate-spin" />
              Run {current.run_ref} is in progress
              {current.current_suite ? ` — now testing ${current.current_suite}` : ""}. Results appear
              as each area finishes.
            </div>
          ) : (totals.critical ?? 0) > 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4" />
              Critical failures were found — data or authority crossed a boundary it must never cross.
            </div>
          ) : (totals.failed ?? 0) > 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
              <XCircle className="h-4 w-4" /> Some workflows did not complete as expected.
            </div>
          ) : (totals.skipped ?? 0) > 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
              <AlertTriangle className="h-4 w-4" /> Not certified: {totals.skipped} check(s) did not
              run, so part of the system is unverified.
            </div>
          ) : (totals.warnings ?? 0) > 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
              <AlertTriangle className="h-4 w-4" /> Every exercised workflow behaved as expected.{" "}
              {totals.warnings} check(s) need outside setup before they can be proven.
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 p-4 text-sm text-success">
              <CheckCircle2 className="h-4 w-4" /> Certified: every check ran and behaved as expected.
            </div>
          )}

          {current.failure_detail ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
              The run stopped early: {current.failure_detail}
            </div>
          ) : null}
        </>
      ) : null}

      {attention.length > 0 ? (
        <SectionCard
          title="Needs attention"
          description="Ordered by severity. Each entry carries the evidence and the exact place in the code it came from."
          actions={
            <CopyButton
              text={attention.map(reportFor).join("\n\n———\n\n")}
              label="Copy full report"
            />
          }
        >
          <ul className="space-y-3">
            {attention.map((row) => (
              <li
                key={row.id}
                className="cursor-pointer rounded-lg border p-3 transition-colors hover:bg-muted/50"
                onClick={() => setDetail(row)}
              >
                <div className="flex flex-wrap items-center gap-2">
                  {statusBadge(row.status)}
                  <span className="font-medium">{row.name}</span>
                  <span className="text-xs text-muted-foreground">{row.suite}</span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {row.detail ?? STATUS_MEANING[row.status]}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{STATUS_MEANING[row.status]}</p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <SourceRef row={row} />
                  <CopyButton text={reportFor(row)} label="Copy this" />
                </div>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard title="Run history" description="Select a run to read its evidence.">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Run</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Result</TableHead>
              <TableHead className="text-right">Passed</TableHead>
              <TableHead className="text-right">Warnings</TableHead>
              <TableHead className="text-right">Failed</TableHead>
              <TableHead className="text-right">Critical</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(runs.data ?? []).map((r) => (
              <TableRow
                key={r.id}
                className={`cursor-pointer ${r.id === activeRun ? "bg-muted/60" : ""}`}
                onClick={() => setSelectedRun(r.id)}
              >
                <TableCell className="font-medium">{r.run_ref}</TableCell>
                <TableCell>{new Date(r.started_at).toLocaleString()}</TableCell>
                <TableCell>{r.status}</TableCell>
                <TableCell className="text-right">{r.totals?.passed ?? 0}</TableCell>
                <TableCell className="text-right">{r.totals?.warnings ?? 0}</TableCell>
                <TableCell className="text-right">{r.totals?.failed ?? 0}</TableCell>
                <TableCell className="text-right">{r.totals?.critical ?? 0}</TableCell>
              </TableRow>
            ))}
            {(runs.data ?? []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  No system test has been run yet.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </SectionCard>

      {rows.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              ["attention", `Needs attention (${attention.length})`],
              ["pass", `Passed (${rows.length - attention.length})`],
              ["all", `All checks (${rows.length})`],
            ] as const
          ).map(([key, label]) => (
            <Button
              key={key}
              size="sm"
              variant={filter === key ? "default" : "outline"}
              onClick={() => setFilter(key)}
            >
              {label}
            </Button>
          ))}
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search checks…"
            className="h-9 w-full sm:w-64"
          />
        </div>
      ) : null}

      {suites.map(([suite, suiteRows]) => (
        <SectionCard key={suite} title={suite} description={`${suiteRows.length} checks`}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Check</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {suiteRows.map((row) => (
                <TableRow key={row.id} className="cursor-pointer" onClick={() => setDetail(row)}>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell>{statusBadge(row.status)}</TableCell>
                  <TableCell className="text-right">{row.duration_ms} ms</TableCell>
                  <TableCell className="max-w-[26rem] truncate text-muted-foreground">
                    {row.detail ?? `${row.assertions.length} assertions`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SectionCard>
      ))}

      {rows.length > 0 && suites.length === 0 ? (
        <p className="text-sm text-muted-foreground">No check matches this filter.</p>
      ) : null}

      <Dialog open={Boolean(detail)} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{detail?.name}</DialogTitle>
            <DialogDescription>{detail?.detail ?? "All checks passed."}</DialogDescription>
          </DialogHeader>
          {detail ? (
            <div className="space-y-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                {statusBadge(detail.status)}
                <span className="text-xs text-muted-foreground">
                  {detail.suite} · {detail.case_key}
                </span>
                <SourceRef row={detail} />
                <CopyButton text={reportFor(detail)} label="Copy report" />
              </div>
              <p className="text-muted-foreground">{STATUS_MEANING[detail.status]}</p>
              <div>
                <p className="mb-2 font-medium">Checks</p>
                <ul className="space-y-1">
                  {detail.assertions.map((a, i) => (
                    <li key={i} className="flex items-start gap-2">
                      {a.ok ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" />
                      ) : (
                        <XCircle className="mt-0.5 h-4 w-4 text-destructive" />
                      )}
                      <span>
                        {a.label}
                        {a.ok ? null : (
                          <span className="text-muted-foreground">
                            {" "}
                            — expected {JSON.stringify(a.expected)}, saw {JSON.stringify(a.actual)}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              {evidenceString(detail, "_failure_trace") ? (
                <div>
                  <p className="mb-2 font-medium">Where it stopped</p>
                  <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
                    {evidenceString(detail, "_failure_trace")}
                  </pre>
                </div>
              ) : null}
              <div>
                <p className="mb-2 font-medium">Evidence</p>
                <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
                  {JSON.stringify(detail.evidence ?? {}, null, 2)}
                </pre>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/platform/simulation">
      <SimulationCentre />
    </OpsGuard>
  );
}
