/**
 * Phase 6 — Automation & Communication vocabulary and data layer.
 *
 * Everything here reads the real Phase 6 tables. No message, delivery status,
 * task, approval or notification is ever fabricated: when a module has not
 * produced real operational records the screens render explicit empty states.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useActivePropertyFilter } from "@/lib/branch-filter";

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

export const WORKFLOW_STATUSES = ["draft", "testing", "active", "paused", "archived", "error"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const TRIGGER_TYPES = [
  { value: "event", label: "System event" },
  { value: "schedule", label: "Scheduled date/time" },
  { value: "relative_before", label: "Relative time before an event" },
  { value: "relative_after", label: "Relative time after an event" },
  { value: "threshold", label: "Threshold reached" },
  { value: "manual", label: "Manual authorised trigger" },
  { value: "webhook", label: "External verified webhook" },
] as const;

/**
 * Event catalogue. Only events emitted by modules that hold real operational
 * records are marked `live`; the rest are declared but never fired until the
 * owning module exists.
 */
export type CatalogueEvent = { type: string; label: string; group: string; live: boolean };

export const EVENT_CATALOGUE: CatalogueEvent[] = [
  // Reservations (live — Phase 5)
  { type: "reservation.created", label: "Reservation created", group: "Reservations", live: true },
  { type: "reservation.confirmed", label: "Reservation confirmed", group: "Reservations", live: true },
  { type: "reservation.modified", label: "Reservation modified", group: "Reservations", live: true },
  { type: "reservation.cancelled", label: "Reservation cancelled", group: "Reservations", live: true },
  { type: "reservation.no_show", label: "No show recorded", group: "Reservations", live: true },
  { type: "reservation.payment_status_changed", label: "Reservation payment status changed", group: "Reservations", live: true },
  { type: "stay.checked_in", label: "Guest checked in", group: "Reservations", live: true },
  { type: "stay.checked_out", label: "Guest checked out", group: "Reservations", live: true },
  // Finance (live)
  { type: "payment.confirmed", label: "Payment confirmed", group: "Payments & Finance", live: true },
  { type: "payment.failed", label: "Payment failed", group: "Payments & Finance", live: true },
  { type: "folio.room_charge_posted", label: "Room charge posted", group: "Payments & Finance", live: true },
  // Tasks & approvals (live — Phase 2)
  { type: "task.assigned", label: "Task assigned", group: "Tasks & Approvals", live: true },
  { type: "task.completed", label: "Task completed", group: "Tasks & Approvals", live: true },
  { type: "task.overdue", label: "Task overdue", group: "Tasks & Approvals", live: true },
  { type: "approval.requested", label: "Approval requested", group: "Tasks & Approvals", live: true },
  { type: "approval.approved", label: "Approval approved", group: "Tasks & Approvals", live: true },
  { type: "approval.rejected", label: "Approval rejected", group: "Tasks & Approvals", live: true },
  { type: "approval.overdue", label: "Approval overdue", group: "Tasks & Approvals", live: true },
  // CRM (live — Phase 4)
  { type: "customer.created", label: "Customer created", group: "CRM", live: true },
  { type: "feedback.received", label: "Feedback received", group: "CRM", live: true },
  { type: "complaint.resolved", label: "Complaint resolved", group: "CRM", live: true },
  // Awaiting the owning module
  { type: "order.created", label: "Restaurant order created", group: "Restaurant", live: true },
  { type: "pos.ticket_routed", label: "Station ticket routed", group: "Restaurant", live: true },
  { type: "order.delayed", label: "Restaurant order delayed", group: "Restaurant", live: false },
  { type: "event.confirmed", label: "Event confirmed", group: "Events", live: false },
  { type: "event.completed", label: "Event completed", group: "Events", live: false },
  { type: "delivery.completed", label: "Delivery completed", group: "Delivery", live: false },
  { type: "inventory.low_stock", label: "Low stock detected", group: "Inventory", live: false },
  { type: "purchase_request.created", label: "Purchase request created", group: "Procurement", live: false },
];

export const CONDITION_FIELDS = [
  "branch_id",
  "payload.status",
  "payload.payment_status",
  "payload.total_amount",
  "payload.balance",
  "payload.is_vip",
  "payload.rating",
  "payload.category",
  "payload.priority",
  "payload.amount",
  "payload.source_module",
] as const;

export const CONDITION_OPERATORS = [
  { value: "eq", label: "equals" },
  { value: "neq", label: "does not equal" },
  { value: "gt", label: "greater than" },
  { value: "gte", label: "greater or equal" },
  { value: "lt", label: "less than" },
  { value: "lte", label: "less or equal" },
  { value: "in", label: "is one of (comma separated)" },
  { value: "contains", label: "contains" },
  { value: "exists", label: "is present" },
] as const;

export const ACTION_TYPES = [
  { value: "notify_role", label: "Notify a role", needsProvider: false },
  { value: "notify_user", label: "Notify a specific user", needsProvider: false },
  { value: "notify_department", label: "Notify a department", needsProvider: false },
  { value: "create_task", label: "Create a task", needsProvider: false },
  { value: "create_approval", label: "Create an approval request", needsProvider: false },
  { value: "queue_message", label: "Send customer message (queued)", needsProvider: true },
  { value: "crm_timeline", label: "Add CRM timeline event", needsProvider: false },
  { value: "record_communication", label: "Record communication history", needsProvider: false },
  { value: "schedule_action", label: "Schedule a future action", needsProvider: false },
  { value: "feedback_invitation", label: "Create a feedback invitation", needsProvider: true },
  { value: "escalate", label: "Escalate", needsProvider: false },
] as const;
export type ActionType = (typeof ACTION_TYPES)[number]["value"];

export type WorkflowCondition = { field: string; operator: string; value: string };
export type WorkflowAction = {
  type: ActionType;
  delay_minutes?: number;
  config: Record<string, unknown>;
};

export const MESSAGE_CHANNELS = ["email", "whatsapp", "sms", "in-app"] as const;
export const TEMPLATE_CATEGORIES = [
  "reservation",
  "payment",
  "check-in",
  "checkout",
  "feedback",
  "loyalty",
  "events",
  "delivery",
  "corporate",
  "marketing",
  "internal-alert",
] as const;
export const TEMPLATE_STATUSES = [
  "draft",
  "under-review",
  "approved",
  "active",
  "paused",
  "archived",
  "provider-approval-pending",
] as const;

export const TEMPLATE_VARIABLES = [
  "guest_name",
  "booking_reference",
  "room_type",
  "arrival_date",
  "departure_date",
  "nights",
  "guests",
  "meal_plan",
  "amount_paid",
  "balance",
  "hotel_name",
  "branch_name",
  "branch_contact",
  "map_link",
  "check_in_time",
  "check_out_time",
  "cancellation_policy",
  "feedback_link",
  "guest_portal_link",
] as const;

export const PROVIDERS = [
  { key: "resend", name: "Resend", channel: "email", secrets: ["RESEND_API_KEY"] },
  { key: "whatsapp", name: "WhatsApp Business API", channel: "whatsapp", secrets: ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID"] },
  { key: "africastalking", name: "Africa's Talking", channel: "sms", secrets: ["AT_API_KEY", "AT_USERNAME"] },
  { key: "openai", name: "OpenAI", channel: "ai", secrets: ["OPENAI_API_KEY"] },
  { key: "push", name: "Push notifications (device delivery not configured)", channel: "push", secrets: [] },
] as const;

export const PROVIDER_STATUSES = [
  "not_configured",
  "configuration_incomplete",
  "connected",
  "degraded",
  "error",
  "disabled",
] as const;

export const SUPPRESSION_REASONS = [
  "unsubscribed",
  "invalid-contact",
  "repeated-failure",
  "customer-request",
  "compliance-restriction",
  "manual-suppression",
] as const;

export function titleCase(value: string) {
  return value
    .replace(/[._-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function extractVariables(body: string): string[] {
  return Array.from(new Set(Array.from(body.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)).map((m) => m[1] as string)));
}

/** Renders a template with safe sample labels — never real customer data. */
export function previewTemplate(body: string) {
  return body.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, name: string) => `[${titleCase(name)}]`);
}

export function statusTone(status: string): "success" | "warning" | "destructive" | "info" | "default" {
  const s = status.toLowerCase();
  if (["active", "connected", "sent", "delivered", "completed", "success", "resolved", "approved"].includes(s)) return "success";
  if (["paused", "queued", "scheduled", "pending", "testing", "processing", "retrying", "under-review", "degraded", "new"].includes(s))
    return "warning";
  if (["error", "failed", "rejected", "cancelled", "suppressed", "expired", "not_configured"].includes(s)) return "destructive";
  if (["draft", "archived"].includes(s)) return "default";
  return "info";
}

/* ------------------------------------------------------------------ */
/* Data hooks                                                          */
/* ------------------------------------------------------------------ */

function tenantQuery<T>(key: unknown[], run: () => Promise<T>, enabled = true) {
  return { queryKey: key, queryFn: run, enabled };
}

export function useWorkflows() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery(
    tenantQuery(
      ["automation", "workflows", filterKey], async () => {
      const { data, error } = await applyTo(supabase.from("workflow_definitions").select("*"), "workflow_definitions")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    }),
  );
}

export function useWorkflow(id: string) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery(
    tenantQuery(
      ["automation", "workflow", id, filterKey],
      async () => {
        const [def, versions, runs] = await Promise.all([
          applyTo(supabase.from("workflow_definitions").select("*"), "workflow_definitions").eq("id", id).maybeSingle(),
          supabase.from("workflow_versions").select("*").eq("workflow_id", id).order("version", { ascending: false }),
          applyTo(supabase.from("workflow_runs").select("*"), "workflow_runs").eq("workflow_id", id).order("started_at", { ascending: false }).limit(50),
        ]);
        if (def.error) throw def.error;
        return { definition: def.data, versions: versions.data ?? [], runs: runs.data ?? [] };
      },
      Boolean(id),
    ),
  );
}

export function useDomainEvents(limit = 100) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery(
    tenantQuery(
      ["automation", "events", limit, filterKey], async () => {
      const { data, error } = await applyTo(supabase.from("domain_events").select("*"), "domain_events")
        .order("occurred_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data ?? [];
    }),
  );
}

export function useWorkflowRuns(limit = 50) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery(
    tenantQuery(
      ["automation", "runs", limit, filterKey], async () => {
      const { data, error } = await applyTo(supabase.from("workflow_runs").select("*, workflow_definitions(name)"), "workflow_runs")
        .order("started_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data ?? [];
    }),
  );
}

export function useMessageTemplates() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery(
    tenantQuery(
      ["automation", "templates", filterKey], async () => {
      const { data, error } = await applyTo(supabase.from("message_templates").select("*"), "message_templates").order("name");
      if (error) throw error;
      return data ?? [];
    }),
  );
}

export function useCommunicationQueue() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery(
    tenantQuery(
      ["automation", "queue", filterKey], async () => {
      const { data, error } = await applyTo(supabase.from("communication_queue").select("*, customers(full_name)"), "communication_queue")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data ?? [];
    }),
  );
}

export function useProviderConnections() {
  return useQuery(
    tenantQuery(
      ["automation", "providers"], async () => {
      const { data, error } = await supabase.from("provider_connections").select("*").order("provider");
      if (error) throw error;
      return data ?? [];
    }),
  );
}

export function useWorkflowFailures() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery(
    tenantQuery(
      ["automation", "failures", filterKey], async () => {
      const { data, error } = await applyTo(supabase.from("workflow_failures").select("*, workflow_definitions(name)"), "workflow_failures")
        .order("last_failed_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data ?? [];
    }),
  );
}

export function useScheduledActions() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery(
    tenantQuery(
      ["automation", "scheduled", filterKey], async () => {
      const { data, error } = await applyTo(supabase.from("scheduled_actions").select("*"), "scheduled_actions")
        .order("scheduled_for", { ascending: true })
        .limit(200);
      if (error) throw error;
      return data ?? [];
    }),
  );
}

export function useEscalationPolicies() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery(
    tenantQuery(
      ["automation", "escalation-policies", filterKey], async () => {
      const { data, error } = await applyTo(supabase.from("escalation_policies").select("*"), "escalation_policies").order("name");
      if (error) throw error;
      return data ?? [];
    }),
  );
}

export function useEscalationEvents() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery(
    tenantQuery(
      ["automation", "escalation-events", filterKey], async () => {
      const { data, error } = await applyTo(supabase.from("escalation_events").select("*"), "escalation_events")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data ?? [];
    }),
  );
}

export function useTaskAssignmentRules() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery(
    tenantQuery(
      ["automation", "task-rules", filterKey], async () => {
      const { data, error } = await applyTo(supabase.from("task_assignment_rules").select("*"), "task_assignment_rules").order("name");
      if (error) throw error;
      return data ?? [];
    }),
  );
}

export function useFeedbackRules() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery(
    tenantQuery(
      ["automation", "feedback-rules", filterKey], async () => {
      const { data, error } = await applyTo(supabase.from("feedback_automation_rules").select("*"), "feedback_automation_rules").order("name");
      if (error) throw error;
      return data ?? [];
    }),
  );
}

export function useFeedbackInvitations() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery(
    tenantQuery(
      ["automation", "feedback-invitations", filterKey], async () => {
      const { data, error } = await applyTo(supabase.from("feedback_invitations").select("*, customers(full_name)"), "feedback_invitations")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data ?? [];
    }),
  );
}

export function useNotificationRules() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery(
    tenantQuery(
      ["automation", "notification-rules", filterKey], async () => {
      const { data, error } = await applyTo(supabase.from("notification_rules").select("*"), "notification_rules").order("name");
      if (error) throw error;
      return data ?? [];
    }),
  );
}

export function useAutomationSettings(organizationId: string | null) {
  return useQuery(
    tenantQuery(
      ["automation", "settings", organizationId],
      async () => {
        const { data, error } = await supabase.from("automation_settings").select("*").maybeSingle();
        if (error) throw error;
        return data;
      },
      Boolean(organizationId),
    ),
  );
}

export function useAutomationRefresh() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ["automation"] });
}
