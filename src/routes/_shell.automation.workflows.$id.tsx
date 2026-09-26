import { useEffect, useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { FlaskConical, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import {
  ACTION_TYPES,
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  statusTone,
  titleCase,
  useAutomationRefresh,
  useDomainEvents,
  useWorkflow,
  type WorkflowAction,
  type WorkflowCondition,
} from "@/lib/automation";
import { testWorkflow } from "@/lib/automation.functions";
import { EmptyState, LoadingState } from "@/components/common/StateSystem";

export const Route = createFileRoute("/_shell/automation/workflows/$id")({
  head: () => ({
    meta: [
      { title: "Workflow Builder — Automation Centre" },
      {
        name: "description",
        content: "Configure triggers, conditions, actions, versions and test runs for a workflow.",
      },
      { property: "og:title", content: "Workflow Builder — Automation Centre" },
      {
        property: "og:description",
        content: "Guided workflow builder with versioning and safe test mode.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type TestResult = Awaited<ReturnType<typeof testWorkflow>>;

function WorkflowDetail() {
  const { id } = useParams({ from: "/_shell/automation/workflows/$id" });
  const { profile, user, can, isAdmin } = useAuth();
  const { data, isLoading } = useWorkflow(id);
  const refresh = useAutomationRefresh();
  const runTest = useServerFn(testWorkflow);
  const recentEvents = useDomainEvents(100);

  const [conditions, setConditions] = useState<WorkflowCondition[]>([]);
  const [actions, setActions] = useState<WorkflowAction[]>([]);
  const [notes, setNotes] = useState("");
  const [testEventId, setTestEventId] = useState("");
  const [result, setResult] = useState<TestResult | null>(null);

  const definition = data?.definition as
    | {
        id: string;
        name: string;
        description: string | null;
        status: string;
        trigger_event: string | null;
        current_version: number;
        published_version: number | null;
      }
    | null
    | undefined;
  const versions = (data?.versions ?? []) as {
    id: string;
    version: number;
    conditions: unknown;
    actions: unknown;
    notes: string | null;
    published: boolean;
    created_at: string;
  }[];
  const draft = versions.find((v) => !v.published) ?? versions[0];

  useEffect(() => {
    if (!draft) return;
    setConditions((draft.conditions as WorkflowCondition[]) ?? []);
    setActions((draft.actions as WorkflowAction[]) ?? []);
    setNotes(draft.notes ?? "");
  }, [draft?.id]);

  const matchingEvents = (
    (recentEvents.data ?? []) as { id: string; event_type: string; occurred_at: string }[]
  )
    .filter((e) => !definition?.trigger_event || e.event_type === definition.trigger_event)
    .slice(0, 20);

  const canEdit = can("automation", "edit");
  const canPublish = can("automation", "approve");

  async function saveDraft() {
    if (!draft || !profile?.organization_id) return;
    const { error } = await supabase
      .from("workflow_versions")
      .update({ conditions: conditions as never, actions: actions as never, notes })
      .eq("id", draft.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    await logAudit({
      organizationId: profile.organization_id,
      userId: user?.id ?? null,
      userName: profile.full_name,
      action: "automation.workflow.save-draft",
      module: "automation",
      recordId: id,
      newValue: { version: draft.version, actions: actions.length },
    });
    refresh();
    toast.success("Draft saved");
  }

  async function publish() {
    if (!draft || !definition || !profile?.organization_id) return;
    await supabase.from("workflow_versions").update({ published: true }).eq("id", draft.id);
    const { error } = await supabase
      .from("workflow_definitions")
      .update({
        status: "active",
        published_version: draft.version,
        current_version: draft.version,
        published_by: user?.id ?? null,
        published_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    await supabase.from("workflow_versions").insert({
      organization_id: profile.organization_id,
      workflow_id: id,
      version: draft.version + 1,
      trigger: { type: "event", event: definition.trigger_event },
      conditions: conditions as never,
      actions: actions as never,
      created_by: user?.id ?? null,
    });
    await logAudit({
      organizationId: profile.organization_id,
      userId: user?.id ?? null,
      userName: profile.full_name,
      action: "automation.workflow.publish",
      module: "automation",
      recordId: id,
      newValue: { version: draft.version },
    });
    refresh();
    toast.success(`Version ${draft.version} published and activated`);
  }

  async function setStatus(status: string) {
    if (!profile?.organization_id) return;
    const { error } = await supabase.from("workflow_definitions").update({ status }).eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    await logAudit({
      organizationId: profile.organization_id,
      userId: user?.id ?? null,
      userName: profile.full_name,
      action: `automation.workflow.${status}`,
      module: "automation",
      recordId: id,
      previousValue: { status: definition?.status },
      newValue: { status },
    });
    refresh();
    toast.success(`Workflow ${status}`);
  }

  async function test() {
    try {
      setResult(
        await runTest({
          data: {
            workflowId: id,
            eventId: testEventId === "latest" || !testEventId ? null : testEventId,
          },
        }),
      );
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Test failed");
    }
  }

  if (isLoading) return <LoadingState rows={5} />;
  if (!definition)
    return (
      <EmptyState title="Workflow not found" description="This workflow could not be found or may have been removed." />
    );

  return (
    <div>
      <PageHeader
        eyebrow="Automation & Communications"
        title={definition.name}
        description={
          definition.description ?? "Configure the conditions and actions this workflow performs."
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <StatusPill tone={statusTone(definition.status)}>
              {titleCase(definition.status)}
            </StatusPill>
            {canEdit ? (
              <Button variant="outline" onClick={saveDraft}>
                <Save className="size-4" /> Save draft
              </Button>
            ) : null}
            {canPublish && draft && !draft.published ? (
              <Button onClick={publish}>Publish v{draft.version}</Button>
            ) : null}
            {canEdit && definition.status === "active" ? (
              <Button variant="outline" onClick={() => setStatus("paused")}>
                Pause
              </Button>
            ) : null}
            {canEdit && definition.status === "paused" ? (
              <Button variant="outline" onClick={() => setStatus("active")}>
                Resume
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard
          title="Trigger"
          description="The recorded business event that starts this workflow."
        >
          <p className="text-sm font-medium">
            {definition.trigger_event ? titleCase(definition.trigger_event) : "Not set"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Published version {definition.published_version ?? "—"} · draft version{" "}
            {draft?.version ?? "—"}
          </p>
        </SectionCard>

        <SectionCard
          title="Test mode"
          description="Runs the workflow in simulation. No guest messages, tasks or approvals are created."
          actions={
            canEdit ? (
              <Button size="sm" variant="outline" onClick={test}>
                <FlaskConical className="size-4" /> Run test
              </Button>
            ) : null
          }
        >
          <Label>Recorded event to replay</Label>
          <Select value={testEventId} onValueChange={setTestEventId}>
            <SelectTrigger>
              <SelectValue placeholder="Most recent matching event" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="latest">Most recent matching event</SelectItem>
              {matchingEvents.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {new Date(e.occurred_at).toLocaleString()} · {titleCase(e.event_type)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {result ? (
            <div className="mt-3 space-y-2 rounded-lg border border-border p-3 text-sm">
              <StatusPill tone={result.matched ? "success" : "warning"}>
                {result.matched ? "Conditions matched" : "Conditions did not match"}
              </StatusPill>
              {result.warnings.map((w, i) => (
                <p key={i} className="text-xs text-on-tint-warning">
                  {w}
                </p>
              ))}
              <ul className="space-y-1 text-xs">
                {result.outcomes.map((o) => (
                  <li key={o.index} className="flex justify-between gap-2">
                    <span>
                      {o.index + 1}. {titleCase(o.type)}
                    </span>
                    <span className="text-muted-foreground">{o.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </SectionCard>
      </div>

      <SectionCard
        title="Conditions"
        className="mt-6"
        description="All conditions must be satisfied before the actions run."
        actions={
          canEdit ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setConditions([
                  ...conditions,
                  { field: "payload.status", operator: "eq", value: "" },
                ])
              }
            >
              <Plus className="size-4" /> Add condition
            </Button>
          ) : null
        }
      >
        {conditions.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No conditions — the workflow runs on every matching event.
          </p>
        ) : (
          <ul className="space-y-2">
            {conditions.map((c, index) => (
              <li key={index} className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
                <Select
                  value={c.field}
                  onValueChange={(v) =>
                    setConditions(conditions.map((x, i) => (i === index ? { ...x, field: v } : x)))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONDITION_FIELDS.map((f) => (
                      <SelectItem key={f} value={f}>
                        {titleCase(f.replace("payload.", ""))}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={c.operator}
                  onValueChange={(v) =>
                    setConditions(
                      conditions.map((x, i) => (i === index ? { ...x, operator: v } : x)),
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONDITION_OPERATORS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={c.value}
                  placeholder="Value"
                  onChange={(e) =>
                    setConditions(
                      conditions.map((x, i) => (i === index ? { ...x, value: e.target.value } : x)),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setConditions(conditions.filter((_, i) => i !== index))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="Actions"
        className="mt-6"
        description="Actions run in order. Delayed actions are stored as scheduled actions and executed when due."
        actions={
          canEdit ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setActions([...actions, { type: "notify_role", config: {} }])}
            >
              <Plus className="size-4" /> Add action
            </Button>
          ) : null
        }
      >
        {actions.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No actions configured yet.
          </p>
        ) : (
          <ul className="space-y-3">
            {actions.map((a, index) => (
              <li key={index} className="rounded-lg border border-border p-3">
                <div className="grid gap-2 md:grid-cols-[2fr_1fr_auto]">
                  <Select
                    value={a.type}
                    onValueChange={(v) =>
                      setActions(
                        actions.map((x, i) =>
                          i === index ? { ...x, type: v as WorkflowAction["type"] } : x,
                        ),
                      )
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ACTION_TYPES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    min={0}
                    placeholder="Delay (minutes)"
                    value={a.delay_minutes ?? ""}
                    onChange={(e) =>
                      setActions(
                        actions.map((x, i) =>
                          i === index
                            ? { ...x, delay_minutes: e.target.value ? Number(e.target.value) : 0 }
                            : x,
                        ),
                      )
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setActions(actions.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
                <Textarea
                  className="mt-2 font-mono text-xs"
                  rows={3}
                  value={JSON.stringify(a.config, null, 2)}
                  onChange={(e) => {
                    try {
                      const parsed = JSON.parse(e.target.value) as Record<string, unknown>;
                      setActions(
                        actions.map((x, i) => (i === index ? { ...x, config: parsed } : x)),
                      );
                    } catch {
                      /* keep last valid configuration until JSON is complete */
                    }
                  }}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Configuration keys depend on the action: role_name, user_id, department_id,
                  template_key, channel, title, body, category, priority, due_in_minutes,
                  approval_type, reason.
                </p>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Version history" className="mt-6">
        <ul className="divide-y divide-border text-sm">
          {versions.map((v) => (
            <li key={v.id} className="flex items-center justify-between py-2">
              <span>
                Version {v.version} · {new Date(v.created_at).toLocaleString()}
              </span>
              <StatusPill tone={v.published ? "success" : "default"}>
                {v.published ? "Published" : "Draft"}
              </StatusPill>
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard title="Recent runs" className="mt-6">
        {(data?.runs ?? []).length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            This workflow has not run yet.
          </p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {(data?.runs ?? []).map((r) => {
              const row = r as unknown as {
                id: string;
                status: string;
                mode: string;
                started_at: string;
                actions_completed: number;
                actions_total: number;
                error_message: string | null;
              };
              return (
                <li key={row.id} className="flex items-center justify-between gap-3 py-2">
                  <div>
                    <p>{new Date(row.started_at).toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.mode} · {row.actions_completed}/{row.actions_total} actions
                      {row.error_message ? ` · ${row.error_message}` : ""}
                    </p>
                  </div>
                  <StatusPill tone={statusTone(row.status)}>{titleCase(row.status)}</StatusPill>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/automation/workflows">
      <WorkflowDetail />
    </OpsGuard>
  );
}
