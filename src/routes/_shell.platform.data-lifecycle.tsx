/**
 * Platform — History growth & tenant migration.
 *
 * Two related problems live here. First, history tables (ledger, stock, stays,
 * sales) grow forever unless a retention period is set; this screen reports
 * their real size and only archives once the hotel has chosen a period.
 * Second, a property that should become its own hotel group is planned and
 * then moved, with the plan, the counts and any orphaned rows recorded.
 */
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Database, MoveRight } from "lucide-react";
import { SectionCard, TableScroll } from "@/components/common/DataDisplay";
import { AccessDenied, EmptyState, TonePill, TruthNotice, formatDateTime, humanise } from "@/components/platform/PlatformShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth";
import { useBranches } from "@/lib/branches";
import {
  useArchiveHistory,
  useExecuteTenantMigration,
  usePartitionMaintenance,
  usePlanTenantMigration,
  useRetentionOverview,
  useTenantMigrationRuns,
} from "@/lib/data-lifecycle";

export const Route = createFileRoute("/_shell/platform/data-lifecycle")({
  head: () => ({
    meta: [
      { title: "History Growth & Tenant Migration — Platform" },
      {
        name: "description",
        content:
          "Retention periods, monthly history sections and archiving for finance, stock and stay history, plus moving a property into its own hotel group.",
      },
      { property: "og:title", content: "History Growth & Tenant Migration — Platform" },
      {
        property: "og:description",
        content: "Real table sizes, retention decisions the hotel owns, and a planned, recorded property move.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: DataLifecyclePage,
});

function mb(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function DataLifecyclePage() {
  const { organizationId, isAdmin } = useAuth();
  const retention = useRetentionOverview(organizationId);
  const runs = useTenantMigrationRuns(organizationId);
  const branches = useBranches();

  const maintain = usePartitionMaintenance();
  const archive = useArchiveHistory();
  const plan = usePlanTenantMigration();
  const migrate = useExecuteTenantMigration();

  const [branch, setBranch] = useState("");
  const [newOrgName, setNewOrgName] = useState("");
  const [reason, setReason] = useState("");

  return (
    <div className="space-y-6">
      <TruthNotice>
        No history is deleted or archived automatically. A table is only archived once a retention period has been set
        for it and archiving switched on — until then this screen reports, and nothing moves.
      </TruthNotice>

      <SectionCard
        title="History growth"
        description="Live size of the finance, stock, stay and sales history tables, and whether they are already split by month."
      >
        <div className="mb-3">
          <Button size="sm" variant="outline" disabled={maintain.isPending} onClick={() => maintain.mutate(3)}>
            <Database className="mr-2 h-4 w-4" /> Prepare the next 3 monthly sections
          </Button>
        </div>
        {(retention.data ?? []).length === 0 ? (
          <EmptyState title="No retention policies registered" body="Nothing to report yet." />
        ) : (
          <TableScroll><Table>
            <TableHeader>
              <TableRow>
                <TableHead>Table</TableHead>
                <TableHead>Area</TableHead>
                <TableHead className="text-right">Rows</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead>Split by month</TableHead>
                <TableHead>Retention</TableHead>
                <TableHead className="text-right">Archive</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(retention.data ?? []).map((row) => (
                <TableRow key={row.table_name}>
                  <TableCell>
                    <div className="font-medium">{humanise(row.table_name)}</div>
                    {row.blockers ? <div className="text-xs text-muted-foreground">{row.blockers}</div> : null}
                  </TableCell>
                  <TableCell>{humanise(row.domain)}</TableCell>
                  <TableCell className="text-right">{Number(row.live_rows).toLocaleString()}</TableCell>
                  <TableCell className="text-right">{mb(Number(row.total_bytes))}</TableCell>
                  <TableCell>
                    <TonePill tone={row.partitioned ? "success" : row.needs_partitioning ? "warning" : "neutral"}>
                      {row.partitioned ? "Split by month" : row.needs_partitioning ? "Should be split" : "Not needed yet"}
                    </TonePill>
                  </TableCell>
                  <TableCell>
                    {row.retention_months
                      ? `${row.retention_months} months · ${Number(row.rows_past_retention).toLocaleString()} past it`
                      : "Not set"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!row.retention_months || archive.isPending}
                      onClick={() => archive.mutate({ table: row.table_name, confirm: false })}
                    >
                      Preview
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table></TableScroll>
        )}
      </SectionCard>

      <SectionCard
        title="Move a property into its own hotel group"
        description="Plan first. The plan shows every table and row count that would move, plus anything orphaned."
      >
        {!isAdmin ? (
          <AccessDenied
            title="Moving a property needs workspace administrator rights"
            body="Ask an owner or system administrator to perform the move."
          />
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <Label>Property</Label>
                <Select value={branch} onValueChange={setBranch}>
                  <SelectTrigger><SelectValue placeholder="Select property" /></SelectTrigger>
                  <SelectContent>
                    {(branches.data ?? []).map((b) => (
                      <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>New hotel group name</Label>
                <Input value={newOrgName} onChange={(e) => setNewOrgName(e.target.value)} placeholder="Legal entity name" />
              </div>
              <div>
                <Label>Reason (recorded)</Label>
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this property is separating" />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="outline" disabled={!branch || plan.isPending} onClick={() => plan.mutate(branch)}>
                Plan the move
              </Button>
              <Button
                disabled={!branch || !newOrgName.trim() || reason.trim().length < 5 || !plan.data || migrate.isPending}
                onClick={() =>
                  migrate.mutate(
                    { branch, reason: reason.trim(), newOrganizationName: newOrgName.trim() },
                    { onSuccess: () => { setReason(""); setNewOrgName(""); } },
                  )
                }
              >
                <MoveRight className="mr-2 h-4 w-4" /> Move the property
              </Button>
            </div>

            {plan.data ? (
              <div className="mt-4 space-y-2 text-sm">
                <p className="font-medium">
                  {Number(plan.data["total_rows"] ?? 0).toLocaleString()} record(s) across{" "}
                  {Array.isArray(plan.data["tables"]) ? plan.data["tables"].length : 0} table(s) would move.{" "}
                  {Number(plan.data["active_members"] ?? 0)} active member(s) stay with the current workspace and must be
                  invited to the new one.
                </p>
                {Array.isArray(plan.data["orphans"]) && plan.data["orphans"].length > 0 ? (
                  <div className="rounded-md border border-warning/40 bg-warning/10 p-3">
                    <p className="font-medium text-warning">Orphaned rows found — resolve before moving</p>
                    <ul className="list-disc pl-5 text-xs">
                      {(plan.data["orphans"] as { table: string; rows: number; issue: string }[]).map((o) => (
                        <li key={o.table}>
                          {humanise(o.table)}: {o.rows} row(s) — {o.issue}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No orphaned rows found for this property.</p>
                )}
              </div>
            ) : null}
          </>
        )}
      </SectionCard>

      <SectionCard title="Migration history" description="Every plan and every move, with who did it and why.">
        {(runs.data ?? []).length === 0 ? (
          <EmptyState title="No migrations recorded" body="Plans and moves appear here." />
        ) : (
          <TableScroll><Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(runs.data ?? []).map((r) => (
                <TableRow key={r["id"]}>
                  <TableCell>{formatDateTime(r["created_at"])}</TableCell>
                  <TableCell>{humanise(String(r["mode"]))}</TableCell>
                  <TableCell>
                    <TonePill tone={r["status"] === "completed" ? "success" : "danger"}>
                      {humanise(String(r["status"]))}
                    </TonePill>
                  </TableCell>
                  <TableCell className="max-w-md truncate">{r["reason"] ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table></TableScroll>
        )}
      </SectionCard>
    </div>
  );
}
