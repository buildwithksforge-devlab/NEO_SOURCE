import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Download } from "lucide-react";
import { SectionCard } from "@/components/common/DataDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  detectRpcSpikes,
  onRpcMetric,
  rpcMetricsCsv,
  rpcMetricsWithin,
  summariseRpcMetrics,
  criticalRpcAlerts,
  type RpcCallMetric,
} from "@/lib/rpc-telemetry";
import { runRpcPrivilegeCheck, type RpcPrivilegeDivergence } from "@/lib/rpc-health";

const RANGES: { value: string; label: string; ms: number }[] = [
  { value: "15m", label: "Last 15 minutes", ms: 15 * 60_000 },
  { value: "1h", label: "Last hour", ms: 60 * 60_000 },
  { value: "session", label: "Whole session", ms: 0 },
];

/**
 * Database routine call health for this browser session.
 *
 * The executing role is recorded on every call, so a routine failing because it
 * was reached anonymously is distinguishable from a routine failing because the
 * grant is genuinely missing — the distinction that made "permission denied for
 * function" hard to act on. Clustered authorisation failures raise an alert
 * here rather than waiting to be noticed in the logs.
 */
export function RpcHealthPanel() {
  const [range, setRange] = useState("1h");
  const [tick, setTick] = useState(0);
  const [privileges, setPrivileges] = useState<RpcPrivilegeDivergence[] | null>(null);

  useEffect(() => {
    void runRpcPrivilegeCheck().then(setPrivileges);
  }, []);

  useEffect(() => {
    const refresh = () => setTick((t) => t + 1);
    const stop = onRpcMetric(refresh);
    const timer = setInterval(refresh, 5_000);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, []);

  const windowMs = RANGES.find((r) => r.value === range)?.ms ?? 0;
  const metrics = useMemo<RpcCallMetric[]>(
    () => rpcMetricsWithin(windowMs),
    // `tick` is the refresh signal from the telemetry listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [windowMs, tick],
  );
  const rows = useMemo(() => summariseRpcMetrics(metrics), [metrics]);
  const critical = useMemo(() => criticalRpcAlerts(metrics), [metrics]);
  const alerts = useMemo(
    () => detectRpcSpikes(metrics, { windowMs: windowMs || 60 * 60_000 }),
    [metrics, windowMs],
  );

  const download = () => {
    const blob = new Blob([rpcMetricsCsv(metrics)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `routine-calls-${range}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <SectionCard
      title="Database routine calls"
      description="Every routine call made in this session, with the role it executed as. Anonymous calls to an authenticated routine are refused before dispatch and shown here as 'auth required'."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Select value={range} onValueChange={setRange}>
            <SelectTrigger className="h-9 w-[170px]" aria-label="Time range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGES.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={download} disabled={metrics.length === 0}>
            <Download className="size-4" /> Export CSV
          </Button>
        </div>
      }
    >
      {critical.length > 0 ? (
        <div
          role="alert"
          className="mb-4 space-y-1 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm"
        >
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangle className="size-4" /> Payment or delivery routine refused
          </p>
          {critical.slice(0, 5).map((a) => (
            <p key={`${a.rpc}:${a.at}`} className="text-muted-foreground">
              {new Date(a.at).toLocaleTimeString()} · {a.message}
            </p>
          ))}
        </div>
      ) : null}

      {privileges && privileges.length > 0 ? (
        <div
          role="alert"
          className="mb-4 space-y-1 rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm"
        >
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangle className="size-4" /> Execute privileges diverge from the expected surface
          </p>
          {privileges.map((d) => (
            <p key={`${d.routine}:${d.reason}`} className="text-muted-foreground">
              {d.detail}
            </p>
          ))}
        </div>
      ) : null}

      {alerts.length > 0 ? (
        <div
          role="alert"
          className="mb-4 space-y-1 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"
        >
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangle className="size-4" /> Authorisation failures are spiking
          </p>
          {alerts.map((a) => (
            <p key={`${a.rpc}:${a.role}`} className="text-muted-foreground">
              {a.message}
            </p>
          ))}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No routine calls recorded in this range yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Routine</TableHead>
              <TableHead>Executing role</TableHead>
              <TableHead className="text-right">Calls</TableHead>
              <TableHead className="text-right">Failures</TableHead>
              <TableHead>Last outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={`${r.rpc}:${r.role}`}>
                <TableCell className="font-mono text-xs">{r.rpc}</TableCell>
                <TableCell>
                  <Badge variant={r.role === "authenticated" ? "secondary" : "destructive"}>{r.role}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.calls}</TableCell>
                <TableCell className="text-right tabular-nums">{r.failures}</TableCell>
                <TableCell>
                  <Badge variant={r.lastOutcome === "ok" ? "outline" : "destructive"}>{r.lastOutcome}</Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
  );
}
