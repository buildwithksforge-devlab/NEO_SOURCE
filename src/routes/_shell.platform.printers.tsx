import { ErrorState, LoadingState } from "@/components/common/StateSystem";
import { PageHeader } from "@/components/common/DataDisplay";
import { PrinterDiscoveryPanel } from "@/components/settings/PrinterDiscoveryPanel";
/**
 * Integration Centre — physical printer configuration and queue monitoring.
 */
import { useMemo, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Check, Copy, KeyRound, Printer as PrinterIcon, RefreshCcw } from "lucide-react";
import { SectionCard, TableScroll } from "@/components/common/DataDisplay";
import {
  AccessDenied,
  EmptyState,
  TonePill,
  TruthNotice,
  formatDateTime,
  humanise,
} from "@/components/platform/PlatformShared";
import { Button } from "@/components/ui/button";
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
import { useAuth } from "@/lib/auth";
import { useBranches } from "@/lib/branches";
import { useDepartmentsLite } from "@/lib/frontdesk-ops";
import {
  usePrinters,
  usePrintJobs,
  usePrinterStations,
  usePrintAgents,
  useQueuePrint,
  useRegisterPrintAgent,
  useRevokePrintAgent,
  useRetryPrintJob,
  useSavePrinter,
  type Printer,
} from "@/lib/printing";

export const Route = createFileRoute("/_shell/platform/printers")({
  head: () => ({
    meta: [
      {
        title: "Printers & Print Queue — Configuration Centre",
      },
      {
        name: "description",
        content:
          "Configure property printers, pair trusted print agents and monitor observed delivery outcomes.",
      },
    ],
  }),
  beforeLoad: () => {
    throw redirect({ to: "/admin/printers" });
  },
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

const PRINTER_ROLES = [
  {
    value: "receipt",
    label: "POS receipt",
  },
  {
    value: "kitchen",
    label: "Main Kitchen",
  },
  {
    value: "coffee",
    label: "Coffee Station",
  },
  {
    value: "bar",
    label: "Bar",
  },
  {
    value: "pastry",
    label: "Pastry",
  },
  {
    value: "production",
    label: "Other production station",
  },
] as const;

const CONNECTION_TYPES = [
  {
    value: "network",
    label: "Network TCP/IP",
  },
  {
    value: "windows",
    label: "Windows installed printer",
  },
] as const;

function tokenHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function createAgentToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `neopc_${tokenHex(bytes)}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

  return tokenHex(new Uint8Array(digest));
}

export function PrintersPage() {
  const { organizationId, can, isAdmin } = useAuth();

  const canManage = isAdmin || can("integrations", "edit") || can("pos", "settings", "manage");

  const printers = usePrinters(organizationId);
  const jobs = usePrintJobs(organizationId);
  const branches = useBranches();
  const departments = useDepartmentsLite();
  const stations = usePrinterStations(organizationId);
  const agents = usePrintAgents(organizationId);

  const savePrinter = useSavePrinter();
  const queuePrint = useQueuePrint();
  const retryJob = useRetryPrintJob();
  const registerAgent = useRegisterPrintAgent();
  const revokeAgent = useRevokePrintAgent();

  const [newName, setNewName] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [newDepartment, setNewDepartment] = useState("");
  const [newStation, setNewStation] = useState("");
  const [newRole, setNewRole] = useState("receipt");
  const [newConnection, setNewConnection] = useState("network");
  const [newAddress, setNewAddress] = useState("");

  const [agentName, setAgentName] = useState("");
  const [agentBranch, setAgentBranch] = useState("");
  const [oneTimeToken, setOneTimeToken] = useState("");
  const [copied, setCopied] = useState(false);

  const printerList = printers.data ?? [];
  const stationList = stations.data ?? [];
  const branchList = branches.data ?? [];

  const printerById = useMemo(() => {
    const result: Record<string, Printer> = {};

    for (const printer of printerList) {
      result[printer.id] = printer;
    }

    return result;
  }, [printerList]);

  const branchName = useMemo(() => {
    const result: Record<string, string> = {};

    for (const branch of branchList) {
      result[branch.id] = branch.name;
    }

    return result;
  }, [branchList]);

  const stationName = useMemo(() => {
    const result: Record<string, string> = {};

    for (const station of stationList) {
      result[station.id] = station.name;
    }

    return result;
  }, [stationList]);

  const stationsForNewPrinter = stationList.filter(
    (station) => !newBranch || station.branch_id === newBranch,
  );

  const requiresStation = newRole !== "receipt";

  const printerReady =
    newName.trim().length > 0 &&
    Boolean(newBranch) &&
    Boolean(newAddress.trim()) &&
    (!requiresStation || (Boolean(newDepartment) && Boolean(newStation)));

  if (!canManage) {
    return (
      <AccessDenied
        title="Printer setup is not enabled for your role"
        body="Printer configuration and agent pairing require integration or POS settings authority."
      />
    );
  }

  const setupQueries = [printers, jobs, branches, departments, stations, agents];
  const failedQuery = setupQueries.find((query) => query.isError);
  if (failedQuery)
    return (
      <ErrorState
        error={failedQuery.error}
        onRetry={() => {
          void Promise.all(setupQueries.map((query) => query.refetch()));
        }}
      />
    );
  if (setupQueries.some((query) => query.isLoading))
    return <LoadingState rows={3} />;

  const pairAgent = async () => {
    if (!agentName.trim() || !agentBranch) {
      return;
    }

    const rawToken = createAgentToken();
    const tokenHash = await sha256(rawToken);

    await registerAgent.mutateAsync({
      branch: agentBranch,
      name: agentName.trim(),
      tokenHash,
    });

    setOneTimeToken(rawToken);
    setAgentName("");
    setCopied(false);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Configuration Centre · Integrations"
        title="Printers & Print Queue"
        description="Discover printers through your local property computer, configure routing and review recorded delivery outcomes."
      />
      <PrinterDiscoveryPanel
        agents={agents.data ?? []}
        onChoose={(printer, branch) => {
          setNewName(printer.name);
          setNewBranch(branch);
          setNewStation("");
          setNewDepartment("");
          setNewConnection(printer.connection_type);
          setNewAddress(printer.address);
        }}
      />
      <TruthNotice>
        A queued job is not proof that paper came out. The property print agent records whether the
        operating system or network printer accepted the job. Final live UAT still requires a person
        to confirm the physical receipt or ticket.
      </TruthNotice>

      <SectionCard
        title="Add a physical printer"
        description="Assign the exact property, department, station, role and connection used by this printer."
      >
        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <Label>Name</Label>
            <Input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Main Kitchen printer"
            />
          </div>

          <div>
            <Label>Property</Label>
            <Select
              value={newBranch}
              onValueChange={(value) => {
                setNewBranch(value);
                setNewStation("");
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select property" />
              </SelectTrigger>
              <SelectContent>
                {branchList.map((branch) => (
                  <SelectItem key={branch.id} value={branch.id}>
                    {branch.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Department</Label>
            <Select value={newDepartment} onValueChange={setNewDepartment}>
              <SelectTrigger>
                <SelectValue placeholder="Select department" />
              </SelectTrigger>
              <SelectContent>
                {(departments.data ?? []).map((department: { id: string; name: string }) => (
                  <SelectItem key={department.id} value={department.id}>
                    {department.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Printer role</Label>
            <Select
              value={newRole}
              onValueChange={(value) => {
                setNewRole(value);

                if (value === "receipt") {
                  setNewStation("");
                }
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRINTER_ROLES.map((role) => (
                  <SelectItem key={role.value} value={role.value}>
                    {role.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Production station</Label>
            <Select
              value={newStation || "none"}
              disabled={newRole === "receipt" || !newBranch}
              onValueChange={(value) => setNewStation(value === "none" ? "" : value)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select station" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not applicable</SelectItem>

                {stationsForNewPrinter.map((station) => (
                  <SelectItem key={station.id} value={station.id}>
                    {station.name}
                    {station.code ? ` · ${station.code}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Connection</Label>
            <Select value={newConnection} onValueChange={setNewConnection}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONNECTION_TYPES.map((connection) => (
                  <SelectItem key={connection.value} value={connection.value}>
                    {connection.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="md:col-span-2">
            <Label>
              {newConnection === "network" ? "IP address and port" : "Windows printer name"}
            </Label>
            <Input
              value={newAddress}
              onChange={(event) => setNewAddress(event.target.value)}
              placeholder={
                newConnection === "network" ? "192.168.1.50:9100" : "EPSON TM-T20III Receipt"
              }
            />
          </div>
        </div>

        <div className="mt-3">
          <Button
            disabled={!printerReady || savePrinter.isPending}
            onClick={() =>
              savePrinter.mutate(
                {
                  organization_id: organizationId,
                  name: newName.trim(),
                  branch_id: newBranch,
                  department_id: newDepartment || null,
                  station_id: newStation || null,
                  printer_role: newRole,
                  connection_type: newConnection,
                  address: newAddress.trim(),
                  status: "not-configured",
                  health_status: "unknown",
                  active: true,
                },
                {
                  onSuccess: () => {
                    setNewName("");
                    setNewDepartment("");
                    setNewStation("");
                    setNewAddress("");
                  },
                },
              )
            }
          >
            <PrinterIcon className="mr-2 size-4" />
            Add physical printer
          </Button>
        </div>
      </SectionCard>

      <SectionCard
        title="Pair this property computer"
        description="Generate a one-time secret for the Windows computer that can reach these printers. The raw secret is never stored in NEØ."
      >
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <Label>Computer name</Label>
            <Input
              value={agentName}
              onChange={(event) => setAgentName(event.target.value)}
              placeholder="Savanna Crown POS Server"
            />
          </div>

          <div>
            <Label>Property</Label>
            <Select value={agentBranch} onValueChange={setAgentBranch}>
              <SelectTrigger>
                <SelectValue placeholder="Select property" />
              </SelectTrigger>
              <SelectContent>
                {branchList.map((branch) => (
                  <SelectItem key={branch.id} value={branch.id}>
                    {branch.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-end">
            <Button
              disabled={!agentName.trim() || !agentBranch || registerAgent.isPending}
              onClick={() => void pairAgent()}
            >
              <KeyRound className="mr-2 size-4" />
              Generate agent secret
            </Button>
          </div>
        </div>

        {oneTimeToken ? (
          <div className="mt-4 space-y-2 rounded-md border border-warning/40 bg-warning/5 p-4">
            <p className="font-medium">Copy this secret now</p>
            <p className="text-sm text-muted-foreground">
              It is shown once. Put it in neo-print-agent.json on the paired property computer.
            </p>

            <Button
              type="button"
              variant="outline"
              onClick={() => {
                const config = {
                  apiBase: `${window.location.origin}/api/public/print-agent`,
                  token: oneTimeToken,
                  pollMilliseconds: 2500,
                  refreshPrintersMilliseconds: 60000,
                  printerIds: [],
                };
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(config, null, 2)], { type: "application/json" }),
                );
                const link = document.createElement("a");
                link.href = url;
                link.download = "neo-print-agent.json";
                link.click();
                URL.revokeObjectURL(url);
              }}
            >
              Download agent configuration
            </Button>
            <div className="flex gap-2">
              <Input readOnly value={oneTimeToken} className="font-mono text-xs" />

              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(oneTimeToken);

                  setCopied(true);

                  window.setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="mt-4 space-y-2">
          {(agents.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No property computer is paired yet.</p>
          ) : (
            (agents.data ?? []).map((agent) => (
              <div
                key={agent.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              >
                <div>
                  <p className="font-medium">{agent.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {agent.branch_id
                      ? (branchName[agent.branch_id] ?? "Unknown property")
                      : "All properties"}
                    {" · "}
                    {agent.last_seen_at
                      ? `Last seen ${formatDateTime(agent.last_seen_at)}`
                      : "Never connected"}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <TonePill tone={agent.active ? "success" : "neutral"}>
                    {agent.active ? "Active" : "Revoked"}
                  </TonePill>

                  {agent.active ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={revokeAgent.isPending}
                      onClick={() => revokeAgent.mutate(agent.id)}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="Configured printers"
        description="Printer role and station determine which POS tickets may reach each device."
      >
        {printerList.length === 0 ? (
          <EmptyState
            title="No printers declared yet"
            body="Add the first physical printer above."
          />
        ) : (
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Printer</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Station</TableHead>
                  <TableHead>Connection</TableHead>
                  <TableHead>Retries</TableHead>
                  <TableHead>Backup</TableHead>
                  <TableHead>Health</TableHead>
                  <TableHead className="text-right">Test</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {printerList.map((printer) => {
                  const compatibleBackups = printerList.filter(
                    (candidate) =>
                      candidate.id !== printer.id &&
                      candidate.active &&
                      candidate.branch_id === printer.branch_id &&
                      candidate.department_id === printer.department_id &&
                      candidate.station_id === printer.station_id &&
                      candidate.printer_role === printer.printer_role,
                  );

                  const printerStations = stationList.filter(
                    (station) => station.branch_id === printer.branch_id,
                  );

                  return (
                    <TableRow key={printer.id}>
                      <TableCell>
                        <div className="font-medium">{printer.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {printer.branch_id
                            ? (branchName[printer.branch_id] ?? "Unknown property")
                            : "No property"}
                        </div>
                        <Input
                          className="mt-2 min-w-52"
                          defaultValue={printer.address ?? ""}
                          onBlur={(event) => {
                            const value = event.target.value.trim();

                            if (value && value !== printer.address) {
                              savePrinter.mutate({
                                id: printer.id,
                                address: value,
                              });
                            }
                          }}
                        />
                      </TableCell>

                      <TableCell>
                        <Select
                          value={printer.printer_role ?? "receipt"}
                          onValueChange={(value) =>
                            savePrinter.mutate({
                              id: printer.id,
                              printer_role: value,
                              station_id: value === "receipt" ? null : printer.station_id,
                            })
                          }
                        >
                          <SelectTrigger className="w-40">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {PRINTER_ROLES.map((role) => (
                              <SelectItem key={role.value} value={role.value}>
                                {role.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>

                      <TableCell>
                        <Select
                          value={printer.station_id ?? "none"}
                          disabled={printer.printer_role === "receipt"}
                          onValueChange={(value) =>
                            savePrinter.mutate({
                              id: printer.id,
                              station_id: value === "none" ? null : value,
                            })
                          }
                        >
                          <SelectTrigger className="w-44">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">Not assigned</SelectItem>
                            {printerStations.map((station) => (
                              <SelectItem key={station.id} value={station.id}>
                                {station.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>

                      <TableCell>
                        <Select
                          value={printer.connection_type ?? "network"}
                          onValueChange={(value) =>
                            savePrinter.mutate({
                              id: printer.id,
                              connection_type: value,
                            })
                          }
                        >
                          <SelectTrigger className="w-44">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {printer.connection_type &&
                            !CONNECTION_TYPES.some(
                              (item) => item.value === printer.connection_type,
                            ) ? (
                              <SelectItem value={printer.connection_type} disabled>
                                Review legacy connection: {printer.connection_type}
                              </SelectItem>
                            ) : null}
                            {CONNECTION_TYPES.map((connection) => (
                              <SelectItem key={connection.value} value={connection.value}>
                                {connection.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>

                      <TableCell>
                        <Input
                          type="number"
                          min={1}
                          className="w-20"
                          defaultValue={printer.retry_limit}
                          onBlur={(event) => {
                            const value = Number(event.target.value);

                            if (
                              Number.isFinite(value) &&
                              value >= 1 &&
                              value !== printer.retry_limit
                            ) {
                              savePrinter.mutate({
                                id: printer.id,
                                retry_limit: Math.round(value),
                              });
                            }
                          }}
                        />
                      </TableCell>

                      <TableCell>
                        <Select
                          value={printer.fallback_printer_id ?? "none"}
                          onValueChange={(value) =>
                            savePrinter.mutate({
                              id: printer.id,
                              fallback_printer_id: value === "none" ? null : value,
                            })
                          }
                        >
                          <SelectTrigger className="w-44">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">No backup</SelectItem>

                            {compatibleBackups.map((candidate) => (
                              <SelectItem key={candidate.id} value={candidate.id}>
                                {candidate.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>

                      <TableCell>
                        <TonePill tone={HEALTH_TONE[printer.health_status] ?? "neutral"}>
                          {humanise(printer.health_status)}
                        </TonePill>

                        <div className="mt-1 text-xs text-muted-foreground">
                          {printer.last_success_at
                            ? `Last accepted ${formatDateTime(printer.last_success_at)}`
                            : printer.last_failure_at
                              ? `Last failed ${formatDateTime(printer.last_failure_at)}`
                              : "No result yet"}
                        </div>
                      </TableCell>

                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            queuePrint.isPending ||
                            !printer.address ||
                            !CONNECTION_TYPES.some((item) => item.value === printer.connection_type)
                          }
                          onClick={() =>
                            queuePrint.mutate({
                              printer: printer.id,
                              documentType: "test",
                              title: `Test print — ${printer.name}`,
                              payload: {
                                lines: [
                                  "NEO TEST PRINT",
                                  printer.name,
                                  branchName[printer.branch_id ?? ""] ?? "",
                                  stationName[printer.station_id ?? ""] ?? "",
                                  new Date().toISOString(),
                                ],
                              },
                            })
                          }
                        >
                          Queue test
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableScroll>
        )}
      </SectionCard>

      <SectionCard
        title="Print queue"
        description="Agent-reported status, retries and same-station failover."
      >
        {(jobs.data ?? []).length === 0 ? (
          <EmptyState
            title="Nothing in the queue"
            body="Queued receipts, production tickets and test prints appear here."
          />
        ) : (
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Printer</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {(jobs.data ?? []).map((job) => (
                  <TableRow key={job.id}>
                    <TableCell>
                      <div className="font-medium">{job.title ?? humanise(job.document_type)}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatDateTime(job.created_at)}
                      </div>
                    </TableCell>

                    <TableCell>
                      {printerById[job.printer_id]?.name ?? "Unknown"}

                      {job.failed_over ? (
                        <div className="text-xs text-warning">Moved to compatible backup</div>
                      ) : null}
                    </TableCell>

                    <TableCell>
                      <TonePill tone={STATUS_TONE[job.status] ?? "neutral"}>
                        {humanise(job.status)}
                      </TonePill>

                      {job.last_error ? (
                        <div className="max-w-80 text-xs text-muted-foreground">
                          {job.last_error}
                        </div>
                      ) : null}
                    </TableCell>

                    <TableCell>
                      {job.attempts} / {job.max_attempts}
                    </TableCell>

                    <TableCell className="text-right">
                      {job.status === "failed" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={retryJob.isPending}
                          onClick={() => retryJob.mutate(job.id)}
                        >
                          <RefreshCcw className="mr-2 size-3" />
                          Review and retry
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">Agent managed</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        )}
      </SectionCard>
    </div>
  );
}
