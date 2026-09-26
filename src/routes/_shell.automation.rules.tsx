import { useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { toast } from "sonner";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useScopedDepartments } from "@/lib/scoped-options";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { EmptyState, LoadingState } from "@/components/common/StateSystem";
import {
  EVENT_CATALOGUE,
  titleCase,
  useAutomationRefresh,
  useEscalationPolicies,
  useFeedbackRules,
  useNotificationRules,
  useTaskAssignmentRules,
} from "@/lib/automation";

export const Route = createFileRoute("/_shell/automation/rules")({
  head: () => ({
    meta: [
      { title: "Rules & Escalations — Automation Centre" },
      {
        name: "description",
        content:
          "Task assignment rules, escalation policies, notification routing and feedback automation.",
      },
      { property: "og:title", content: "Rules & Escalations — Automation Centre" },
      {
        property: "og:description",
        content: "Configure who is assigned, who is notified and when work escalates.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

function RulesPage() {
  const { profile, user, can, isAdmin } = useAuth();
  const refresh = useAutomationRefresh();
  const taskRules = useTaskAssignmentRules();
  const policies = useEscalationPolicies();
  const notificationRules = useNotificationRules();
  const feedbackRules = useFeedbackRules();
  const canEdit = can("automation", "edit");

  const scopedDepartments = useScopedDepartments();
  const rolesQuery = useQuery({
    queryKey: ["automation", "rule-roles"],
    queryFn: async () => {
      const { data } = await supabase.from("roles").select("id, name").order("name");
      return data ?? [];
    },
  });
  // Departments follow the active property; roles are organisation-wide by design.
  const lookups = {
    isLoading: scopedDepartments.isLoading || rolesQuery.isLoading,
    data: {
      departments: scopedDepartments.data ?? [],
      roles: rolesQuery.data ?? [],
    },
  };

  const [taskForm, setTaskForm] = useState({
    name: "",
    event_type: "",
    department_id: "",
    role_id: "",
    due_in_minutes: 60,
    priority: "normal",
  });
  const [policyForm, setPolicyForm] = useState({
    name: "",
    applies_to: "task",
    minutes: 30,
    levels: 3,
  });
  const [notifyForm, setNotifyForm] = useState({
    name: "",
    event_type: "",
    role_id: "",
    priority: "normal",
  });

  async function createTaskRule() {
    if (!profile?.organization_id || !taskForm.name.trim() || !taskForm.event_type) return;
    const { error } = await supabase.from("task_assignment_rules").insert({
      organization_id: profile.organization_id,
      name: taskForm.name.trim(),
      event_type: taskForm.event_type,
      department_id: taskForm.department_id || null,
      assignee_role_id: taskForm.role_id || null,
      strategy: taskForm.role_id ? "role" : "department",
      due_in_minutes: taskForm.due_in_minutes,
      priority: taskForm.priority,
      active: true,
      created_by: user?.id ?? null,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    await logAudit({
      organizationId: profile.organization_id,
      userId: user?.id ?? null,
      userName: profile.full_name,
      action: "automation.task-rule.create",
      module: "automation",
      newValue: { name: taskForm.name, event: taskForm.event_type },
    });
    setTaskForm({ ...taskForm, name: "" });
    refresh();
    toast.success("Assignment rule created");
  }

  async function createPolicy() {
    if (!profile?.organization_id || !policyForm.name.trim()) return;
    const levels = Array.from({ length: policyForm.levels }, (_, i) => ({
      level: i + 1,
      after_minutes: policyForm.minutes * (i + 1),
      notify: i === 0 ? "supervisor" : i === 1 ? "department-head" : "management",
    }));
    const { error } = await supabase.from("escalation_policies").insert({
      organization_id: profile.organization_id,
      name: policyForm.name.trim(),
      applies_to: policyForm.applies_to,
      levels: levels as never,
      max_level: policyForm.levels,
      respect_business_hours: true,
      pause_when_waiting: true,
      active: true,
      created_by: user?.id ?? null,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    setPolicyForm({ ...policyForm, name: "" });
    refresh();
    toast.success("Escalation policy created");
  }

  async function createNotificationRule() {
    if (!profile?.organization_id || !notifyForm.name.trim() || !notifyForm.event_type) return;
    const { error } = await supabase.from("notification_rules").insert({
      organization_id: profile.organization_id,
      name: notifyForm.name.trim(),
      event_type: notifyForm.event_type,
      recipient_strategy: notifyForm.role_id ? "role" : "department",
      recipient_role_id: notifyForm.role_id || null,
      category: "automation",
      priority: notifyForm.priority,
      title_template: notifyForm.name.trim(),
      body_template: "{{event_summary}}",
      active: true,
      created_by: user?.id ?? null,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    setNotifyForm({ ...notifyForm, name: "" });
    refresh();
    toast.success("Notification rule created");
  }

  const liveEvents = EVENT_CATALOGUE.filter((e) => e.live);

  return (
    <div>
      <PageHeader
        eyebrow="Automation & Communications"
        title="Rules & escalations"
        description="These rules extend the existing Task Management and Approval Centre rather than replacing them."
      />

      <Tabs defaultValue="tasks">
        <TabsList className="flex flex-wrap">
          <TabsTrigger value="tasks">Task assignment</TabsTrigger>
          <TabsTrigger value="escalations">Escalation policies</TabsTrigger>
          <TabsTrigger value="notifications">Notification routing</TabsTrigger>
          <TabsTrigger value="feedback">Feedback automation</TabsTrigger>
        </TabsList>

        <TabsContent value="tasks" className="pt-4">
          <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
            <SectionCard title="Assignment rules">
              {taskRules.isLoading ? (
                <LoadingState rows={3} />
              ) : (taskRules.data ?? []).length === 0 ? (
                <EmptyState inline title="No assignment rules" description="No task assignment rules have been created yet." />
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {(taskRules.data ?? []).map((r) => (
                    <li key={r.id} className="flex items-center justify-between py-2">
                      <div>
                        <p className="font-medium">{r.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {titleCase(r.event_type ?? "")} · {titleCase(r.strategy ?? "")} · due in{" "}
                          {r.due_in_minutes} min
                        </p>
                      </div>
                      <StatusPill tone={r.active ? "success" : "default"}>
                        {r.active ? "Active" : "Inactive"}
                      </StatusPill>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
            {canEdit ? (
              <SectionCard title="New assignment rule">
                <div className="space-y-3">
                  <div>
                    <Label>Name</Label>
                    <Input
                      value={taskForm.name}
                      onChange={(e) => setTaskForm({ ...taskForm, name: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Event</Label>
                    <Select
                      value={taskForm.event_type}
                      onValueChange={(v) => setTaskForm({ ...taskForm, event_type: v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select event" />
                      </SelectTrigger>
                      <SelectContent>
                        {liveEvents.map((e) => (
                          <SelectItem key={e.type} value={e.type}>
                            {e.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Department</Label>
                    <Select
                      value={taskForm.department_id}
                      onValueChange={(v) => setTaskForm({ ...taskForm, department_id: v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select department" />
                      </SelectTrigger>
                      <SelectContent>
                        {(lookups.data?.departments ?? []).map((d) => (
                          <SelectItem key={d.id} value={d.id}>
                            {d.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Assign to role</Label>
                    <Select
                      value={taskForm.role_id}
                      onValueChange={(v) => setTaskForm({ ...taskForm, role_id: v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select role" />
                      </SelectTrigger>
                      <SelectContent>
                        {(lookups.data?.roles ?? []).map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Due in (minutes)</Label>
                      <Input
                        type="number"
                        value={taskForm.due_in_minutes}
                        onChange={(e) =>
                          setTaskForm({ ...taskForm, due_in_minutes: Number(e.target.value) })
                        }
                      />
                    </div>
                    <div>
                      <Label>Priority</Label>
                      <Select
                        value={taskForm.priority}
                        onValueChange={(v) => setTaskForm({ ...taskForm, priority: v })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {["low", "normal", "high", "urgent"].map((p) => (
                            <SelectItem key={p} value={p}>
                              {titleCase(p)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <Button
                    onClick={createTaskRule}
                    disabled={!taskForm.name.trim() || !taskForm.event_type}
                  >
                    <Plus className="size-4" /> Create rule
                  </Button>
                </div>
              </SectionCard>
            ) : null}
          </div>
        </TabsContent>

        <TabsContent value="escalations" className="pt-4">
          <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
            <SectionCard title="Escalation policies">
              {(policies.data ?? []).length === 0 ? (
                <EmptyState inline title="No escalation policies" description="No escalation policies have been created yet." />
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {(policies.data ?? []).map((p) => (
                    <li key={p.id} className="flex items-center justify-between py-2">
                      <div>
                        <p className="font-medium">{p.name}</p>
                        <p className="text-xs text-muted-foreground">
                          Applies to {titleCase(p.applies_to ?? "")} · {p.max_level} level(s)
                        </p>
                      </div>
                      <StatusPill tone={p.active ? "success" : "default"}>
                        {p.active ? "Active" : "Inactive"}
                      </StatusPill>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
            {canEdit ? (
              <SectionCard title="New escalation policy">
                <div className="space-y-3">
                  <div>
                    <Label>Name</Label>
                    <Input
                      value={policyForm.name}
                      onChange={(e) => setPolicyForm({ ...policyForm, name: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Applies to</Label>
                    <Select
                      value={policyForm.applies_to}
                      onValueChange={(v) => setPolicyForm({ ...policyForm, applies_to: v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {["task", "approval", "guest-request", "complaint"].map((a) => (
                          <SelectItem key={a} value={a}>
                            {titleCase(a)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Escalate every (minutes)</Label>
                      <Input
                        type="number"
                        value={policyForm.minutes}
                        onChange={(e) =>
                          setPolicyForm({ ...policyForm, minutes: Number(e.target.value) })
                        }
                      />
                    </div>
                    <div>
                      <Label>Levels</Label>
                      <Input
                        type="number"
                        min={1}
                        max={5}
                        value={policyForm.levels}
                        onChange={(e) =>
                          setPolicyForm({ ...policyForm, levels: Number(e.target.value) })
                        }
                      />
                    </div>
                  </div>
                  <Button onClick={createPolicy} disabled={!policyForm.name.trim()}>
                    <Plus className="size-4" /> Create policy
                  </Button>
                </div>
              </SectionCard>
            ) : null}
          </div>
        </TabsContent>

        <TabsContent value="notifications" className="pt-4">
          <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
            <SectionCard title="Notification routing">
              {(notificationRules.data ?? []).length === 0 ? (
                <EmptyState inline title="No notification rules" description="No notification routing rules have been created yet." />
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {(notificationRules.data ?? []).map((r) => (
                    <li key={r.id} className="flex items-center justify-between py-2">
                      <div>
                        <p className="font-medium">{r.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {titleCase(r.event_type ?? "")} · {titleCase(r.recipient_strategy ?? "")}{" "}
                          · {titleCase(r.priority ?? "")}
                        </p>
                      </div>
                      <StatusPill tone={r.active ? "success" : "default"}>
                        {r.active ? "Active" : "Inactive"}
                      </StatusPill>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
            {canEdit ? (
              <SectionCard title="New notification rule">
                <div className="space-y-3">
                  <div>
                    <Label>Name</Label>
                    <Input
                      value={notifyForm.name}
                      onChange={(e) => setNotifyForm({ ...notifyForm, name: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Event</Label>
                    <Select
                      value={notifyForm.event_type}
                      onValueChange={(v) => setNotifyForm({ ...notifyForm, event_type: v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select event" />
                      </SelectTrigger>
                      <SelectContent>
                        {liveEvents.map((e) => (
                          <SelectItem key={e.type} value={e.type}>
                            {e.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Notify role</Label>
                    <Select
                      value={notifyForm.role_id}
                      onValueChange={(v) => setNotifyForm({ ...notifyForm, role_id: v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select role" />
                      </SelectTrigger>
                      <SelectContent>
                        {(lookups.data?.roles ?? []).map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    onClick={createNotificationRule}
                    disabled={!notifyForm.name.trim() || !notifyForm.event_type}
                  >
                    <Plus className="size-4" /> Create rule
                  </Button>
                </div>
              </SectionCard>
            ) : null}
          </div>
        </TabsContent>

        <TabsContent value="feedback" className="pt-4">
          <SectionCard
            title="Feedback automation rules"
            description="Automatic feedback invitations and complaint routing."
          >
            {feedbackRules.isLoading ? (
              <LoadingState rows={3} />
            ) : (feedbackRules.data ?? []).length === 0 ? (
              <EmptyState
                inline
                title="No feedback automation rules"
                description="Add a workflow action “Create a feedback invitation” to request reviews automatically after checkout."
              />
            ) : (
              <ul className="divide-y divide-border text-sm">
                {(feedbackRules.data ?? []).map((r) => (
                  <li key={r.id} className="flex items-center justify-between py-2">
                    <div>
                      <p className="font-medium">{r.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {titleCase(r.trigger_event ?? "")} · {titleCase(r.channel ?? "")} · after{" "}
                        {r.delay_minutes} min
                      </p>
                    </div>
                    <StatusPill tone={r.active ? "success" : "default"}>
                      {r.active ? "Active" : "Inactive"}
                    </StatusPill>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/automation/rules">
      <RulesPage />
    </OpsGuard>
  );
}
