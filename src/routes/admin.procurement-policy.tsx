import { useMemo, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ShieldCheck, Trash2 } from "lucide-react";
import { LoadingState } from "@/components/common/StateSystem";
import {
  PageHeader,
  SectionCard,
  StatCard,
  StatusPill,
  TableScroll,
} from "@/components/common/DataDisplay";
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
import { NeoDatePicker } from "@/components/common/DatePicker";
import { useAuth } from "@/lib/auth";
import {
  authorityLadder,
  findCoverageIssues,
  type CoverageIssue,
} from "@/lib/approval-coverage";
import { selectableApprovalTypes } from "@/lib/approval-types";
import { useBranches } from "@/lib/branches";
import { useOrgRoles } from "@/lib/workspace-preview-data";
import { titleCase } from "@/lib/finance";
import {
  useApprovalRules,
  useApprovalTypes,
  useDeleteApprovalRule,
  useSaveApprovalRule,
  type ApprovalRule,
} from "@/lib/finance-controls";

export const Route = createFileRoute("/admin/procurement-policy")({
  head: () => ({
    meta: [
      { title: "Procurement Approval & Control Policy — NEØ Administration" },
      {
        name: "description",
        content:
          "Configure, per property, which amount band of a requisition, purchase order, receipt variance or supplier invoice goes to which approver, from when, in which currency, and whether a rejection or override must carry a written reason.",
      },
      {
        property: "og:title",
        content: "Procurement Approval & Control Policy — NEØ Administration",
      },
      {
        property: "og:description",
        content:
          "Property-scoped procurement approval bands, approver order, effective dates and reason requirements — configured from the screen, never in code.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ProcurementPolicyPage,
});

/**
 * Procurement transaction types come from the platform registry, not from this
 * screen and not from hotel-entered master data: the routing engine has to know
 * which workflow it is routing. A workspace may rename a type; the key is ours.
 */

type Draft = {
  approval_type: string;
  level: string;
  branch_id: string;
  approver_role_id: string;
  min_amount: string;
  max_amount: string;
  currency: string;
  effective_from: string;
  effective_to: string;
  require_rejection_reason: boolean;
  require_override_reason: boolean;
  escalate_above_limit: boolean;
};

const EMPTY: Draft = {
  approval_type: "",
  level: "1",
  branch_id: "all",
  approver_role_id: "",
  min_amount: "",
  max_amount: "",
  currency: "",
  effective_from: "",
  effective_to: "",
  require_rejection_reason: true,
  require_override_reason: true,
  escalate_above_limit: true,
};

function money(v: number | null): string {
  return v === null ? "—" : v.toLocaleString();
}

function ProcurementPolicyPage() {
  const { can } = useAuth();
  const types = useApprovalTypes();
  const rules = useApprovalRules();
  const roles = useOrgRoles();
  const branches = useBranches();
  const save = useSaveApprovalRule();
  const remove = useDeleteApprovalRule();

  const [draft, setDraft] = useState<Draft>(EMPTY);
  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  const mayConfigure = can("procurement", "settings", "edit");

  const typeList = useMemo(
    () => selectableApprovalTypes("procurement", types.data ?? []),
    [types.data],
  );
  const typeKeys = useMemo(() => new Set(typeList.map((t) => t.key)), [typeList]);
  const ruleList = useMemo(
    () => (rules.data ?? []).filter((r) => typeKeys.has(r.approval_type)),
    [rules.data, typeKeys],
  );

  const roleName = useMemo(
    () => new Map((roles.data ?? []).map((r) => [r.id, r.name] as const)),
    [roles.data],
  );
  const branchName = useMemo(
    () =>
      new Map(
        ((branches.data ?? []) as { id: string; name: string }[]).map(
          (b) => [b.id, b.name] as const,
        ),
      ),
    [branches.data],
  );

  /**
   * Only types an active workflow actually routes need an approver. A legacy
   * duplicate kept for historical records must not nag an administrator into
   * configuring authority for a workflow nothing raises any more.
   */
  const uncovered = typeList.filter(
    (t) => !t.legacy && !ruleList.some((r) => r.approval_type === t.key && r.active),
  );

  const branchList = useMemo(
    () => ((branches.data ?? []) as { id: string; name: string }[]).map((b) => ({ id: b.id, name: b.name })),
    [branches.data],
  );

  /**
   * Coverage is derived from the saved rules through the same resolution the
   * runtime router uses — property rules plus organisation-wide rules, in
   * level order — so the screen never invents a gap the engine would not hit.
   */
  const issues: CoverageIssue[] = useMemo(
    () =>
      findCoverageIssues(ruleList, {
        types: typeList.map((t) => ({ key: t.key, name: t.name })),
        branches: branchList,
      }),
    [ruleList, typeList, branchList],
  );
  const gaps = issues.filter((i) => i.kind === "gap");
  const overlaps = issues.filter((i) => i.kind === "overlap");

  /** Readable authority ladder per transaction type and property. */
  const ladders = useMemo(() => {
    const scopes: { id: string | null; name: string }[] =
      branchList.length > 0 ? branchList : [{ id: null, name: "All properties" }];
    const out: { key: string; heading: string; bands: ReturnType<typeof authorityLadder> }[] = [];
    for (const t of typeList) {
      for (const scope of scopes) {
        const bands = authorityLadder(ruleList, { type: t.key, branchId: scope.id });
        if (bands.length === 0) continue;
        const currency = bands.find((b) => b.rule.currency)?.rule.currency ?? "";
        out.push({
          key: `${t.key}::${scope.id ?? "all"}`,
          heading: [t.name, scope.name, currency].filter(Boolean).join(" · "),
          bands,
        });
      }
    }
    return out;
  }, [typeList, ruleList, branchList]);

  if (types.isLoading || rules.isLoading) return <LoadingState />;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Administration"
        title="Procurement Approval & Control Policy"
        description="Every procurement decision is routed by configuration, never by job title. For each transaction type you set the amount band, the property it applies to, the approver role and its order, when the rule takes effect, and whether a rejection or an override must carry a written reason. Nobody approves a record they raised, whatever this screen says."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Procurement transaction types" value={String(typeList.length)} icon={ShieldCheck} />
        <StatCard label="Configured rules" value={String(ruleList.length)} />
        <StatCard
          label="Types with no approver"
          value={String(uncovered.length)}
          {...(uncovered.length > 0 ? { tone: "warning" as const } : {})}
        />
      </div>

      {uncovered.length > 0 ? (
        <SectionCard
          title="Not every procurement transaction can be approved yet"
          description="A request of a type with no configured approver cannot route to anyone and will be held instead of silently passing."
        >
          <p className="text-sm text-muted-foreground">
            No approver is configured for:{" "}
            {uncovered.map((t) => t.name).join(", ")}.
          </p>
        </SectionCard>
      ) : null}

      {gaps.length > 0 ? (
        <SectionCard
          title="Gaps in the amount bands"
          description="An amount that falls between two bands has no approver. Extend the band below or lower the band above."
        >
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {gaps.map((g) => (
              <li key={g.message}>{g.message}</li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {overlaps.length > 0 ? (
        <SectionCard
          title="Rules that contradict each other"
          description="Two rules at the same approval level claim the same amounts, so which one applies is ambiguous. Give them different levels or separate their bands."
        >
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {overlaps.map((o) => (
              <li key={o.message}>{o.message}</li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {ladders.length > 0 ? (
        <SectionCard
          title="Authority ladder"
          description="How a request of each value will actually route today, read from the saved policy: a property's own rules first, then any group-wide rule."
        >
          <div className="grid gap-4 md:grid-cols-2">
            {ladders.map((l) => (
              <div key={l.key} className="rounded-lg border p-4">
                <p className="text-sm font-medium">{l.heading}</p>
                <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                  {l.bands.map((b) => (
                    <li key={b.rule.id ?? `${b.from}`} className="flex items-baseline justify-between gap-3">
                      <span className="tabular-nums">
                        {money(b.from)} – {b.to === null ? "no ceiling" : money(b.to)}
                      </span>
                      <span className="text-right text-foreground">
                        {b.rule.approver_role_id
                          ? (roleName.get(b.rule.approver_role_id) ?? "—")
                          : "Named approver"}
                        {b.orgWide ? " · all properties" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Related controls"
        description="Who reserves a workflow, who picks it up when the approver is unavailable, any written self-approval exception, and the supplier master are configured on their own screens."
      >
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link to="/admin/approval-routing">Approval routing policy</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/admin/self-approval-exceptions">Self-approval exceptions</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/admin/suppliers">Suppliers</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/admin/approval-limits">All approval authority</Link>
          </Button>
        </div>
      </SectionCard>

      {mayConfigure ? (
        <SectionCard
          title="Add a procurement rule"
          description="Leave the minimum empty to start at zero and the maximum empty for no ceiling at that level. Leave the property on all properties for a group-wide rule."
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
              <Label htmlFor="pp-level">Approver order (level)</Label>
              <Input
                id="pp-level"
                inputMode="numeric"
                value={draft.level}
                onChange={(e) => set("level", e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pp-min">Minimum amount</Label>
              <Input
                id="pp-min"
                inputMode="decimal"
                placeholder="From 0"
                value={draft.min_amount}
                onChange={(e) => set("min_amount", e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pp-max">Maximum amount</Label>
              <Input
                id="pp-max"
                inputMode="decimal"
                placeholder="No ceiling"
                value={draft.max_amount}
                onChange={(e) => set("max_amount", e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pp-currency">Currency</Label>
              <Input
                id="pp-currency"
                placeholder="Workspace currency"
                maxLength={3}
                value={draft.currency}
                onChange={(e) => set("currency", e.target.value.toUpperCase())}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pp-from">Effective from</Label>
              <NeoDatePicker
                id="pp-from"
                value={draft.effective_from}
                placeholder="From today"
                onChange={(v) => set("effective_from", v)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pp-to">Effective to</Label>
              <NeoDatePicker
                id="pp-to"
                value={draft.effective_to}
                placeholder="No end date"
                min={draft.effective_from || undefined}
                onChange={(v) => set("effective_to", v)}
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-6">
            <div className="flex items-center gap-2">
              <Switch
                id="pp-reject-reason"
                checked={draft.require_rejection_reason}
                onCheckedChange={(v) => set("require_rejection_reason", v)}
              />
              <Label htmlFor="pp-reject-reason">A rejection must carry a written reason</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="pp-override-reason"
                checked={draft.require_override_reason}
                onCheckedChange={(v) => set("require_override_reason", v)}
              />
              <Label htmlFor="pp-override-reason">An override must carry a written reason</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="pp-escalate"
                checked={draft.escalate_above_limit}
                onCheckedChange={(v) => set("escalate_above_limit", v)}
              />
              <Label htmlFor="pp-escalate">Escalate above this band instead of refusing</Label>
            </div>
          </div>

          <div className="mt-4">
            <Button
              disabled={!draft.approval_type || !draft.approver_role_id || save.isPending}
              onClick={() =>
                save.mutate(
                  {
                    approval_type: draft.approval_type,
                    level: Number(draft.level) || 1,
                    branch_id: draft.branch_id === "all" ? null : draft.branch_id,
                    approver_role_id: draft.approver_role_id,
                    min_amount: draft.min_amount === "" ? null : Number(draft.min_amount),
                    max_amount: draft.max_amount === "" ? null : Number(draft.max_amount),
                    max_percent: null,
                    currency: draft.currency.trim() === "" ? null : draft.currency.trim(),
                    effective_from: draft.effective_from === "" ? null : draft.effective_from,
                    effective_to: draft.effective_to === "" ? null : draft.effective_to,
                    require_rejection_reason: draft.require_rejection_reason,
                    require_override_reason: draft.require_override_reason,
                    escalate_above_limit: draft.escalate_above_limit,
                    active: true,
                    label: null,
                  },
                  { onSuccess: () => setDraft(EMPTY) },
                )
              }
            >
              Save rule
            </Button>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Configured procurement policy"
        description="A request is routed to the lowest level whose band covers it and whose dates are in force. Historic rules are never rewritten: change one by ending it and adding its replacement."
      >
        {ruleList.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No procurement approval rule is configured yet. Requisitions, purchase orders and
            supplier invoices will report that an administrator must configure approval authority.
          </p>
        ) : (
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Transaction type</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead>Approver role</TableHead>
                  <TableHead>Property</TableHead>
                  <TableHead className="text-right">Band</TableHead>
                  <TableHead>In force</TableHead>
                  <TableHead>Reasons</TableHead>
                  <TableHead className="text-right">Remove</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ruleList.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{titleCase(r.approval_type.replace(/-/g, " "))}</TableCell>
                    <TableCell>{r.level}</TableCell>
                    <TableCell>
                      {r.approver_role_id
                        ? (roleName.get(r.approver_role_id) ?? "—")
                        : "Named approver"}
                    </TableCell>
                    <TableCell>
                      {r.branch_id ? (branchName.get(r.branch_id) ?? "—") : "All properties"}
                    </TableCell>
                    <TableCell className="text-right">
                      {money(r.min_amount ?? 0)} – {r.max_amount === null ? "no ceiling" : money(r.max_amount)}
                      {r.currency ? ` ${r.currency}` : ""}
                    </TableCell>
                    <TableCell>
                      {r.effective_from ?? "Always"}
                      {r.effective_to ? ` → ${r.effective_to}` : ""}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={r.require_rejection_reason ? "success" : "warning"}>
                        {r.require_rejection_reason && r.require_override_reason
                          ? "Reason required"
                          : r.require_rejection_reason
                            ? "Rejection reason"
                            : r.require_override_reason
                              ? "Override reason"
                              : "Not required"}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="icon"
                        variant="ghost"
                        disabled={!mayConfigure || remove.isPending}
                        onClick={() => remove.mutate(r.id)}
                        aria-label="Remove procurement rule"
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
      </SectionCard>
    </div>
  );
}

/**
 * Report amounts no configured band covers, per transaction type and property.
 * A gap is silent otherwise: the request simply finds no approver.
 */
/**
 * Backwards-compatible gap list used by tests and older callers. Delegates to
 * the canonical resolver so the screen and the router cannot drift apart.
 */
export function findBandGaps(
  rules: ApprovalRule[],
  branches?: ReadonlyArray<{ id: string; name: string }>,
): string[] {
  const types = [...new Set(rules.map((r) => r.approval_type))].map((key) => ({
    key,
    name: titleCase(key.replace(/-/g, " ")),
  }));
  return findCoverageIssues(rules, {
    types,
    ...(branches ? { branches } : {}),
  })
    .filter((i) => i.kind === "gap")
    .map((i) => i.message);
}
