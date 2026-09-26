/**
 * Approval routing policy — who picks up each workflow.
 *
 * Every workflow here is a real approval type in this workspace. The reserved
 * role is the only role allowed to decide a restricted action; the fallback
 * role picks the request up when the configured approver is unstaffed or is the
 * very person who raised it. Nothing on this screen may route a record back to
 * its own author.
 */
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldCheck, Route as RouteIcon, Trash2 } from "lucide-react";
import {
  PageHeader,
  SectionCard,
  StatCard,
  StatusPill,
  TableScroll,
} from "@/components/common/DataDisplay";
import { LoadingState } from "@/components/common/StateSystem";
import { PagedRows } from "@/components/common/TablePager";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
import { useOrgRoles } from "@/lib/workspace-preview-data";
import { useApprovalRules, useApprovalTypes } from "@/lib/finance-controls";
import {
  useApprovalRoutingPolicies,
  useClearApprovalRoutingPolicy,
  useSaveApprovalRoutingPolicy,
  type ApprovalRoutingPolicy,
} from "@/lib/approval-routing";

export const Route = createFileRoute("/admin/approval-routing")({
  head: () => ({
    meta: [
      { title: "Approval Routing Policy — NEØ Administration" },
      {
        name: "description",
        content:
          "Configure, workflow by workflow, which role reserves the decision and which role picks a request up when the configured approver is unavailable or raised it themselves.",
      },
      { property: "og:title", content: "Approval Routing Policy — NEØ Administration" },
      {
        property: "og:description",
        content:
          "Per-workflow reserved and fallback approvers driving My Work assignments — configuration, not hard-coded roles.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ApprovalRoutingPage,
});

const NONE = "none";

type Draft = {
  reserved: string;
  fallback: string;
  fallbackEnabled: boolean;
  notes: string;
};

function draftOf(p: ApprovalRoutingPolicy | undefined): Draft {
  return {
    reserved: p?.reserved_role_id ?? NONE,
    fallback: p?.fallback_role_id ?? NONE,
    fallbackEnabled: p?.fallback_enabled ?? true,
    notes: p?.notes ?? "",
  };
}

function ApprovalRoutingPage() {
  const { can, isAdmin } = useAuth();
  const types = useApprovalTypes();
  const rules = useApprovalRules();
  const roles = useOrgRoles();
  const policies = useApprovalRoutingPolicies();
  const save = useSaveApprovalRoutingPolicy();
  const clear = useClearApprovalRoutingPolicy();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const mayConfigure = isAdmin || can("administration", "approvals", "edit");

  const roleOptions = useMemo(
    () => (roles.data ?? []).filter((r) => r.active !== false),
    [roles.data],
  );
  const policyOf = useMemo(() => {
    const map = new Map<string, ApprovalRoutingPolicy>();
    for (const p of policies.data ?? []) map.set(p.workflow_key, p);
    return map;
  }, [policies.data]);

  const levelsOf = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of rules.data ?? [])
      map.set(r.approval_type, (map.get(r.approval_type) ?? 0) + 1);
    return map;
  }, [rules.data]);

  if (types.isLoading || rules.isLoading || policies.isLoading)
    return <LoadingState variant="cards" rows={3} />;

  const typeList = (types.data ?? []).filter((t) => t.active);
  const configured = typeList.filter((t) => policyOf.has(t.key)).length;
  const noAuthority = typeList.filter((t) => (levelsOf.get(t.key) ?? 0) === 0).length;

  const get = (key: string) => drafts[key] ?? draftOf(policyOf.get(key));
  const set = (key: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [key]: { ...get(key), ...patch } }));

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Administration"
        title="Approval Routing Policy"
        description="For each workflow, name the role that reserves the decision and the role that picks the request up when the configured approver is unstaffed or is the person who raised it. A record is never routed back to its own author — record a written exception on the self-approval screen if your organisation has decided otherwise."
        actions={
          <Button asChild variant="outline">
            <Link to="/admin/self-approval-exceptions">Self-approval exceptions</Link>
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Workflows" value={String(typeList.length)} icon={RouteIcon} />
        <StatCard label="With a routing policy" value={String(configured)} icon={ShieldCheck} />
        {noAuthority > 0 ? (
          <StatCard label="Without approval authority" value={String(noAuthority)} tone="warning" />
        ) : (
          <StatCard label="Without approval authority" value="0" />
        )}
      </div>

      <SectionCard
        title="Routing by workflow"
        description="Leave a workflow untouched to keep the workspace default route. Levels are the approval authorities configured under Approval Authority & Limits."
      >
        <PagedRows rows={typeList} unit="workflows">
          {(page) => (
            <TableScroll>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Workflow</TableHead>
                    <TableHead>Reserved approver</TableHead>
                    <TableHead>Fallback approver</TableHead>
                    <TableHead>Fallback</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead>Levels</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {page.map((t) => {
                    const d = get(t.key);
                    const existing = policyOf.get(t.key);
                    const levels = levelsOf.get(t.key) ?? 0;
                    return (
                      <TableRow key={t.key}>
                        <TableCell>
                          <p className="font-medium">{t.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {existing ? "Configured" : "Workspace default"}
                          </p>
                        </TableCell>
                        <TableCell className="min-w-44">
                          <Select
                            value={d.reserved}
                            onValueChange={(v) => set(t.key, { reserved: v })}
                            disabled={!mayConfigure}
                          >
                            <SelectTrigger aria-label={`Reserved approver for ${t.name}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NONE}>Not reserved</SelectItem>
                              {roleOptions.map((r) => (
                                <SelectItem key={r.id} value={r.id}>
                                  {r.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell className="min-w-44">
                          <Select
                            value={d.fallback}
                            onValueChange={(v) => set(t.key, { fallback: v })}
                            disabled={!mayConfigure || !d.fallbackEnabled}
                          >
                            <SelectTrigger aria-label={`Fallback approver for ${t.name}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NONE}>No fallback</SelectItem>
                              {roleOptions.map((r) => (
                                <SelectItem key={r.id} value={r.id}>
                                  {r.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={d.fallbackEnabled}
                            disabled={!mayConfigure}
                            onCheckedChange={(v) => set(t.key, { fallbackEnabled: v })}
                            aria-label={`Allow a fallback approver for ${t.name}`}
                          />
                        </TableCell>
                        <TableCell className="min-w-48">
                          <Input
                            value={d.notes}
                            disabled={!mayConfigure}
                            onChange={(e) => set(t.key, { notes: e.target.value })}
                            placeholder="Why this route"
                          />
                        </TableCell>
                        <TableCell>
                          <StatusPill tone={levels > 0 ? "success" : "warning"}>
                            {levels > 0 ? `${levels} level${levels === 1 ? "" : "s"}` : "None"}
                          </StatusPill>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              disabled={!mayConfigure || save.isPending}
                              onClick={() =>
                                save.mutate({
                                  workflow_key: t.key,
                                  reserved_role_id: d.reserved === NONE ? null : d.reserved,
                                  fallback_role_id: d.fallback === NONE ? null : d.fallback,
                                  fallback_enabled: d.fallbackEnabled,
                                  notes: d.notes.trim() === "" ? null : d.notes.trim(),
                                })
                              }
                            >
                              Save
                            </Button>
                            {existing ? (
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`Remove routing policy for ${t.name}`}
                                disabled={!mayConfigure || clear.isPending}
                                onClick={() => {
                                  setDrafts((s) => {
                                    const next = { ...s };
                                    delete next[t.key];
                                    return next;
                                  });
                                  clear.mutate(existing.id);
                                }}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableScroll>
          )}
        </PagedRows>
      </SectionCard>

      <SectionCard
        title="How a request finds its approver"
        description="The same order is used everywhere, including My Work."
      >
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>If the workflow names a reserved role, only a staffed holder of that role may decide.</li>
          <li>
            Otherwise the configured authority levels are tried in order, narrowest scope first,
            skipping any level whose limit is below the amount.
          </li>
          <li>The person who raised the record is always skipped, whatever their role.</li>
          <li>
            If nobody is left, the fallback role picks it up; with no fallback the request is held
            for an independent approver rather than approved by its author.
          </li>
        </ol>
        <p className="mt-3 text-sm text-muted-foreground">
          Roles offered here are this workspace&apos;s own active roles; nothing is hard-coded.
        </p>
      </SectionCard>
    </div>
  );
}
