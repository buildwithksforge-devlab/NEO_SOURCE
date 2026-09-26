/**
 * Integration Centre — Printers.
 *
 * Printers are declared here, assigned to a property and a department (Front
 * Office, Kitchen, Bar), given a backup printer and retry settings, and
 * monitored through the live print queue. A test print is queued like any
 * other job; the operator records whether paper actually came out, so the
 * health shown here is always an observed result and never an assumption.
 */
import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Printer as PrinterIcon, RefreshCcw } from "lucide-react";
import { SectionCard, TableScroll } from "@/components/common/DataDisplay";
import { AccessDenied, EmptyState, TonePill, TruthNotice, formatDateTime, humanise } from "@/components/platform/PlatformShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import { useBranches } from "@/lib/branches";
import { useDepartmentsLite } from "@/lib/frontdesk-ops";
import {
  usePrinters,
  usePrintJobs,
  useQueuePrint,
  useRecordPrintResult,
  useRetryPrintJob,
  useSavePrinter,
  type Printer,
} from "@/lib/printing";

export const Route = createFileRoute("/_shell/platform/printers")({
  head: () => ({
    meta: [
      { title: "Printers & Print Queue — Integration Centre" },
      {
        name: "description",
        content:
          "Declare receipt and ticket printers, assign them to a property and department, set retries and a backup printer, run a test print and monitor the live print queue.",
      },
      { property: "og:title", content: "Printers & Print Queue — Integration Centre" },
      {
        property: "og:description",
        content: "Printer assignment, test prints, retries, failover and queue monitoring with observed results only.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PrintersPage,
});

const HEALTH_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  online: "success",
  error: "danger",
  unknown: "neutral",
};

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  completed: "success",
  queued: "warning",
  printing: "warning",
  failed: "danger",
  cancelled: "neutral",
};

function PrintersPage() {
  const { organizationId, can } = useAuth();
  const canManage = can("integrations", "edit") || can("restaurant", "edit");

  const printers = usePrinters(organizationId);
  const jobs = usePrintJobs(organizationId);
  const branches = useBranches();
  const departments = useDepartmentsLite();

  const savePrinter = useSavePrinter();
  const queuePrint = useQueuePrint();
  const recordResult = useRecordPrintResult();
  const retryJob = useRetryPrintJob();

  const [failureNote, setFailureNote] = useState("");
  const [newName, setNewName] = useState("");
  const [newBranch, setNewBranch] = useState<string>("");
  const [newDepartment, setNewDepartment] = useState<string>("");
  const [newAddress, setNewAddress] = useState("");

  const printerList = printers.data ?? [];
  const byId = useMemo(() => {
    const map: Record<string, Printer> = {};
    for (const p of printerList) map[p.id] = p;
    return map;
  }, [printerList]);

  if (!canManage) {
    return (
      <AccessDenied
        title="Printer setup is not enabled for your role"
        body="Assigning printers and clearing the print queue needs the integration centre or point-of-sale settings permission."
      />
    );
  }

  return (
    <div className="space-y-6">
      <TruthNotice>
        A printer is only shown as working after a real job succeeded on it. Queueing a job does not print it: a
        printing agent, or the person who ran the test, records what actually happened.
      </TruthNotice>

      <SectionCard title="Add a printer" description="Give it a name, the property it sits in and where it is reachable.">
        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <Label>Name</Label>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Front Office receipt" />
          </div>
          <div>
            <Label>Property</Label>
            <Select value={newBranch} onValueChange={setNewBranch}>
              <SelectTrigger><SelectValue placeholder="Select property" /></SelectTrigger>
              <SelectContent>
                {(branches.data ?? []).map((b) => (
                  <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Department</Label>
            <Select value={newDepartment} onValueChange={setNewDepartment}>
              <SelectTrigger><SelectValue placeholder="Select department" /></SelectTrigger>
              <SelectContent>
                {(departments.data ?? []).map((d: { id: string; name: string }) => (
                  <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Address</Label>
            <Input value={newAddress} onChange={(e) => setNewAddress(e.target.value)} placeholder="192.168.1.50:9100" />
          </div>
        </div>
        <div className="mt-3">
          <Button
            disabled={!newName.trim() || !newBranch || savePrinter.isPending}
            onClick={() =>
              savePrinter.mutate(
                {
                  organization_id: organizationId,
                  name: newName.trim(),
                  branch_id: newBranch,
                  department_id: newDepartment || null,
                  address: newAddress.trim() || null,
                  active: true,
                },
                {
                  onSuccess: () => {
                    setNewName("");
                    setNewAddress("");
                    setNewDepartment("");
                  },
                },
              )
            }
          >
            <PrinterIcon className="mr-2 h-4 w-4" /> Add printer
          </Button>
        </div>
      </SectionCard>

      <SectionCard title="Printers" description="Assignment, retries, backup printer and last observed result.">
        {printerList.length === 0 ? (
          <EmptyState title="No printers declared yet" body="Add the first printer above." />
        ) : (
          <TableScroll><Table>
            <TableHeader>
              <TableRow>
                <TableHead>Printer</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Retries</TableHead>
                <TableHead>Backup printer</TableHead>
                <TableHead>Health</TableHead>
                <TableHead className="text-right">Test print</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {printerList.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-muted-foreground">{p.address ?? "No address recorded"}</div>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={p.department_id ?? "none"}
                      onValueChange={(v) =>
                        savePrinter.mutate({ id: p.id, department_id: v === "none" ? null : v })
                      }
                    >
                      <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Not assigned</SelectItem>
                        {(departments.data ?? []).map((d: { id: string; name: string }) => (
                          <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min={1}
                      className="w-20"
                      defaultValue={p.retry_limit}
                      onBlur={(e) => {
                        const value = Number(e.target.value);
                        if (Number.isFinite(value) && value >= 1 && value !== p.retry_limit) {
                          savePrinter.mutate({ id: p.id, retry_limit: Math.round(value) });
                        }
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <Select
                      value={p.fallback_printer_id ?? "none"}
                      onValueChange={(v) =>
                        savePrinter.mutate({ id: p.id, fallback_printer_id: v === "none" ? null : v })
                      }
                    >
                      <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No backup</SelectItem>
                        {printerList
                          .filter((other) => other.id !== p.id)
                          .map((other) => (
                            <SelectItem key={other.id} value={other.id}>{other.name}</SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <TonePill tone={HEALTH_TONE[p.health_status] ?? "neutral"}>{humanise(p.health_status)}</TonePill>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {p.last_success_at
                        ? `Last printed ${formatDateTime(p.last_success_at)}`
                        : p.last_failure_at
                          ? `Last failed ${formatDateTime(p.last_failure_at)}`
                          : "No print recorded"}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={queuePrint.isPending}
                      onClick={() =>
                        queuePrint.mutate({
                          printer: p.id,
                          documentType: "test",
                          title: `Test print — ${p.name}`,
                          payload: { lines: ["NEO test print", p.name] },
                        })
                      }
                    >
                      Queue test print
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table></TableScroll>
        )}
      </SectionCard>

      <SectionCard
        title="Print queue"
        description="Every queued job, its attempts, and whether it fell over to the backup printer."
      >
        <div className="mb-3 max-w-md">
          <Label>Failure note (used when recording a failure)</Label>
          <Input
            value={failureNote}
            onChange={(e) => setFailureNote(e.target.value)}
            placeholder="e.g. printer offline, out of paper"
          />
        </div>
        {(jobs.data ?? []).length === 0 ? (
          <EmptyState title="Nothing in the queue" body="Queued receipts, tickets and test prints appear here." />
        ) : (
          <TableScroll><Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job</TableHead>
                <TableHead>Printer</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(jobs.data ?? []).map((j) => (
                <TableRow key={j.id}>
                  <TableCell>
                    <div className="font-medium">{j.title ?? humanise(j.document_type)}</div>
                    <div className="text-xs text-muted-foreground">{formatDateTime(j.created_at)}</div>
                  </TableCell>
                  <TableCell>
                    {byId[j.printer_id]?.name ?? "Unknown"}
                    {j.failed_over ? <div className="text-xs text-warning">Moved to backup printer</div> : null}
                  </TableCell>
                  <TableCell>
                    <TonePill tone={STATUS_TONE[j.status] ?? "neutral"}>{humanise(j.status)}</TonePill>
                    {j.last_error ? <div className="text-xs text-muted-foreground">{j.last_error}</div> : null}
                  </TableCell>
                  <TableCell>
                    {j.attempts} / {j.max_attempts}
                  </TableCell>
                  <TableCell className="space-x-2 text-right">
                    {j.status === "queued" || j.status === "printing" ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={recordResult.isPending}
                          onClick={() => recordResult.mutate({ job: j.id, success: true })}
                        >
                          It printed
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={recordResult.isPending}
                          onClick={() =>
                            recordResult.mutate({
                              job: j.id,
                              success: false,
                              error: failureNote.trim() || "Reported as not printed",
                            })
                          }
                        >
                          It failed
                        </Button>
                      </>
                    ) : j.status === "failed" ? (
                      <Button size="sm" variant="outline" disabled={retryJob.isPending} onClick={() => retryJob.mutate(j.id)}>
                        <RefreshCcw className="mr-2 h-3 w-3" /> Retry
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table></TableScroll>
        )}
      </SectionCard>
    </div>
  );
}
