import { guardedRpc } from "@/lib/rpc-guard";
import { useMemo, useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Download, ScrollText } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
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
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { moduleLabels } from "@/lib/permissions";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { EmptyState, NotAuthorisedState, QueryState } from "@/components/common/StateSystem";

export const Route = createFileRoute("/_shell/audit-logs")({
  head: () => ({
    meta: [
      { title: "Audit trail — NEØ" },
      {
        name: "description",
        content: "Immutable activity log of every sensitive action taken in your properties.",
      },
      { property: "og:title", content: "Audit trail — NEØ" },
      {
        property: "og:description",
        content: "Immutable activity log of every sensitive action taken in your properties.",
      },
    ],
  }),
  component: GuardedPage,
});

type AuditLog = {
  id: string;
  user_name: string;
  action: string;
  module: string;
  record_id: string | null;
  previous_value: unknown;
  new_value: unknown;
  reason: string | null;
  device: string | null;
  created_at: string;
};

/**
 * Every entry is classified by what actually happened to the record, so the
 * trail can answer "who created, changed or removed this?" directly rather
 * than making the reader interpret raw action names.
 */
function changeKind(action: string): "created" | "edited" | "deleted" | "other" {
  const a = action.toLowerCase();
  if (/(created|added|inserted|opened|raised|issued)/.test(a)) return "created";
  if (/(deleted|removed|purged|voided|cancelled|retired|deactivated)/.test(a)) return "deleted";
  if (/(updated|edited|changed|renamed|reactivated|approved|rejected|assigned|posted|settled)/.test(a))
    return "edited";
  return "other";
}

/** The field names that differ between the before and after snapshots. */
function changedFields(previous: unknown, next: unknown): string[] {
  const before = (previous ?? {}) as Record<string, unknown>;
  const after = (next ?? {}) as Record<string, unknown>;
  if (typeof before !== "object" || typeof after !== "object") return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const noise = new Set(["updated_at", "created_at", "id", "organization_id"]);
  return Array.from(keys).filter(
    (k) => !noise.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
}

function AuditLogsPage() {
  const { organizationId, isAdmin, can } = useAuth();
  const [search, setSearch] = useState("");
  const [module, setModule] = useState("all");
  const [change, setChange] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // Owners and system administrators are equal superusers, so the trail opens
  // for them without needing the granular capability to be compiled first.
  const mayRead = isAdmin || can("administration", "audit-logs", "view");


  // Read through the organization-scoped reader so the figures here match the
  // activity counts shown on the administration dashboard, and every entry
  // names the person who performed the action.
  const logs = useQuery({
    queryKey: ["audit-trail", organizationId],
    enabled: Boolean(organizationId) && mayRead,
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "audit_trail", {
        _from: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
        _to: new Date().toISOString(),
        _limit: 1000,
      });
      if (error) throw error;
      const rows = (data ?? []) as unknown as (Omit<AuditLog, "user_name"> & {
        actor_name: string | null;
      })[];
      return rows.map((l) => ({ ...l, user_name: l.actor_name ?? "System" })) as AuditLog[];
    },
  });

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return (logs.data ?? []).filter((l) => {
      if (module !== "all" && l.module !== module) return false;
      if (change !== "all" && changeKind(l.action) !== change) return false;
      if (from && new Date(l.created_at) < new Date(from)) return false;
      if (to && new Date(l.created_at) > new Date(`${to}T23:59:59`)) return false;
      if (!q) return true;
      return (
        l.action.toLowerCase().includes(q) ||
        l.user_name.toLowerCase().includes(q) ||
        (l.record_id ?? "").toLowerCase().includes(q) ||
        (l.reason ?? "").toLowerCase().includes(q)
      );
    });
  }, [logs.data, search, module, change, from, to]);

  const modules = Array.from(new Set((logs.data ?? []).map((l) => l.module)));

  function exportCsv() {
    const rows = [
      ["Timestamp", "User", "Change", "Action", "Module", "Record", "Fields changed", "Reason"],
      ...filtered.map((l) => [
        new Date(l.created_at).toISOString(),
        l.user_name,
        changeKind(l.action),
        l.action,
        l.module,
        l.record_id ?? "",
        changedFields(l.previous_value, l.new_value).join(" | "),
        l.reason ?? "",
      ]),
    ];
    const csv = rows
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-trail-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!mayRead) {
    return (
      <div>
        <PageHeader
          eyebrow="Security"
          title="Audit trail"
          description="Administrator access required."
        />
        <SectionCard
          title="Restricted"
          description="Only owners and administrators can read the audit trail."
        >
          <NotAuthorisedState subject="the audit trail" inline />
        </SectionCard>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Security"
        title="Audit trail"
        description="Append-only record of logins, permission changes, approvals, voids, refunds and configuration changes."
        actions={
          <Button variant="outline" onClick={exportCsv}>
            <Download className="size-4" /> Export CSV
          </Button>
        }
      />

      <SectionCard
        title="Filters"
        description="Nothing is ever deleted — records can only be added."
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <div className="space-y-2">
            <Label htmlFor="q">Search</Label>
            <Input
              id="q"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="User, action, record, reason"
            />
          </div>
          <div className="space-y-2">
            <Label>Module</Label>
            <Select value={module} onValueChange={setModule}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All modules</SelectItem>
                {modules.map((m) => (
                  <SelectItem key={m} value={m}>
                    {moduleLabels[m] ?? m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Change</Label>
            <Select value={change} onValueChange={setChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All changes</SelectItem>
                <SelectItem value="created">Created</SelectItem>
                <SelectItem value="edited">Edited</SelectItem>
                <SelectItem value="deleted">Deleted / voided</SelectItem>
                <SelectItem value="other">Other activity</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="from">From</Label>
            <NeoDatePicker id="from" value={from} onChange={setFrom} quick={["today", "this-week", "next-7", "this-month"]} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="to">To</Label>
            <NeoDatePicker id="to" value={to} onChange={setTo} quick={["today", "this-week", "next-7", "this-month"]} />
          </div>
        </div>
      </SectionCard>

      <div className="mt-6">
        <SectionCard
          title="Activity"
          description={
            logs.isPending
              ? "Reading the append-only trail…"
              : logs.error
                ? "The audit trail could not be read."
                : `${filtered.length} record(s)`
          }
        >
          {/* The trail never reports "no activity" while the read is in flight
              or has failed — an empty list is only ever a settled fact. */}
          <QueryState
            isLoading={logs.isPending}
            error={logs.error}
            query={logs}
            isEmpty={filtered.length === 0}
            onRetry={() => void logs.refetch()}
            skeleton="table"
            empty={
              <EmptyState
                icon={ScrollText}
                title="No activity recorded"
                description="No audit activity matches the filters currently applied."
              />
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1080px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2">When</th>
                    <th className="py-2">User</th>
                    <th className="py-2">Change</th>
                    <th className="py-2">Action</th>
                    <th className="py-2">Module</th>
                    <th className="py-2">Record</th>
                    <th className="py-2">What changed</th>
                    <th className="py-2">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((l) => (
                    <tr key={l.id} className="border-b border-border/60">
                      <td className="py-2 whitespace-nowrap text-muted-foreground">
                        {new Date(l.created_at).toLocaleString()}
                      </td>
                      <td className="py-2">{l.user_name || "System"}</td>
                      <td className="py-2">
                        <StatusPill
                          tone={
                            changeKind(l.action) === "deleted"
                              ? "destructive"
                              : changeKind(l.action) === "created"
                                ? "success"
                                : "default"
                          }
                        >
                          {changeKind(l.action) === "deleted"
                            ? "Deleted"
                            : changeKind(l.action) === "created"
                              ? "Created"
                              : changeKind(l.action) === "edited"
                                ? "Edited"
                                : "Activity"}
                        </StatusPill>
                      </td>
                      <td className="py-2 font-medium">{l.action}</td>
                      <td className="py-2">
                        <StatusPill>{moduleLabels[l.module] ?? l.module}</StatusPill>
                      </td>
                      <td className="py-2 font-mono text-xs text-muted-foreground">
                        {l.record_id ?? "—"}
                      </td>
                      <td className="py-2 text-muted-foreground">
                        {changedFields(l.previous_value, l.new_value).slice(0, 4).join(", ") || "—"}
                      </td>
                      <td className="py-2 text-muted-foreground">{l.reason || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </QueryState>
        </SectionCard>
      </div>

    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/audit-logs">
      <AuditLogsPage />
    </OpsGuard>
  );
}
