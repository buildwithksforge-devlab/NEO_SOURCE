import { createFileRoute } from "@tanstack/react-router";
import { SectionCard, StatCard, TableScroll } from "@/components/common/DataDisplay";
import {
  AccessDenied,
  EmptyState,
  TonePill,
  TruthNotice,
  formatDateTime,
  humanise,
  statusTone,
} from "@/components/platform/PlatformShared";
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
  useBackupRecords,
  useMonitoringChecks,
  useReleases,
  useServiceIncidents,
} from "@/lib/platform-data";

export const Route = createFileRoute("/_shell/platform/operations")({
  component: OperationsScreen,
});

function OperationsScreen() {
  const { can, isAdmin } = useAuth();
  const releases = useReleases();
  const monitoring = useMonitoringChecks();
  const backups = useBackupRecords();
  const incidents = useServiceIncidents();

  if (!isAdmin && !can("platform", "view")) {
    return (
      <AccessDenied
        title="Release and monitoring records are restricted"
        body="Deployment, backup and monitoring evidence is limited to platform-level administrators."
      />
    );
  }

  const openIncidents = (incidents.data ?? []).filter((i) => i["status"] !== "resolved");
  const configuredChecks = (monitoring.data ?? []).filter((m) => m["status"] !== "not_configured");
  const verifiedBackups = (backups.data ?? []).filter((b) => b["verified"]);

  return (
    <div className="space-y-6">
      <TruthNotice>
        Monitoring checks show “Not configured” until an alerting target is actually connected.
        Backups are only listed as verified once a restore has been tested and recorded.
      </TruthNotice>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Releases recorded" value={String((releases.data ?? []).length)} />
        <StatCard
          label="Monitoring checks live"
          value={`${configuredChecks.length} / ${(monitoring.data ?? []).length}`}
        />
        <StatCard label="Verified backups" value={String(verifiedBackups.length)} />
        <StatCard label="Open incidents" value={String(openIncidents.length)} />
      </div>

      <SectionCard
        title="Monitoring & alerting"
        description="Availability, integration and error checks for the production service."
      >
        <TableScroll>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Check</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last checked</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(monitoring.data ?? []).map((m) => (
                <TableRow key={String(m["id"])}>
                  <TableCell>
                    <p className="font-medium text-foreground">{String(m["name"])}</p>
                    <p className="text-xs text-muted-foreground">{String(m["target"] ?? "")}</p>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {humanise(String(m["category"]))}
                  </TableCell>
                  <TableCell>
                    <TonePill tone={statusTone(String(m["status"]))}>
                      {humanise(String(m["status"]))}
                    </TonePill>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(m["last_checked_at"] as string)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableScroll>
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="Releases"
          description="Version history with migrations, known issues and rollback notes."
        >
          {(releases.data ?? []).length === 0 ? (
            <EmptyState
              title="No releases recorded"
              body="Release notes appear here once a version is prepared for deployment."
            />
          ) : (
            <ul className="space-y-2 text-sm">
              {(releases.data ?? []).map((r) => (
                <li key={String(r["id"])} className="rounded-lg border border-border px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-foreground">
                      {String(r["version"])} {r["name"] ? `— ${String(r["name"])}` : ""}
                    </span>
                    <TonePill tone={statusTone(String(r["status"]))}>
                      {humanise(String(r["status"]))}
                    </TonePill>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatDateTime(r["released_at"] as string)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title="Backups & restore tests"
          description="A backup counts only when its restore has been proven."
        >
          {(backups.data ?? []).length === 0 ? (
            <EmptyState
              title="No backup records"
              body="Recorded backups and restore tests will be listed here."
            />
          ) : (
            <ul className="space-y-2 text-sm">
              {(backups.data ?? []).map((b) => (
                <li
                  key={String(b["id"])}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                >
                  <span className="text-foreground">
                    {humanise(String(b["backup_type"]))} · {formatDateTime(b["taken_at"] as string)}
                  </span>
                  <TonePill tone={b["verified"] ? "success" : "warning"}>
                    {b["verified"] ? "Restore tested" : "Not verified"}
                  </TonePill>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Service incidents"
        description="Customer-facing incident record with impact and root cause."
      >
        {(incidents.data ?? []).length === 0 ? (
          <EmptyState
            title="No incidents recorded"
            body="Incidents and their customer communications are logged here."
          />
        ) : (
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Started</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(incidents.data ?? []).map((i) => (
                  <TableRow key={String(i["id"])}>
                    <TableCell className="font-mono text-xs">{String(i["reference"])}</TableCell>
                    <TableCell>{String(i["title"])}</TableCell>
                    <TableCell>
                      <TonePill tone={statusTone(String(i["severity"]))}>
                        {humanise(String(i["severity"]))}
                      </TonePill>
                    </TableCell>
                    <TableCell>
                      <TonePill tone={statusTone(String(i["status"]))}>
                        {humanise(String(i["status"]))}
                      </TonePill>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(i["started_at"] as string)}
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
