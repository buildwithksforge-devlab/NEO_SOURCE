import { useMemo, useState } from "react";
import { LoadingState } from "@/components/common/StateSystem";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ShieldCheck, Trash2 } from "lucide-react";
import {
  PageHeader,
  SectionCard,
  StatCard,
  StatusPill,
  TableScroll,
} from "@/components/common/DataDisplay";
import { PagedRows } from "@/components/common/TablePager";
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
import { Switch } from "@/components/ui/switch";
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
import { useOrgRoles } from "@/lib/workspace-preview-data";
import { titleCase } from "@/lib/finance";
import {
  useApprovalRules,
  useApprovalTypes,
  useDeleteApprovalRule,
  useSaveApprovalRule,
  useSeedApprovalAuthority,
} from "@/lib/finance-controls";

export const Route = createFileRoute("/admin/approval-limits")({
  head: () => ({
    meta: [
      { title: "Approval Authority & Limits — NEØ Administration" },
      {
        name: "description",
        content:
          "Configure who may approve discounts, voids, refunds, write-offs, bill adjustments and purchases, up to which amount or percentage, and where a request escalates when the limit is exceeded.",
      },
      { property: "og:title", content: "Approval Authority & Limits — NEØ Administration" },
      {
        property: "og:description",
        content:
          "Configurable approval limits and escalation for every controlled transaction type.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ApprovalLimitsPage,
});

type Draft = {
  approval_type: string;
  level: string;
  branch_id: string;
  approver_role_id: string;
  max_amount: string;
  max_percent: string;
  escalate_above_limit: boolean;
};

const EMPTY: Draft = {
  approval_type: "",
  level: "1",
  branch_id: "all",
  approver_role_id: "",
  max_amount: "",
  max_percent: "",
  escalate_above_limit: true,
};

function ApprovalLimitsPage() {
  const { can, isAdmin } = useAuth();
  const types = useApprovalTypes();
  const rules = useApprovalRules();
  const branches = useBranches();
  const roles = useOrgRoles();
  const save = useSaveApprovalRule();
  const remove = useDeleteApprovalRule();
  const seed = useSeedApprovalAuthority();
  const [draft, setDraft] = useState<Draft>(EMPTY);

  const mayConfigure = isAdmin || can("administration", "approvals", "edit");
  const roleName = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of roles.data ?? []) {
      map.set(r.id, r.name);
    }
    return map;
  }, [roles.data]);
  const branchName = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of (branches.data ?? []) as { id: string; name: string }[]) map.set(b.id, b.name);
    return map;
  }, [branches.data]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  if (types.isLoading || rules.isLoading) return <LoadingState variant="cards" rows={3} />;

  const typeList = (types.data ?? []).filter((t) => t.active);
  const ruleList = rules.data ?? [];

  const unconfigured = typeList.filter(
    (t) => !ruleList.some((r) => r.approval_type === t.key),
  ).length;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Administration"
        title="Approval Authority & Limits"
        description="Approval authority is configuration, never a hard-coded role. Each level names who may approve, the highest amount or percentage they may pass, and whether a larger request escalates to the next authorised approver."
        actions={
          mayConfigure && unconfigured > 0 ? (
            <Button variant="outline" disabled={seed.isPending} onClick={() => seed.mutate()}>
              Apply recommended governance
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Transaction types" value={String(typeList.length)} icon={ShieldCheck} />
        <StatCard label="Configured authorities" value={String(ruleList.length)} />
        <StatCard label="Types without authority" value={String(unconfigured)} tone="warning" />
      </div>

      {mayConfigure && unconfigured > 0 ? (
        <SectionCard
          title="No approval route for every transaction type"
          description="Requests of an unconfigured type cannot route to anyone. Applying the recommended governance creates a four-level hierarchy — department or duty manager, finance, general manager, then owner or director — for every type that has none. Each level stays fully editable below."
        >
          <Button disabled={seed.isPending} onClick={() => seed.mutate()}>
            Apply recommended governance
          </Button>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Routing and self-approval"
        description="Who reserves each workflow, who picks it up when the approver is unavailable, and any written exception to the rule that nobody approves their own record, are configured on their own screens."
      >
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link to="/admin/approval-routing">Approval routing policy</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/admin/self-approval-exceptions">Self-approval exceptions</Link>
          </Button>
        </div>
      </SectionCard>

      {mayConfigure ? (
        <SectionCard
          title="Add an approval authority"
          description="Leave the amount and percentage empty for unlimited authority at that level."
        >
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6 lg:items-end">
            <div className="grid gap-1.5">
              <Label>Transaction type</Label>
              <Select value={draft.approval_type} onValueChange={(v) => set("approval_type", v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {typeList.map((t) => (
                    <SelectItem key={t.key} value={t.key}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Approver role</Label>
              <Select
                value={draft.approver_role_id}
                onValueChange={(v) => set("approver_role_id", v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {(roles.data ?? []).map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Property</Label>
              <Select value={draft.branch_id} onValueChange={(v) => set("branch_id", v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All properties</SelectItem>
                  {((branches.data ?? []) as { id: string; name: string }[]).map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="limit-level">Level</Label>
              <Input
                id="limit-level"
                inputMode="numeric"
                value={draft.level}
                onChange={(e) => set("level", e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="limit-amount">Max amount</Label>
              <Input
                id="limit-amount"
                inputMode="decimal"
                value={draft.max_amount}
                onChange={(e) => set("max_amount", e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="limit-percent">Max %</Label>
              <Input
                id="limit-percent"
                inputMode="decimal"
                value={draft.max_percent}
                onChange={(e) => set("max_percent", e.target.value)}
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch
                id="escalate"
                checked={draft.escalate_above_limit}
                onCheckedChange={(v) => set("escalate_above_limit", v)}
              />
              <Label htmlFor="escalate">
                Escalate to the next authorised approver above this limit
              </Label>
            </div>
            <Button
              disabled={!draft.approval_type || !draft.approver_role_id || save.isPending}
              onClick={() =>
                save.mutate(
                  {
                    approval_type: draft.approval_type,
                    level: Number(draft.level) || 1,
                    branch_id: draft.branch_id === "all" ? null : draft.branch_id,
                    approver_role_id: draft.approver_role_id,
                    max_amount: draft.max_amount === "" ? null : Number(draft.max_amount),
                    max_percent: draft.max_percent === "" ? null : Number(draft.max_percent),
                    escalate_above_limit: draft.escalate_above_limit,
                    active: true,
                    label: null,
                  },
                  { onSuccess: () => setDraft(EMPTY) },
                )
              }
            >
              Save authority
            </Button>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Configured authority"
        description="A request is routed to the lowest level that covers it; a request over every configured limit escalates rather than being silently refused."
      >
        {ruleList.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No approval authority is configured yet. Controlled transactions will report that an
            administrator must configure approval authority.
          </p>
        ) : (
          <PagedRows rows={ruleList} unit="rules">
            {(pageRules) => (
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Transaction type</TableHead>
                      <TableHead>Level</TableHead>
                      <TableHead>Approver role</TableHead>
                      <TableHead>Property</TableHead>
                      <TableHead className="text-right">Max amount</TableHead>
                      <TableHead className="text-right">Max %</TableHead>
                      <TableHead>Escalates</TableHead>
                      <TableHead className="text-right">Remove</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRules.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell>{titleCase(r.approval_type.replace(/-/g, " "))}</TableCell>
                        <TableCell>{r.level}</TableCell>
                        <TableCell>
                          {r.approver_role_id
                            ? (roleName.get(r.approver_role_id) ?? "—")
                            : "Named user"}
                        </TableCell>
                        <TableCell>
                          {r.branch_id ? (branchName.get(r.branch_id) ?? "—") : "All properties"}
                        </TableCell>
                        <TableCell className="text-right">
                          {r.max_amount === null ? "Unlimited" : r.max_amount}
                        </TableCell>
                        <TableCell className="text-right">
                          {r.max_percent === null ? "Unlimited" : `${r.max_percent}%`}
                        </TableCell>
                        <TableCell>
                          <StatusPill tone={r.escalate_above_limit ? "success" : "warning"}>
                            {r.escalate_above_limit ? "Escalates" : "Refuses"}
                          </StatusPill>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="icon"
                            variant="ghost"
                            disabled={!mayConfigure || remove.isPending}
                            onClick={() => remove.mutate(r.id)}
                            aria-label="Remove approval authority"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            )}
          </PagedRows>
        )}
      </SectionCard>
    </div>
  );
}
