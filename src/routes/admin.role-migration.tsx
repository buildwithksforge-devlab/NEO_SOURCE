import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, CheckCircle2, Loader2, RotateCcw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import {
  useMigrationActions,
  useMigrationItems,
  useMigrationRuns,
  usePreflight,
  useReconciliation,
  useAdoptionStatus,
  usePendingRoleDecisions,
  useRoleAssignmentHistory,
  type MigrationItem,
} from "@/lib/role-migration";
import { EmptyState, LoadingState } from "@/components/common/StateSystem";

export const Route = createFileRoute("/admin/role-migration")({
  head: () => ({
    meta: [
      { title: "Role & Department Consolidation — NEØ" },
      {
        name: "description",
        content:
          "Review, approve and apply the approved hotel role structure without losing a single user, department, permission or record of history.",
      },
      { property: "og:title", content: "Role & Department Consolidation — NEØ" },
      {
        property: "og:description",
        content:
          "Preview every proposed role change before anything is applied, then execute it in one reversible step.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: RoleMigrationPage,
});

type Bag = Record<string, unknown>;
const bag = (v: unknown): Bag => (v && typeof v === "object" ? (v as Bag) : {});
const num = (o: Bag, k: string) => (typeof o[k] === "number" ? (o[k] as number) : 0);
const text = (o: Bag, k: string) => (o[k] == null ? "" : String(o[k]));
const list = (o: Bag, k: string) => (Array.isArray(o[k]) ? (o[k] as unknown[]) : []);

function RoleMigrationPage() {
  const { organizationId, isAdmin } = useAuth();
  const [runId, setRunId] = useState<string | null>(null);

  const preflight = usePreflight(isAdmin ? organizationId : null);
  const reconciliation = useReconciliation(isAdmin ? organizationId : null);
  const runs = useMigrationRuns(isAdmin ? organizationId : null);
  const adoption = useAdoptionStatus(isAdmin ? organizationId : null);
  const decisions = usePendingRoleDecisions(isAdmin ? organizationId : null);
  const history = useRoleAssignmentHistory(isAdmin ? organizationId : null);
  const actions = useMigrationActions(organizationId);

  const activeRun = useMemo(() => {
    const all = runs.data ?? [];
    return all.find((r) => r.id === runId) ?? all[0] ?? null;
  }, [runs.data, runId]);

  const items = useMigrationItems(activeRun?.id ?? null);

  if (!isAdmin) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Role & Department Consolidation"
          description="Only an authorised administrator may review or apply the approved role structure."
        />
        <SectionCard title="Not available">
          <p className="text-sm text-muted-foreground">
            This screen changes who can do what across the whole organisation, so it is restricted to
            administrators with organisation-wide authority.
          </p>
        </SectionCard>
      </div>
    );
  }

  const pf = bag(preflight.data);
  const rec = bag(reconciliation.data);
  const ad = bag(adoption.data);
  const lastRun = bag(ad["last_run"]);
  const rows = items.data ?? [];
  const pendingReview = rows.filter((i) => i.ambiguous && i.decision === "pending");
  const proposals = rows.filter((i) => !i.ambiguous && i.decision !== "applied");
  const applied = rows.filter((i) => i.decision === "applied");

  const adopt = () =>
    actions.adopt.mutate(undefined, {
      onSuccess: () => toast.success("The approved structure has been adopted for this workspace."),
      onError: (e: unknown) => toast.error((e as Error).message),
    });

  const plan = () =>
    actions.plan.mutate(`consolidation-${new Date().toISOString().slice(0, 10)}`, {
      onSuccess: (id) => {
        setRunId(id);
        toast.success("Migration preview prepared. Nothing has been changed yet.");
      },
      onError: (e: unknown) => toast.error((e as Error).message),
    });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Role & Department Consolidation"
        description="Map the roles you already use onto the approved hotel structure. Every change is previewed, approved and recorded — no user, department, permission or history is ever deleted."
        actions={
          <Button onClick={plan} disabled={actions.plan.isPending}>
            {actions.plan.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Prepare preview
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Roles in use"
          value={String(num(pf, "roles_total"))}
          hint={`${num(pf, "roles_active")} aligned · ${num(pf, "roles_legacy")} to migrate`}
        />
        <StatCard
          label="Departments"
          value={String(num(pf, "departments_total"))}
          hint={`${num(pf, "stations_total")} stations`}
        />
        <StatCard
          label="Staff accounts"
          value={String(num(pf, "staff_total"))}
          hint={`${list(pf, "users_on_predecessor_roles").length} on previous roles`}
        />
        <StatCard
          label="Needs a decision"
          value={String(
            list(pf, "review_required_roles").length +
              pendingReview.length +
              (decisions.data?.length ?? 0),
          )}
          hint="Every one of them is listed below"
        />
      </div>

      <SectionCard
        title="Role decisions awaiting a human"
        description="The platform never guesses who someone is. Each worker below has a recorded job title or role combination that must be confirmed before their access is narrowed. Until it is confirmed, both assignments are preserved exactly as they are."
      >
        {decisions.isLoading ? (
          <LoadingState variant="rows" rows={2} />
        ) : (decisions.data?.length ?? 0) === 0 ? (
          <EmptyState
            title="No decisions outstanding"
            description="No role ownership decisions are outstanding for this workspace."
            inline
          />
        ) : (
          <ul className="space-y-3">
            {(decisions.data ?? []).map((d) => (
              <li key={d.user_id} className="rounded-xl border border-border bg-muted/30 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{d.full_name || "Unnamed staff record"}</span>
                  {d.holds_admin_authority ? (
                    <Badge variant="outline" className="border-warning/40 text-warning">
                      Holds administrative authority
                    </Badge>
                  ) : null}
                </div>
                <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="inline text-muted-foreground">Recorded job title: </dt>
                    <dd className="inline text-foreground">{d.job_title || "Not recorded"}</dd>
                  </div>
                  <div>
                    <dt className="inline text-muted-foreground">Assigned roles: </dt>
                    <dd className="inline text-foreground">{d.current_roles}</dd>
                  </div>
                  <div>
                    <dt className="inline text-muted-foreground">Primary role: </dt>
                    <dd className="inline text-foreground">{d.primary_role || "Not set"}</dd>
                  </div>
                </dl>
                <p className="mt-2 text-sm text-muted-foreground">{d.reason}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Effect on access: while both roles remain, this account keeps the wider of the two
                  sets of permissions. Resolve it in Users → this employee → roles.
                </p>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>


      <SectionCard
        title="Modern Hotel Operating Structure v2.0"
        description="One approved catalogue for every workspace. Running adoption aligns departments, classifies the roles you already use, creates anything missing, merges duplicates into the role that already holds the staff, applies the approved permission templates and gives every member one primary role and dashboard. Nothing is deleted and every identifier is kept."
      >
        {adoption.isLoading ? (
          <LoadingState variant="cards" rows={4} />
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="Approved roles in place"
                value={`${num(ad, "catalogue_roles_present")} / ${num(ad, "catalogue_roles")}`}
                hint={`${num(ad, "active_roles")} active in total · ${num(ad, "custom_roles")} custom · ${num(ad, "archived_roles")} archived (kept for history)`}
              />
              <StatCard
                label="Roles without permissions"
                value={String(num(ad, "roles_without_permissions"))}
                hint="Should be zero after adoption"
              />
              <StatCard
                label="Roles without a dashboard"
                value={String(num(ad, "roles_without_dashboard"))}
                hint="Every active role lands somewhere"
              />
              <StatCard
                label="Members without one primary role"
                value={String(num(ad, "members_without_primary"))}
                hint="Decides which dashboard they open"
              />
            </div>
            {list(ad, "missing_catalogue_roles").length > 0 ? (
              <Findings
                label="Approved roles this workspace is missing"
                values={list(ad, "missing_catalogue_roles").map(String)}
              />
            ) : (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-success" />
                Every approved role exists in this workspace.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={adopt} disabled={actions.adopt.isPending}>
                {actions.adopt.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Adopt the approved structure
              </Button>
              <span className="text-xs text-muted-foreground">
                {Object.keys(lastRun).length > 0
                  ? `Last run ${new Date(text(lastRun, "created_at")).toLocaleString()} (${text(lastRun, "trigger_source")})`
                  : "Not run yet in this workspace"}
              </span>
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Readiness check" description="What the migration found before touching anything.">

        {preflight.isLoading ? (
          <LoadingState variant="rows" rows={2} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <Findings
              label="Duplicate role names"
              values={list(pf, "duplicate_role_keys").map((d) => text(bag(d), "key"))}
            />
            <Findings
              label="Duplicate departments"
              values={list(pf, "duplicate_departments").map((d) => text(bag(d), "name"))}
            />
            <Findings label="Staff without a property" values={list(pf, "users_without_property").map(String)} />
            <Findings label="Staff without a department" values={list(pf, "users_without_department").map(String)} />
            <Findings label="Staff without a station" values={list(pf, "users_without_station").map(String)} />
            <Findings
              label="Departments without a manager"
              values={list(pf, "departments_without_manager").map(String)}
            />
            <Findings
              label="Staff holding more than one role"
              values={list(pf, "users_multiple_roles").map((u) => {
                const r = bag(u);
                return `${text(r, "user")}: ${list(r, "roles").map(String).join(", ")}`;
              })}
            />
            <Findings label="Staff with no role at all" values={list(pf, "users_without_roles").map(String)} />
          </div>
        )}
      </SectionCard>

      {runs.data && runs.data.length > 1 ? (
        <SectionCard title="Migration run">
          <Select value={activeRun?.id ?? ""} onValueChange={setRunId}>
            <SelectTrigger className="max-w-md">
              <SelectValue placeholder="Select a run" />
            </SelectTrigger>
            <SelectContent>
              {runs.data.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {new Date(r.created_at).toLocaleString()} — {r.status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SectionCard>
      ) : null}

      {activeRun ? (
        <SectionCard
          title="Proposed changes"
          description={`This preview is ${activeRun.status}. Nothing is applied until you approve and run it.`}
          actions={
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={actions.approve.isPending || activeRun.status === "completed"}
                onClick={() =>
                  actions.approve.mutate(activeRun.id, {
                    onSuccess: () => toast.success("Migration approved and ready to run."),
                    onError: (e: unknown) => toast.error((e as Error).message),
                  })
                }
              >
                Approve
              </Button>
              <Button
                disabled={actions.execute.isPending || activeRun.status !== "approved"}
                onClick={() =>
                  actions.execute.mutate(activeRun.id, {
                    onSuccess: () =>
                      toast.success("Migration applied. Every change is recorded in history and the audit trail."),
                    onError: (e: unknown) => toast.error((e as Error).message),
                  })
                }
              >
                {actions.execute.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Run migration
              </Button>
            </div>
          }
        >
          {pendingReview.length > 0 ? (
            <div className="mb-6 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-amber-600">
                <AlertTriangle className="h-4 w-4" />
                {pendingReview.length} assignment(s) need a human decision before this can run
              </div>
              {pendingReview.map((item) => (
                <ItemCard key={item.id} item={item} decide={actions.decide.mutate} review />
              ))}
            </div>
          ) : null}

          {proposals.length === 0 && applied.length === 0 ? (
            <EmptyState
              title="No proposals yet"
              description="Prepare a preview to see exactly what would change."
              inline
            />
          ) : null}

          <div className="space-y-3">
            {proposals.map((item) => (
              <ItemCard key={item.id} item={item} decide={actions.decide.mutate} />
            ))}
          </div>

          {applied.length > 0 ? (
            <>
              <Separator className="my-6" />
              <p className="mb-3 text-sm font-medium">Applied ({applied.length})</p>
              <ul className="space-y-2 text-sm text-muted-foreground">
                {applied.map((i) => (
                  <li key={i.id} className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    {i.subject_label} — {i.migration_reason}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </SectionCard>
      ) : null}

      <SectionCard
        title="Reconciliation"
        description="Which roles are current, which are kept as predecessors, and what still depends on them."
      >
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <p className="mb-2 text-sm font-medium">Current roles</p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {list(rec, "active_roles").map((r) => {
                const role = bag(r);
                return (
                  <li key={text(role, "id")} className="flex items-center justify-between gap-3">
                    <span>{text(role, "name")}</span>
                    <Badge variant="secondary">{num(role, "users")} staff</Badge>
                  </li>
                );
              })}
              {list(rec, "active_roles").length === 0 ? <li>Awaiting data</li> : null}
            </ul>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">Previous roles kept for history</p>
            <ul className="space-y-2 text-sm">
              {list(rec, "legacy_roles").map((r) => {
                const role = bag(r);
                const deps = bag(role["dependencies"]);
                const blocked =
                  num(deps, "active_users") +
                    num(deps, "approval_rules") +
                    num(deps, "task_rules") +
                    num(deps, "notification_rules") +
                    num(deps, "station_assignments") >
                  0;
                const successor = text(role, "successor");
                return (
                  <li key={text(role, "id")} className="rounded-md border p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium">{text(role, "name")}</p>
                        <p className="text-xs text-muted-foreground">
                          {successor ? `Replaced by ${successor}` : "No successor recorded"}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actions.archive.isPending}
                        onClick={() =>
                          actions.archive.mutate(text(role, "id"), {
                            onSuccess: (res) => {
                              const r2 = bag(res);
                              if (r2["archived"])
                                toast.success("Role archived. It stays in history and can be reactivated.");
                              else toast.error(`Still in use: ${list(r2, "blockers").map(String).join("; ")}`);
                            },
                            onError: (e: unknown) => toast.error((e as Error).message),
                          })
                        }
                      >
                        Archive
                      </Button>
                    </div>
                    {blocked ? (
                      <p className="mt-2 flex items-center gap-1 text-xs text-amber-600">
                        <ShieldAlert className="h-3 w-3" />
                        {num(deps, "active_users")} staff · {num(deps, "approval_rules")} approval rules ·{" "}
                        {num(deps, "task_rules")} task rules · {num(deps, "notification_rules")} notification rules
                        still use it
                      </p>
                    ) : null}
                  </li>
                );
              })}
              {list(rec, "legacy_roles").length === 0 ? (
                <li className="text-sm text-muted-foreground">
                  None — every role matches the approved structure.
                </li>
              ) : null}
            </ul>
          </div>
        </div>

        {list(rec, "archived_roles").length > 0 ? (
          <>
            <Separator className="my-6" />
            <p className="mb-2 text-sm font-medium">Archived roles</p>
            <div className="flex flex-wrap gap-2">
              {list(rec, "archived_roles").map((r) => {
                const role = bag(r);
                return (
                  <Button
                    key={text(role, "id")}
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      actions.reactivate.mutate(
                        { role: text(role, "id"), reason: "Reactivated from the consolidation screen." },
                        {
                          onSuccess: () => toast.success("Role reactivated with its previous mapping intact."),
                          onError: (e: unknown) => toast.error((e as Error).message),
                        },
                      )
                    }
                  >
                    <RotateCcw className="mr-2 h-3 w-3" />
                    {text(role, "name")}
                  </Button>
                );
              })}
            </div>
          </>
        ) : null}

        <Separator className="my-6" />
        <p className="text-sm text-muted-foreground">
          Restricted approvals (voids, discounts, complimentary items, refunds, payment reversals, folio
          reopening and price overrides) are held only by:{" "}
          <strong>{list(rec, "restricted_approvers").map(String).join(", ") || "no role yet"}</strong>. Everyone
          else may request a correction and it goes for approval.
        </p>
      </SectionCard>

      <SectionCard
        title="Assignment history"
        description="Every role a person has held, with the dates and the reason it changed. Nothing is overwritten."
      >
        <ul className="space-y-2 text-sm">
          {(history.data ?? []).slice(0, 25).map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-2 border-b pb-2 last:border-0">
              <StatusPill tone={h.assignment_status === "active" ? "success" : "default"}>
                {h.assignment_status}
              </StatusPill>
              <span className="font-medium">{h.role_name_at_time}</span>
              {h.department_name_at_time ? (
                <span className="text-muted-foreground">· {h.department_name_at_time}</span>
              ) : null}
              <span className="text-muted-foreground">
                {new Date(h.effective_from).toLocaleDateString()} →{" "}
                {h.effective_until ? new Date(h.effective_until).toLocaleDateString() : "current"}
              </span>
              {h.change_reason ? <span className="text-muted-foreground">— {h.change_reason}</span> : null}
            </li>
          ))}
          {(history.data ?? []).length === 0 ? (
            <li className="text-muted-foreground">Awaiting data — history is written as changes are applied.</li>
          ) : null}
        </ul>
      </SectionCard>
    </div>
  );
}

function Findings({ label, values }: { label: string; values: string[] }) {
  return (
    <div>
      <p className="text-sm font-medium">{label}</p>
      {values.length === 0 ? (
        <p className="text-sm text-muted-foreground">None</p>
      ) : (
        <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
          {values.slice(0, 8).map((v) => (
            <li key={v}>{v}</li>
          ))}
          {values.length > 8 ? <li>+{values.length - 8} more</li> : null}
        </ul>
      )}
    </div>
  );
}

function ItemCard({
  item,
  decide,
  review = false,
}: {
  item: MigrationItem;
  decide: (input: { item: string; decision: string; reason?: string }) => void;
  review?: boolean;
}) {
  return (
    <div className="rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">{item.subject_label}</p>
          <p className="text-sm text-muted-foreground">{item.migration_reason}</p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill
            tone={item.decision === "approved" ? "success" : item.decision === "rejected" ? "destructive" : "default"}
          >
            {item.decision}
          </StatusPill>
          <Button size="sm" variant="outline" onClick={() => decide({ item: item.id, decision: "rejected" })}>
            Keep as is
          </Button>
          <Button size="sm" onClick={() => decide({ item: item.id, decision: "approved" })}>
            {review ? "Confirm move" : "Approve"}
          </Button>
        </div>
      </div>

      <div className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
        <PermList label="Gains" values={item.permissions_gained} tone="text-emerald-600" />
        <PermList label="Keeps" values={item.permissions_retained} tone="text-muted-foreground" />
        <PermList label="Loses" values={item.permissions_removed} tone="text-amber-600" />
      </div>

      {item.restricted_authority_change !== "none" ? (
        <p className="mt-3 flex items-center gap-1 text-xs text-amber-600">
          <ShieldAlert className="h-3 w-3" />
          Restricted approval authority will be {item.restricted_authority_change}.
        </p>
      ) : null}
      {item.manager_candidate ? (
        <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
          <ArrowRight className="h-3 w-3" />
          May be set as department manager if that position is vacant.
        </p>
      ) : null}
    </div>
  );
}

function PermList({ label, values, tone }: { label: string; values: string[]; tone: string }) {
  const items = Array.isArray(values) ? values : [];
  return (
    <div>
      <p className={`font-medium ${tone}`}>
        {label} ({items.length})
      </p>
      <p className="text-muted-foreground">{items.slice(0, 6).join(", ") || "—"}</p>
    </div>
  );
}
