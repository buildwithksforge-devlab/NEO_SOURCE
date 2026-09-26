import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
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
  const seed = useSeedReadinessGates();
  const saveGate = useSaveRecord("readiness_gates", "readiness.gate_updated");
  const [evidence, setEvidence] = useState<Record<string, string>>({});

  const rows = gates.data ?? [];
  const orgGates = rows.filter((g) => g["organization_id"] === organizationId);
  const templates = rows.filter((g) => g["organization_id"] === null);
  const active = (orgGates.length ? orgGates : templates) as unknown as GateLike[];
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

  return (
    <div className="space-y-6">
      <TruthNotice>
        Readiness is calculated only from recorded evidence. A gate stays open until someone with
        authority marks it passed and attaches an evidence reference — the platform never marks
        itself ready.
      </TruthNotice>

      <div className="neo-kpi-grid">
        <StatCard lead label="Mandatory gates passed" value={`${score.passed} / ${score.total}`} />
        <StatCard label="Release-blocking defects" value={String(defectStatus.blocking)} />
        <StatCard label="Open security findings" value={String(openFindings.length)} />
        <StatCard label="UAT scripts outstanding" value={String(uatPending.length)} />
      </div>

      <SectionCard
        title={score.goLive ? "All mandatory gates satisfied" : "Go-live is blocked"}
        description={
          score.goLive
            ? "Every mandatory readiness gate has been verified or formally waived by an authorised approver."
            : `${score.blocking.length} mandatory gate(s) still require verification before this property can go live.`
        }
        actions={
          <TonePill tone={score.goLive ? "success" : "warning"}>
            {score.goLive ? "Ready" : "Not ready"}
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
              Create checklist for this property
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
                            onValueChange={(status) =>
                              saveGate.mutate({
                                id,
                                status,
                                verified_by: status === "passed" ? (user?.id ?? null) : null,
                                verified_at: status === "passed" ? new Date().toISOString() : null,
                              })
                            }
                          >
                            <SelectTrigger className="h-8 w-40">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {GATE_STATUSES.map((s) => (
                                <SelectItem key={s} value={s}>
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
