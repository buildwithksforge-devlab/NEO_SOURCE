/**
 * Recovery Centre — the five levels of recovery in one place.
 *
 * Levels 1 and 2 are performed in the modules that own them; this screen owns
 * levels 3 and 4 (property and workspace restore) and records level 5 (what
 * the hosting provider actually gives us). It also owns the workspace
 * lifecycle: export, suspend, scheduled deletion and the deletion certificate.
 */
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, Camera, CheckCircle2, ShieldAlert, ShieldCheck } from "lucide-react";
import { SectionCard } from "@/components/common/DataDisplay";
import { AccessDenied, EmptyState, TonePill, TruthNotice, humanise } from "@/components/platform/PlatformShared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth";
import {
  buildRecoveryLevels,
  useApproveRestore,
  useBackupRecords,
  useBackupTerms,
  useCancelRestore,
  useDeletionCertificates,
  useExecuteRestore,
  useLifecycleAction,
  usePlanRestore,
  useRecordBackupTerms,
  useRequestRestore,
  useRestoreRuns,
  useRunDrill,
  useVerifySnapshot,
  useSnapshots,
  useTakeSnapshot,
  useTenantLifecycle,
} from "@/lib/recovery-data";

export const Route = createFileRoute("/_shell/platform/recovery")({
  head: () => ({
    meta: [
      { title: "Recovery Centre · NEØ" },
      {
        name: "description",
        content:
          "Workspace snapshots, restore comparisons, verification drills and the export, suspend and deletion lifecycle.",
      },
      { property: "og:title", content: "Recovery Centre · NEØ" },
      {
        property: "og:description",
        content: "Five levels of recovery, from a single correction to a full platform restore.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: RecoveryCentre,
});

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

function when(value: unknown) {
  if (!value) return "—";
  return new Date(String(value)).toLocaleString();
}

function RecoveryCentre() {
  const { can, isAdmin, organizationId } = useAuth();
  const mayView = isAdmin || can("administration", "recovery", "view");
  const mayManage = isAdmin || can("administration", "recovery", "manage");
  const mayApprove = isAdmin || can("administration", "recovery", "approve");

  const snapshots = useSnapshots(organizationId);
  const runs = useRestoreRuns(organizationId);
  const backups = useBackupRecords(organizationId);
  const lifecycle = useTenantLifecycle(organizationId);
  const certificates = useDeletionCertificates(organizationId);
  const terms = useBackupTerms();

  const takeSnapshot = useTakeSnapshot();
  const runDrill = useRunDrill();
  const verifySnapshot = useVerifySnapshot();
  const planRestore = usePlanRestore();
  const requestRestore = useRequestRestore();
  const approveRestore = useApproveRestore();
  const cancelRestore = useCancelRestore();
  const executeRestore = useExecuteRestore();
  const lifecycleAction = useLifecycleAction();
  const recordTerms = useRecordBackupTerms();

  const [label, setLabel] = useState("");
  const [restoreReason, setRestoreReason] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [suspendReason, setSuspendReason] = useState("");
  const [termsForm, setTermsForm] = useState({
    provider: "",
    frequency: "",
    retentionDays: "",
    pitr: "",
    pitrWindowHours: "",
    region: "",
    source: "",
  });

  const latestSnapshot = useMemo(
    () => (snapshots.data ?? []).find((s) => s["status"] === "completed") ?? null,
    [snapshots.data],
  );
  const lastVerified = useMemo(() => {
    const verified = (backups.data ?? []).find((b) => b["verified"] && b["restore_tested_at"]);
    return verified ? String(verified["restore_tested_at"]) : null;
  }, [backups.data]);
  const productionEnv = useMemo(
    () => (terms.data ?? []).find((e) => e["is_production"]) ?? (terms.data ?? [])[0] ?? null,
    [terms.data],
  );

  const levels = buildRecoveryLevels({
    latestSnapshot,
    lastVerifiedDrillAt: lastVerified,
    providerTermsRecorded: Boolean(productionEnv?.["backup_terms_recorded_at"]),
    providerPitr: (productionEnv?.["pitr_enabled"] ?? null) as boolean | null,
    providerRetentionDays: (productionEnv?.["backup_retention_days"] ?? null) as number | null,
  });

  if (!mayView) {
    return (
      <AccessDenied
        title="Recovery is restricted"
        body="Snapshots, restores and workspace deletion are controlled by the recovery rights. Ask an administrator to grant them to your role."
      />
    );
  }

  const state = String(lifecycle.data?.["state"] ?? "active");

  return (
    <div className="space-y-6">
      <TruthNotice>
        A backup only counts once a restore drill has verified it. Anything not yet recorded or tested is shown as
        untested, never as protection.
      </TruthNotice>

      {/* ------------------------------------------------- five levels */}
      <SectionCard title="Recovery levels" description="Different problems need different answers.">
        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {levels.map((l) => (
            <Card key={l.level} className="surface-panel">
              <CardContent className="space-y-2 py-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold text-foreground">
                    {l.level}. {l.title}
                  </p>
                  <TonePill tone={l.available ? "success" : "warning"}>
                    {l.available ? "Available" : "Not established"}
                  </TonePill>
                </div>
                <p className="text-sm text-muted-foreground">{l.problem}</p>
                <p className="text-sm text-foreground">{l.answer}</p>
                <p className="text-xs text-muted-foreground">{l.detail}</p>
                {l.to ? (
                  <Link to={l.to} className="text-xs font-medium text-primary underline-offset-4 hover:underline">
                    Open
                  </Link>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      </SectionCard>

      {/* --------------------------------------------- provider terms */}
      <SectionCard
        title="Hosting provider backups"
        description="What the provider actually guarantees. This cannot be read from inside the database — confirm it and record it here."
      >
        {productionEnv?.["backup_terms_recorded_at"] ? (
          <div className="mb-4 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Fact label="Provider" value={productionEnv["backup_provider"]} />
            <Fact label="Frequency" value={productionEnv["backup_frequency"]} />
            <Fact
              label="Retention"
              value={productionEnv["backup_retention_days"] ? `${productionEnv["backup_retention_days"]} days` : null}
            />
            <Fact
              label="Point-in-time recovery"
              value={
                productionEnv["pitr_enabled"] === null
                  ? null
                  : productionEnv["pitr_enabled"]
                    ? `Yes${productionEnv["pitr_window_hours"] ? ` · ${productionEnv["pitr_window_hours"]}h` : ""}`
                    : "No"
              }
            />
            <Fact label="Region" value={productionEnv["backup_region"]} />
            <Fact label="Source" value={productionEnv["backup_terms_source"]} />
            <Fact label="Recorded" value={when(productionEnv["backup_terms_recorded_at"])} />
          </div>
        ) : (
          <div className="mb-4 flex items-start gap-2 rounded-lg bg-warning/15 px-3 py-2 text-sm text-on-tint-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              Not established. Until these terms are confirmed and recorded, assume there is no platform-level
              recovery beyond the snapshots taken here.
            </span>
          </div>
        )}

        {mayManage && productionEnv ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Provider" value={termsForm.provider} onChange={(v) => setTermsForm({ ...termsForm, provider: v })} />
            <Field label="Frequency" value={termsForm.frequency} onChange={(v) => setTermsForm({ ...termsForm, frequency: v })} />
            <Field
              label="Retention (days)"
              value={termsForm.retentionDays}
              onChange={(v) => setTermsForm({ ...termsForm, retentionDays: v })}
            />
            <Field
              label="Point-in-time recovery (yes/no)"
              value={termsForm.pitr}
              onChange={(v) => setTermsForm({ ...termsForm, pitr: v })}
            />
            <Field
              label="Recovery window (hours)"
              value={termsForm.pitrWindowHours}
              onChange={(v) => setTermsForm({ ...termsForm, pitrWindowHours: v })}
            />
            <Field label="Region" value={termsForm.region} onChange={(v) => setTermsForm({ ...termsForm, region: v })} />
            <Field
              label="Who confirmed this"
              value={termsForm.source}
              onChange={(v) => setTermsForm({ ...termsForm, source: v })}
            />
            <div className="flex items-end">
              <Button
                onClick={() =>
                  recordTerms.mutate({
                    environmentKey: String(productionEnv["key"]),
                    provider: termsForm.provider,
                    frequency: termsForm.frequency,
                    retentionDays: termsForm.retentionDays ? Number(termsForm.retentionDays) : null,
                    pitr: termsForm.pitr ? /^y|true/i.test(termsForm.pitr) : null,
                    pitrWindowHours: termsForm.pitrWindowHours ? Number(termsForm.pitrWindowHours) : null,
                    region: termsForm.region,
                    source: termsForm.source,
                  })
                }
                disabled={!termsForm.provider || !termsForm.source || recordTerms.isPending}
              >
                Record terms
              </Button>
            </div>
          </div>
        ) : null}
      </SectionCard>

      {/* ------------------------------------------------- snapshots */}
      <SectionCard
        title="Snapshots"
        description="A snapshot captures this workspace's records so a property or the whole workspace can be put back."
      >
        {mayManage ? (
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1">
              <Label className="text-xs">Label</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Before menu re-import" />
            </div>
            <Button onClick={() => takeSnapshot.mutate({ label })} disabled={takeSnapshot.isPending}>
              <Camera className="mr-2 size-4" />
              {takeSnapshot.isPending ? "Capturing…" : "Take snapshot"}
            </Button>
          </div>
        ) : null}

        {(snapshots.data ?? []).length === 0 ? (
          <EmptyState
            title="No snapshots yet"
            body="Take a snapshot before any large import, configuration change or property closure."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Taken</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead className="text-right">Tables</TableHead>
                  <TableHead className="text-right">Records</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(snapshots.data ?? []).map((s: Row) => (
                  <TableRow key={String(s["id"])}>
                    <TableCell className="whitespace-nowrap">{when(s["created_at"])}</TableCell>
                    <TableCell>{humanise(String(s["scope"]))}</TableCell>
                    <TableCell>{s["label"] ?? "—"}</TableCell>
                    <TableCell className="text-right">{Number(s["table_count"] ?? 0)}</TableCell>
                    <TableCell className="text-right">{Number(s["row_count"] ?? 0)}</TableCell>
                    <TableCell>
                      <TonePill tone={s["status"] === "completed" ? "success" : s["status"] === "failed" ? "danger" : "info"}>
                        {humanise(String(s["status"]))}
                      </TonePill>
                    </TableCell>
                    <TableCell className="space-x-2 text-right">
                      {mayManage && s["status"] === "completed" ? (
                        <>
                          <Button size="sm" variant="outline" onClick={() => verifySnapshot.mutate(String(s["id"]))}>
                            Verify
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => runDrill.mutate(String(s["id"]))}>
                            Drill
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => planRestore.mutate(String(s["id"]))}>
                            Compare
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              requestRestore.mutate({
                                snapshotId: String(s["id"]),
                                reason: restoreReason || "Restore requested from the Recovery Centre",
                              })
                            }
                          >
                            Request restore
                          </Button>
                        </>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {mayManage ? (
          <div className="mt-3">
            <Label className="text-xs">Reason used when requesting a restore</Label>
            <Textarea
              value={restoreReason}
              onChange={(e) => setRestoreReason(e.target.value)}
              placeholder="Why this workspace or property needs to be put back"
              rows={2}
            />
          </div>
        ) : null}
      </SectionCard>

      {/* ---------------------------------------------- restore runs */}
      <SectionCard
        title="Restores and drills"
        description="Every comparison, drill and real restore, with who asked, who approved and what changed."
      >
        {(runs.data ?? []).length === 0 ? (
          <EmptyState title="Nothing restored yet" body="Comparisons and drills appear here as soon as you run one." />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Summary</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(runs.data ?? []).map((r: Row) => {
                  const totals = (r["plan"]?.["totals"] ?? {}) as Row;
                  const result = (r["result"] ?? {}) as Row;
                  return (
                    <TableRow key={String(r["id"])}>
                      <TableCell className="whitespace-nowrap">{when(r["created_at"])}</TableCell>
                      <TableCell>{humanise(String(r["mode"]))}</TableCell>
                      <TableCell>
                        <TonePill
                          tone={
                            r["status"] === "completed" ? "success" : r["status"] === "failed" ? "danger" : "info"
                          }
                        >
                          {humanise(String(r["status"]))}
                        </TonePill>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {r["mode"] === "drill"
                          ? `${Number(result["tables_verified"] ?? 0)} verified · ${Number(result["tables_failed"] ?? 0)} failed`
                          : `${Number(totals["would_restore"] ?? 0)} to restore · ${Number(
                              totals["would_overwrite"] ?? 0,
                            )} would change · ${Number(totals["protected_tables"] ?? 0)} protected`}
                      </TableCell>
                      <TableCell className="space-x-2 text-right">
                        {r["status"] === "awaiting_approval" && mayApprove ? (
                          <Button size="sm" onClick={() => approveRestore.mutate({ runId: String(r["id"]) })}>
                            Approve
                          </Button>
                        ) : null}
                        {r["status"] === "approved" && mayManage ? (
                          <Button size="sm" onClick={() => executeRestore.mutate(String(r["id"]))}>
                            Run restore
                          </Button>
                        ) : null}
                        {["planned", "awaiting_approval", "approved"].includes(String(r["status"])) && mayManage ? (
                          <Button size="sm" variant="outline" onClick={() => cancelRestore.mutate({ runId: String(r["id"]) })}>
                            Cancel
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

      {/* ------------------------------------------------- lifecycle */}
      <SectionCard
        title="Workspace lifecycle"
        description="Export, suspend and deletion. Nothing is destroyed until an export has been verified, a grace period has passed and a second person has approved."
      >
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <TonePill tone={state === "active" ? "success" : state === "deleted" ? "danger" : "warning"}>
            {humanise(state)}
          </TonePill>
          {lifecycle.data?.["export_verified_at"] ? (
            <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
              <CheckCircle2 className="size-4" /> Verified export {when(lifecycle.data["export_verified_at"])}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
              <ShieldAlert className="size-4" /> No verified export
            </span>
          )}
          {lifecycle.data?.["grace_until"] ? (
            <span className="text-sm text-muted-foreground">Grace period ends {when(lifecycle.data["grace_until"])}</span>
          ) : null}
        </div>

        {mayManage ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-64 flex-1">
                <Label className="text-xs">Reason</Label>
                <Input
                  value={suspendReason}
                  onChange={(e) => setSuspendReason(e.target.value)}
                  placeholder="Why this workspace is being suspended or offboarded"
                />
              </div>
              {latestSnapshot ? (
                <Button
                  variant="outline"
                  onClick={() =>
                    lifecycleAction.mutate({ action: "set_export", snapshotId: String(latestSnapshot["id"]) })
                  }
                >
                  Use latest snapshot as export
                </Button>
              ) : null}
              {state === "active" ? (
                <Button
                  variant="outline"
                  disabled={!suspendReason}
                  onClick={() => lifecycleAction.mutate({ action: "suspend", reason: suspendReason })}
                >
                  Suspend
                </Button>
              ) : null}
              {state === "suspended" || state === "offboarding" ? (
                <Button variant="outline" onClick={() => lifecycleAction.mutate({ action: "resume" })}>
                  Resume
                </Button>
              ) : null}
              {state === "suspended" ? (
                <Button
                  variant="outline"
                  disabled={!suspendReason}
                  onClick={() => lifecycleAction.mutate({ action: "begin_offboarding", reason: suspendReason })}
                >
                  Start offboarding
                </Button>
              ) : null}
              {state === "offboarding" ? (
                <Button
                  variant="destructive"
                  disabled={!suspendReason}
                  onClick={() =>
                    lifecycleAction.mutate({ action: "request_deletion", reason: suspendReason, graceDays: 30 })
                  }
                >
                  Request deletion
                </Button>
              ) : null}
              {state === "pending_deletion" ? (
                <>
                  {mayApprove ? (
                    <Button variant="outline" onClick={() => lifecycleAction.mutate({ action: "approve_deletion" })}>
                      Approve deletion
                    </Button>
                  ) : null}
                  <Button variant="outline" onClick={() => lifecycleAction.mutate({ action: "cancel_deletion" })}>
                    Cancel deletion
                  </Button>
                </>
              ) : null}
            </div>

            {state === "pending_deletion" ? (
              <div className="flex flex-wrap items-end gap-3 rounded-lg border border-destructive/40 p-3">
                <div className="min-w-64 flex-1">
                  <Label className="text-xs">Type the workspace name to confirm permanent deletion</Label>
                  <Input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
                </div>
                <Button
                  variant="destructive"
                  disabled={!confirmName}
                  onClick={() => lifecycleAction.mutate({ action: "execute_deletion", confirmName })}
                >
                  Delete workspace permanently
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {(certificates.data ?? []).length > 0 ? (
          <div className="mt-5 space-y-2">
            <p className="flex items-center gap-2 text-sm font-medium text-foreground">
              <ShieldCheck className="size-4" /> Deletion certificates
            </p>
            {(certificates.data ?? []).map((c: Row) => (
              <p key={String(c["id"])} className="text-sm text-muted-foreground">
                {String(c["organization_name"])} · {when(c["executed_at"])} ·{" "}
                {Object.keys((c["removed_summary"] ?? {}) as Row).length} table(s) · export {String(c["export_reference"] ?? "—")}
              </p>
            ))}
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm text-foreground">{value ? String(value) : "Not recorded"}</p>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
