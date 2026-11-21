import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { SectionCard, StatCard } from "@/components/common/DataDisplay";
import {
  AccessDenied,
  EmptyState,
  TonePill,
  TruthNotice,
  formatDateTime,
  humanise,
  statusTone,
} from "@/components/platform/PlatformShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { PublicAppChecks } from "@/components/platform/PublicAppChecks";
import { WorkflowReadiness } from "@/components/platform/WorkflowReadiness";
import { usePublicAppHealth } from "@/lib/platform-public-app-health";
import { useGoLiveReadiness } from "@/lib/go-live";
import { canAccessPath } from "@/lib/nav-permissions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import {
  useDefects,
  useIntegrationConnections,
  useReadinessGates,
  useSaveRecord,
  useSecurityFindings,
  useSeedReadinessGates,
  useUatSignoffs,
} from "@/lib/platform-data";
import { defectGate, derivedConnectionStatus, readinessScore } from "@/lib/platform";
import type { GateLike } from "@/lib/platform";

export const Route = createFileRoute("/_shell/platform/")({
  component: ReadinessScreen,
});

const GATE_STATUSES = ["not_started", "in_progress", "passed", "failed", "waived"];

function ReadinessScreen() {
  const { can, isAdmin, organizationId, user } = useAuth();
  const gates = useReadinessGates();
  const defects = useDefects();
  const findings = useSecurityFindings();
  const uat = useUatSignoffs();
  const connections = useIntegrationConnections();
  const publicApps = usePublicAppHealth();
  const workflow = useGoLiveReadiness();
  const seed = useSeedReadinessGates();
  const saveGate = useSaveRecord("readiness_gates", "readiness.gate_updated");
  const [evidence, setEvidence] = useState<Record<string, string>>({});

  const rows = gates.data ?? [];
  const orgGates = rows.filter((g) => g["organization_id"] === organizationId);
  const templates = rows.filter((g) => g["organization_id"] === null);
  const active = (orgGates.length ? orgGates : templates).map((gate) => ({
    ...gate,
    status: ["passed", "waived"].includes(gate["status"]) && !String(gate["evidence_reference"] ?? "").trim() ? "not_started" : gate["status"],
  })) as unknown as GateLike[];
  const score = useMemo(() => readinessScore(active), [active]);

  const defectStatus = useMemo(
    () =>
      defectGate(
        (defects.data ?? []) as { severity: string; status: string; release_blocking?: boolean }[],
      ),
    [defects.data],
  );
  const openFindings = (findings.data ?? []).filter((f) => f["status"] !== "closed");
  const uatPending = (uat.data ?? []).filter((u) => u["status"] !== "passed");
  const unverifiedIntegrations = (connections.data ?? []).filter(
    (c) => c["enabled"] && derivedConnectionStatus(c as never) !== "connected",
  );

  if (!isAdmin && !can("platform", "view")) {
    return (
      <AccessDenied
        title="Go-live readiness is restricted"
        body="Only owners, system administrators and staff granted the platform module can review or sign off go-live gates."
      />
    );
  }

  const canEdit = can("platform", "edit");
  const approvalsVerified = gates.isSuccess && defects.isSuccess;
  const publicBlocked = publicApps.isSuccess && publicApps.data.some((check) => check.status === "blocked");
  const publishedVerified = publicApps.isSuccess && publicApps.data.every((check) =>
    check.state === "unpublished" ? check.status !== "blocked" : check.status === "verified");
  const propertyChecks = publicApps.branchId && workflow.isSuccess ? workflow.data.checks : [];
  const propertyBlocked = propertyChecks.filter((check) => check.status === "blocked").length;
  const propertyReady = propertyChecks.length > 0 && propertyChecks.every((check) => check.status === "ready");
  const signedOff = approvalsVerified && orgGates.length > 0 && score.goLive;
  const canGoLive = signedOff && defectStatus.releasable && publishedVerified && propertyReady
    && findings.isSuccess && uat.isSuccess && connections.isSuccess
    && openFindings.length === 0 && uatPending.length === 0 && unverifiedIntegrations.length === 0;
  const releaseBlocked = (defects.isSuccess && !defectStatus.releasable) || publicBlocked || propertyBlocked > 0;

  return (
    <div className="space-y-6">
      <TruthNotice>
        Check the selected property’s live results below. Organisation sign-off requires a saved evidence reference on each mandatory gate.
      </TruthNotice>

      <div className="neo-kpi-grid">
        <StatCard lead label="Mandatory gates passed" value={gates.isSuccess ? `${score.passed} / ${score.total}` : "Unverified"} />
        <StatCard label="Release-blocking defects" value={defects.isSuccess ? String(defectStatus.blocking) : "Unverified"} />
        <StatCard label="All open defects" value={defects.isSuccess ? String(defectStatus.open) : "Unverified"} />
        <StatCard label="Open security findings" value={findings.isSuccess ? String(openFindings.length) : "Unverified"} />
        <StatCard label="UAT scripts outstanding" value={uat.isSuccess ? String(uatPending.length) : "Unverified"} />
      </div>

      <SectionCard title="Go-live verdict" actions={
        <TonePill tone={releaseBlocked ? "danger" : canGoLive ? "success" : "warning"}>
          {releaseBlocked ? "Blocked" : canGoLive ? "Readiness checks passed" : "Evidence outstanding"}
        </TonePill>
      }>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
          <span>{propertyChecks.length ? `${propertyBlocked} blocked property checks` : "Property evidence awaiting verification"}</span>
          {isAdmin || canAccessPath(can, "/platform/quality") ? <Link to="/platform/quality" className="font-medium underline">Review defects</Link> : null}
          {isAdmin || canAccessPath(can, "/platform/simulation") ? <Link to="/platform/simulation" className="font-medium underline">Review end-to-end test runs</Link> : null}
        </div>
      </SectionCard>

      <PublicAppChecks />
      <WorkflowReadiness />

      <SectionCard
        title="Organisation approval"
        description={
          !approvalsVerified ? "Approval and defect evidence could not yet be verified."
            : signedOff ? "Every mandatory organisation gate has a decision and evidence reference."
            : `${score.blocking.length} mandatory gate(s) still need evidence.`
        }
        actions={
          <TonePill tone={signedOff ? "success" : "warning"}>
            {!approvalsVerified ? "Unverified" : signedOff ? "Signed off" : "Pending"}
          </TonePill>
        }
      >
        <Progress value={score.percent} className="h-2" />
        <p className="mt-2 text-sm text-muted-foreground">
          {score.percent}% of mandatory gates complete.
        </p>
        {unverifiedIntegrations.length > 0 ? (
          <p className="mt-3 text-sm text-on-tint-warning">
            {unverifiedIntegrations.length} enabled integration(s) are not fully verified. Review
            the Integration Centre before go-live.
          </p>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Go-live checklist"
        description="Every mandatory item must be verified, or formally waived with a reason, before commercial launch."
        actions={
          orgGates.length === 0 && canEdit ? (
            <Button
              size="sm"
              onClick={() => seed.mutate(templates)}
              disabled={seed.isPending || templates.length === 0}
            >
              <ShieldCheck className="mr-2 size-4" />
              Create organisation checklist
            </Button>
          ) : null
        }
      >
        {active.length === 0 ? (
          <EmptyState
            title="No readiness gates yet"
            body="Create the checklist to begin tracking go-live evidence."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Gate</TableHead>
                  <TableHead>Area</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Evidence reference</TableHead>
                  <TableHead>Verified</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(orgGates.length ? orgGates : templates).map((g) => {
                  const id = String(g["id"]);
                  const editable = canEdit && orgGates.length > 0;
                  const proof = (evidence[id] ?? String(g["evidence_reference"] ?? "")).trim();
                  return (
                    <TableRow key={id}>
                      <TableCell>
                        <p className="font-medium text-foreground">{String(g["name"])}</p>
                        <p className="text-xs text-muted-foreground">
                          {g["mandatory"] ? "Mandatory" : "Advisory"}
                        </p>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {humanise(String(g["category"]))}
                      </TableCell>
                      <TableCell>
                        {editable ? (
                          <Select
                            value={String(g["status"])}
                            onValueChange={(status) => {
                              const signedOff = status === "passed" || status === "waived";
                              if (signedOff && !proof) return;
                              saveGate.mutate({
                                id,
                                status,
                                ...(signedOff ? { evidence_reference: proof } : {}),
                                verified_by: signedOff ? (user?.id ?? null) : null,
                                verified_at: signedOff ? new Date().toISOString() : null,
                              });
                            }}
                          >
                            <SelectTrigger className="h-8 w-40">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {GATE_STATUSES.map((s) => (
                                <SelectItem key={s} value={s} disabled={(s === "passed" || s === "waived") && !proof}>
                                  {humanise(s)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <TonePill tone={statusTone(String(g["status"]))}>
                            {humanise(String(g["status"]))}
                          </TonePill>
                        )}
                      </TableCell>
                      <TableCell>
                        {editable ? (
                          <div className="flex gap-2">
                            <Input
                              className="h-8 w-48"
                              placeholder="Report or ticket reference"
                              value={evidence[id] ?? String(g["evidence_reference"] ?? "")}
                              onChange={(e) => setEvidence((p) => ({ ...p, [id]: e.target.value }))}
                            />
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() =>
                                saveGate.mutate({ id, evidence_reference: evidence[id] ?? "" })
                              }
                            >
                              Save
                            </Button>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">
                            {String(g["evidence_reference"] ?? "—")}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDateTime(g["verified_at"] as string)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
