import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import { toast } from "sonner";
import { PageHeader, StatusPill } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import { LaneBoard, type Lane } from "@/components/common/LaneBoard";
import {
  InspectorField,
  InspectorSection,
  InspectorSheet,
} from "@/components/common/InspectorSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { useWriteBranchId } from "@/lib/branch-filter";
import { logAudit } from "@/lib/audit";
import {
  FEEDBACK_PRIORITIES,
  FEEDBACK_STATUSES,
  FEEDBACK_TYPES,
  recordTimelineEvent,
  referenceFor,
  titleCase,
  useCustomers,
  useFeedback,
  useInvalidateCrm,
} from "@/lib/crm";

export const Route = createFileRoute("/_shell/crm/feedback")({
  head: () => ({
    meta: [
      { title: "Feedback & Complaints — Guest CRM" },
      {
        name: "description",
        content:
          "Log reviews, complaints, compliments and suggestions with assignment, response timing and resolution tracking.",
      },
      { property: "og:title", content: "Feedback & Complaints — Guest CRM" },
      { property: "og:description", content: "Guest feedback and service recovery workflow." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type FeedbackRow = {
  id: string;
  reference: string;
  subject: string;
  description: string;
  feedback_type: string;
  status: string;
  priority: string;
  assigned_user_id: string | null;
  received_at: string;
  resolution_due_at: string | null;
  resolved_at: string | null;
  first_response_at: string | null;
  customers: { full_name: string } | null;
};

/** Lanes mirror the real feedback lifecycle so triage happens on one board. */
const LANES: { id: string; label: string; tone: "default" | "warning" | "info" | "success" }[] = [
  { id: "new", label: "New", tone: "info" },
  { id: "acknowledged", label: "Acknowledged", tone: "warning" },
  { id: "assigned", label: "Assigned", tone: "warning" },
  { id: "investigating", label: "Investigating", tone: "warning" },
  { id: "waiting-customer", label: "Waiting on customer", tone: "info" },
  { id: "resolved", label: "Resolved", tone: "success" },
  { id: "closed", label: "Closed", tone: "success" },
  { id: "reopened", label: "Reopened", tone: "warning" },
];

function Page() {
  const { profile, user, isAdmin, can } = useAuth();
  const writeBranchId = useWriteBranchId();
  const invalidate = useInvalidateCrm();
  const { data, refetch } = useFeedback();
  const customers = useCustomers();
  const [form, setForm] = useState({
    customerId: "",
    type: "complaint",
    subject: "",
    description: "",
    priority: "normal",
    rating: "",
  });
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [lens, setLens] = useState<"none" | "overdue" | "mine" | "unresolved">("none");

  const canManage = can("crm-feedback", "edit");
  const now = Date.now();
  const rows = (data ?? []).map((r) => r as unknown as FeedbackRow);

  const overdue = rows.filter(
    (r) =>
      !["resolved", "closed"].includes(r.status) &&
      r.resolution_due_at !== null &&
      new Date(r.resolution_due_at).getTime() < now,
  );
  const mine = rows.filter((r) => r.assigned_user_id === user?.id);
  const unresolved = rows.filter((r) => !["resolved", "closed"].includes(r.status));

  const toggleLens = (next: typeof lens) => setLens((prev) => (prev === next ? "none" : next));

  const filtered = useMemo(() => {
    if (lens === "overdue") return overdue;
    if (lens === "mine") return mine;
    if (lens === "unresolved") return unresolved;
    return rows;
  }, [lens, rows, overdue, mine, unresolved]);

  const lanes: Lane<FeedbackRow>[] = LANES.map((l) => ({
    id: l.id,
    label: l.label,
    tone: l.tone,
    items: filtered.filter((r) => r.status === l.id),
  }));

  const inspected = rows.find((r) => r.id === inspectId) ?? null;

  async function createCase() {
    if (!profile?.organization_id || !form.subject.trim()) return;
    const due = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    const { data: created, error } = await supabase
      .from("customer_feedback")
      .insert({
        organization_id: profile.organization_id,
        branch_id: writeBranchId,
        customer_id: form.customerId || null,
        reference: referenceFor("FBK"),
        feedback_type: form.type,
        source: "staff-entry",
        subject: form.subject.trim(),
        description: form.description.trim(),
        priority: form.priority,
        rating: form.rating ? Number(form.rating) : null,
        resolution_due_at: form.type === "complaint" ? due : null,
        created_by: user?.id ?? null,
      })
      .select("id, reference")
      .single();
    if (error) {
      toast.error(error.message);
      return;
    }
    if (form.type === "complaint") {
      const { data: task } = await supabase
        .from("tasks")
        .insert({
          organization_id: profile.organization_id,
          branch_id: writeBranchId,
          department_id: profile.department_id,
          reference: referenceFor("TSK"),
          title: `Resolve complaint ${created.reference}`,
          description: form.subject.trim(),
          priority: form.priority === "urgent" ? "high" : form.priority,
          due_at: due,
          created_by: user?.id ?? null,
        })
        .select("id")
        .single();
      if (task)
        await supabase.from("customer_feedback").update({ task_id: task.id }).eq("id", created.id);
      await supabase.from("notifications").insert({
        organization_id: profile.organization_id,
        category: "complaint",
        title: "New complaint recorded",
        body: `${created.reference}: ${form.subject.trim()}`,
        priority: form.priority === "urgent" ? "high" : "normal",
        link: "/crm/feedback",
      });
    }
    if (form.customerId) {
      await recordTimelineEvent({
        organizationId: profile.organization_id,
        customerId: form.customerId,
        eventType: form.type === "complaint" ? "complaint-opened" : "feedback-submitted",
        description: form.subject.trim(),
        staffUserId: user?.id ?? null,
        customerVisible: true,
      });
    }
    await logAudit({
      organizationId: profile.organization_id,
      userId: user?.id ?? null,
      userName: profile.full_name,
      action: "crm.feedback.create",
      module: "crm-feedback",
      recordId: created.id,
      newValue: { type: form.type, priority: form.priority },
    });
    setForm({
      customerId: "",
      type: "complaint",
      subject: "",
      description: "",
      priority: "normal",
      rating: "",
    });
    void refetch();
    invalidate();
    toast.success("Case recorded with task and notification");
  }

  async function updateStatus(id: string, status: string) {
    if (!profile?.organization_id) return;
    const nowIso = new Date().toISOString();
    const patch = {
      status,
      ...(status === "acknowledged" ? { first_response_at: nowIso } : {}),
      ...(status === "resolved" ? { resolved_at: nowIso } : {}),
      ...(status === "closed" ? { closed_at: nowIso } : {}),
    };
    const { error } = await supabase.from("customer_feedback").update(patch).eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    await supabase.from("complaint_actions").insert({
      organization_id: profile.organization_id,
      feedback_id: id,
      action: `status-${status}`,
      comment: `Status changed to ${status}`,
      actor_id: user?.id ?? null,
    });
    await logAudit({
      organizationId: profile.organization_id,
      userId: user?.id ?? null,
      userName: profile.full_name,
      action: "crm.feedback.status",
      module: "crm-feedback",
      recordId: id,
      newValue: { status },
    });
    void refetch();
    invalidate();
    toast.success(`Case ${status}`);
  }

  const leadFigure: SummaryFigure = {
    id: "total",
    label: "Cases",
    value: rows.length,
  };
  const figures: SummaryFigure[] = [
    {
      id: "unresolved",
      label: "Open",
      value: unresolved.length,
      tone: unresolved.length ? "warning" : "success",
      onSelect: () => toggleLens("unresolved"),
      active: lens === "unresolved",
    },
    {
      id: "overdue",
      label: "Overdue",
      value: overdue.length,
      tone: overdue.length ? "destructive" : "success",
      onSelect: () => toggleLens("overdue"),
      active: lens === "overdue",
    },
    {
      id: "mine",
      label: "My cases",
      value: mine.length,
      tone: "info",
      onSelect: () => toggleLens("mine"),
      active: lens === "mine",
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Guest CRM"
        title="Feedback & Complaints"
        description="Complaints automatically create a task and a notification. Internal discussion is never visible to the customer."
      />

      <SummaryStrip lead={leadFigure} figures={figures} />

      <div className="surface-panel mb-6 rounded-2xl p-4 sm:p-5">
        <h2 className="mb-3 text-sm font-semibold">Record feedback</h2>
        <div className="grid gap-3 md:grid-cols-4">
          <Select
            value={form.customerId}
            onValueChange={(v) => setForm({ ...form, customerId: v })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Customer (optional)" />
            </SelectTrigger>
            <SelectContent>
              {(customers.data ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.full_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FEEDBACK_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {titleCase(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={form.priority} onValueChange={(v) => setForm({ ...form, priority: v })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FEEDBACK_PRIORITIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {titleCase(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="number"
            min={1}
            max={5}
            placeholder="Rating 1-5 (optional)"
            value={form.rating}
            onChange={(e) => setForm({ ...form, rating: e.target.value })}
          />
        </div>
        <Input
          className="mt-3"
          placeholder="Subject"
          value={form.subject}
          onChange={(e) => setForm({ ...form, subject: e.target.value })}
        />
        <Textarea
          className="mt-3"
          rows={3}
          placeholder="Description"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
        <Button className="mt-3" onClick={createCase} disabled={!form.subject.trim()}>
          Record case
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No feedback recorded yet.
        </p>
      ) : (
        <LaneBoard
          lanes={lanes}
          getKey={(r) => r.id}
          emptyLaneLabel="No cases"
          renderItem={(r) => (
            <button
              type="button"
              onClick={() => setInspectId(r.id)}
              className="block w-full min-w-0 text-left"
            >
              <p className="neo-line-1 text-sm font-medium">{r.subject}</p>
              <p className="neo-line-1 mt-0.5 text-xs text-muted-foreground">
                {r.reference} · {r.customers?.full_name ?? "No linked customer"}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <StatusPill tone={r.priority === "urgent" ? "destructive" : "default"}>
                  {titleCase(r.priority)}
                </StatusPill>
                <StatusPill tone="info">{titleCase(r.feedback_type)}</StatusPill>
              </div>
            </button>
          )}
        />
      )}

      <InspectorSheet
        open={Boolean(inspected)}
        onOpenChange={(o) => !o && setInspectId(null)}
        title={inspected?.subject ?? ""}
        subtitle={inspected?.reference}
        chips={
          inspected ? (
            <>
              <StatusPill tone={["resolved", "closed"].includes(inspected.status) ? "success" : "warning"}>
                {titleCase(inspected.status)}
              </StatusPill>
              <StatusPill tone={inspected.priority === "urgent" ? "destructive" : "default"}>
                {titleCase(inspected.priority)}
              </StatusPill>
            </>
          ) : null
        }
        footer={
          inspected && canManage ? (
            <Select value={inspected.status} onValueChange={(v) => updateStatus(inspected.id, v)}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FEEDBACK_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null
        }
      >
        {inspected ? (
          <>
            <InspectorSection title="Case">
              <InspectorField label="Type">{titleCase(inspected.feedback_type)}</InspectorField>
              <InspectorField label="Customer">
                {inspected.customers?.full_name ?? "No linked customer"}
              </InspectorField>
              <InspectorField label="Received">
                {new Date(inspected.received_at).toLocaleString()}
              </InspectorField>
              <InspectorField label="Description">
                {inspected.description || "—"}
              </InspectorField>
            </InspectorSection>
            <InspectorSection title="Timing">
              <InspectorField label="First response">
                {inspected.first_response_at
                  ? `${Math.round(
                      (new Date(inspected.first_response_at).getTime() -
                        new Date(inspected.received_at).getTime()) /
                        60000,
                    )} min`
                  : "Not yet responded"}
              </InspectorField>
              <InspectorField label="Resolved">
                {inspected.resolved_at
                  ? `${Math.round(
                      (new Date(inspected.resolved_at).getTime() -
                        new Date(inspected.received_at).getTime()) /
                        3600000,
                    )} h`
                  : "Not yet resolved"}
              </InspectorField>
              <InspectorField label="Due">
                {inspected.resolution_due_at
                  ? new Date(inspected.resolution_due_at).toLocaleString()
                  : "No deadline"}
              </InspectorField>
            </InspectorSection>
          </>
        ) : null}
      </InspectorSheet>
    </div>
  );
}

// Money and customer records: the screen asks for the capability its route
// declares, so the menu and the page can never disagree.
function GuardedPage() {
  return (
    <OpsGuard path="/crm/feedback">
      <Page />
    </OpsGuard>
  );
}
