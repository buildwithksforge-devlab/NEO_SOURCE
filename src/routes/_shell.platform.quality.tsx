import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth";
import {
  useDefects,
  useSaveRecord,
  useSecurityFindings,
  useTestRuns,
  useTestSuites,
  useUatSignoffs,
} from "@/lib/platform-data";
import { defectGate, reference } from "@/lib/platform";

export const Route = createFileRoute("/_shell/platform/quality")({
  component: QualityScreen,
});

const SEVERITIES = ["critical", "high", "medium", "low"];
const DEFECT_STATUSES = [
  "new",
  "triaged",
  "in_progress",
  "fixed",
  "retesting",
  "closed",
  "rejected",
  "accepted",
];
const MODULES = [
  "front-office",
  "restaurant",
  "kitchen",
  "housekeeping",
  "inventory",
  "finance",
  "events",
  "hr",
  "delivery",
  "marketing",
  "analytics",
  "administration",
];

function QualityScreen() {
  const { can, isAdmin, user } = useAuth();
  const suites = useTestSuites();
  const runs = useTestRuns();
  const defects = useDefects();
  const uat = useUatSignoffs();
  const findings = useSecurityFindings();
  const saveDefect = useSaveRecord("defects", "quality.defect_saved");
  const saveUat = useSaveRecord("uat_signoffs", "quality.uat_updated");
  const [defectOpen, setDefectOpen] = useState(false);

  const canView = can("quality", "view");
  const canEdit = can("quality", "edit");

  const gate = useMemo(
    () =>
      defectGate(
        (defects.data ?? []) as { severity: string; status: string; release_blocking?: boolean }[],
      ),
    [defects.data],
  );

  if (!canView) {
    return (
      <AccessDenied
        title="Testing and defects are restricted"
        body="Quality records drive release approval. Ask an administrator to grant the quality module to your role."
      />
    );
  }

  return (
    <div className="space-y-6">
      <TruthNotice>
        Test outcomes are recorded by the person who ran them. A capability that has not been
        exercised stays “Not run” rather than being assumed to work, and a release is blocked while
        any critical defect is open.
      </TruthNotice>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Test suites" value={String((suites.data ?? []).length)} />
        <StatCard label="Open defects" value={String(gate.open)} />
        <StatCard label="Release-blocking" value={String(gate.blocking)} />
        <StatCard
          label="Open security findings"
          value={String((findings.data ?? []).filter((f) => f["status"] !== "closed").length)}
        />
      </div>

      <Tabs defaultValue="defects">
        <TabsList>
          <TabsTrigger value="defects">Defects</TabsTrigger>
          <TabsTrigger value="runs">Test runs</TabsTrigger>
          <TabsTrigger value="uat">UAT sign-off</TabsTrigger>
          <TabsTrigger value="security">Security findings</TabsTrigger>
        </TabsList>

        <TabsContent value="defects" className="mt-4">
          <SectionCard
            title="Defect register"
            description="Reproduction steps, severity, owner and retest outcome for every reported issue."
            actions={
              canEdit ? (
                <Button size="sm" onClick={() => setDefectOpen(true)}>
                  <Plus className="mr-2 size-4" />
                  Log defect
                </Button>
              ) : null
            }
          >
            {(defects.data ?? []).length === 0 ? (
              <EmptyState
                title="No defects logged"
                body="Issues found during testing or pilot operation are recorded here."
              />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Reference</TableHead>
                      <TableHead>Summary</TableHead>
                      <TableHead>Module</TableHead>
                      <TableHead>Severity</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Logged</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(defects.data ?? []).map((d) => (
                      <TableRow key={String(d["id"])}>
                        <TableCell className="font-mono text-xs">
                          {String(d["reference"])}
                        </TableCell>
                        <TableCell className="max-w-sm truncate">{String(d["summary"])}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {humanise(String(d["module"]))}
                        </TableCell>
                        <TableCell>
                          <TonePill tone={statusTone(String(d["severity"]))}>
                            {humanise(String(d["severity"]))}
                          </TonePill>
                        </TableCell>
                        <TableCell>
                          {canEdit ? (
                            <Select
                              value={String(d["status"])}
                              onValueChange={(status) =>
                                saveDefect.mutate({
                                  id: d["id"],
                                  status,
                                  resolved_at:
                                    status === "closed" ? new Date().toISOString() : null,
                                })
                              }
                            >
                              <SelectTrigger className="h-8 w-36">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {DEFECT_STATUSES.map((s) => (
                                  <SelectItem key={s} value={s}>
                                    {humanise(s)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <TonePill tone={statusTone(String(d["status"]))}>
                              {humanise(String(d["status"]))}
                            </TonePill>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDateTime(d["created_at"] as string)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="runs" className="mt-4">
          <SectionCard
            title="Test runs"
            description="Recorded execution of a suite in a specific environment."
          >
            {(runs.data ?? []).length === 0 ? (
              <EmptyState
                title="No test runs recorded"
                body="Runs appear once a suite has actually been executed and its outcome recorded."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Environment</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Passed</TableHead>
                    <TableHead>Failed</TableHead>
                    <TableHead>Finished</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(runs.data ?? []).map((r) => (
                    <TableRow key={String(r["id"])}>
                      <TableCell>{humanise(String(r["environment"]))}</TableCell>
                      <TableCell>
                        <TonePill tone={statusTone(String(r["status"]))}>
                          {humanise(String(r["status"]))}
                        </TonePill>
                      </TableCell>
                      <TableCell>{String(r["passed"])}</TableCell>
                      <TableCell>{String(r["failed"])}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDateTime(r["finished_at"] as string)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="uat" className="mt-4">
          <SectionCard
            title="User acceptance sign-off"
            description="Each role tests its own journeys and signs off before go-live."
          >
            {(uat.data ?? []).length === 0 ? (
              <EmptyState
                title="No UAT scripts recorded"
                body="Add the role-based acceptance scripts your pilot property will run."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Role</TableHead>
                    <TableHead>Script</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Tester</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(uat.data ?? []).map((u) => (
                    <TableRow key={String(u["id"])}>
                      <TableCell>{humanise(String(u["role_scope"]))}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {String(u["script_name"])}
                      </TableCell>
                      <TableCell>
                        {canEdit ? (
                          <Select
                            value={String(u["status"])}
                            onValueChange={(status) =>
                              saveUat.mutate({
                                id: u["id"],
                                status,
                                signed_by: status === "passed" ? (user?.id ?? null) : null,
                                signed_at: status === "passed" ? new Date().toISOString() : null,
                              })
                            }
                          >
                            <SelectTrigger className="h-8 w-32">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {["pending", "passed", "failed", "blocked"].map((s) => (
                                <SelectItem key={s} value={s}>
                                  {humanise(s)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <TonePill tone={statusTone(String(u["status"]))}>
                            {humanise(String(u["status"]))}
                          </TonePill>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {String(u["tester_name"] ?? "—")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="security" className="mt-4">
          <SectionCard
            title="Security findings"
            description="Findings from tenant isolation, permission and penetration testing."
          >
            {(findings.data ?? []).length === 0 ? (
              <EmptyState
                title="No findings recorded"
                body="Record the outcome of each security test so remediation can be tracked."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reference</TableHead>
                    <TableHead>Finding</TableHead>
                    <TableHead>Severity</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(findings.data ?? []).map((f) => (
                    <TableRow key={String(f["id"])}>
                      <TableCell className="font-mono text-xs">{String(f["reference"])}</TableCell>
                      <TableCell className="max-w-sm truncate">{String(f["title"])}</TableCell>
                      <TableCell>
                        <TonePill tone={statusTone(String(f["severity"]))}>
                          {humanise(String(f["severity"]))}
                        </TonePill>
                      </TableCell>
                      <TableCell>
                        <TonePill tone={statusTone(String(f["status"]))}>
                          {humanise(String(f["status"]))}
                        </TonePill>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </SectionCard>
        </TabsContent>
      </Tabs>

      <DefectDialog
        open={defectOpen}
        onClose={() => setDefectOpen(false)}
        onSave={(values) => saveDefect.mutate(values, { onSuccess: () => setDefectOpen(false) })}
      />
    </div>
  );
}

function DefectDialog({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (values: Record<string, unknown>) => void;
}) {
  const { user } = useAuth();
  const [summary, setSummary] = useState("");
  const [module, setModule] = useState("front-office");
  const [severity, setSeverity] = useState("medium");
  const [steps, setSteps] = useState("");
  const [expected, setExpected] = useState("");
  const [actual, setActual] = useState("");

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : null)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Log a defect</DialogTitle>
          <DialogDescription>
            Capture enough detail for someone else to reproduce the issue exactly.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="summary">Summary</Label>
            <Input id="summary" value={summary} onChange={(e) => setSummary(e.target.value)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Module</Label>
              <Select value={module} onValueChange={setModule}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODULES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {humanise(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Severity</Label>
              <Select value={severity} onValueChange={setSeverity}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {humanise(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="steps">Steps to reproduce</Label>
            <Textarea
              id="steps"
              rows={3}
              value={steps}
              onChange={(e) => setSteps(e.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="expected">Expected result</Label>
              <Textarea
                id="expected"
                rows={2}
                value={expected}
                onChange={(e) => setExpected(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="actual">Actual result</Label>
              <Textarea
                id="actual"
                rows={2}
                value={actual}
                onChange={(e) => setActual(e.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={!summary.trim()}
              onClick={() =>
                onSave({
                  reference: reference("DEF"),
                  summary,
                  module,
                  severity,
                  steps_to_reproduce: steps,
                  expected_result: expected,
                  actual_result: actual,
                  release_blocking: severity === "critical",
                  reported_by: user?.id ?? null,
                })
              }
            >
              Log defect
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
