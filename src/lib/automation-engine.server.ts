/**
 * Phase 6 — workflow engine (server only).
 *
 * The engine consumes durable `domain_events` rows written by database
 * triggers on real operational records, matches them against published
 * workflow versions, and performs the configured actions exactly once using
 * `automation_idempotency_keys`.
 *
 * It never invents operational data: messages are queued, and they only leave
 * the queue when a provider connection is genuinely configured.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  composeConfiguredMessage,
  findConfiguredTemplate,
  parseConfiguredTemplates,
  type ComposedMessage,
} from "@/lib/configured-communication-templates";

type Admin = SupabaseClient<Database>;

type EventRow = Database["public"]["Tables"]["domain_events"]["Row"];
type WorkflowRow = Database["public"]["Tables"]["workflow_definitions"]["Row"];

export type EngineMode = "live" | "test";

export type ActionOutcome = {
  index: number;
  type: string;
  status: "completed" | "skipped" | "failed" | "simulated";
  detail: string;
  result?: Record<string, string>;
};

type Condition = { field: string; operator: string; value: string };
type Action = { type: string; delay_minutes?: number; config: Record<string, unknown> };

function readField(event: EventRow, field: string): unknown {
  if (field.startsWith("payload.")) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    return payload[field.slice("payload.".length)];
  }
  return (event as unknown as Record<string, unknown>)[field];
}

export function evaluateConditions(event: EventRow, conditions: Condition[]): boolean {
  return conditions.every((c) => {
    const actual = readField(event, c.field);
    const expected = c.value;
    switch (c.operator) {
      case "eq":
        return String(actual ?? "") === expected;
      case "neq":
        return String(actual ?? "") !== expected;
      case "gt":
        return Number(actual) > Number(expected);
      case "gte":
        return Number(actual) >= Number(expected);
      case "lt":
        return Number(actual) < Number(expected);
      case "lte":
        return Number(actual) <= Number(expected);
      case "in":
        return expected.split(",").map((v) => v.trim()).includes(String(actual ?? ""));
      case "contains":
        return String(actual ?? "").toLowerCase().includes(expected.toLowerCase());
      case "exists":
        return actual !== null && actual !== undefined && actual !== "";
      default:
        return false;
    }
  });
}

/** Returns true when the key was newly claimed (i.e. the action may proceed). */
async function claimIdempotency(admin: Admin, org: string, scope: string, key: string) {
  const { error } = await admin
    .from("automation_idempotency_keys")
    .insert({ organization_id: org, scope, idempotency_key: key });
  if (error) return false;
  return true;
}

async function resolveRecipients(
  admin: Admin,
  org: string,
  action: Action,
): Promise<{ userIds: string[]; note: string }> {
  const config = action.config ?? {};
  if (action.type === "notify_user" && typeof config["user_id"] === "string") {
    return { userIds: [config["user_id"] as string], note: "specific user" };
  }
  if (action.type === "notify_role" && typeof config["role_id"] === "string") {
    const { data } = await admin.from("user_roles").select("user_id").eq("role_id", config["role_id"] as string);
    return { userIds: (data ?? []).map((r) => r.user_id), note: "role members" };
  }
  if (action.type === "notify_department" && typeof config["department_id"] === "string") {
    const { data } = await admin
      .from("profiles")
      .select("id")
      .eq("organization_id", org)
      .eq("department_id", config["department_id"] as string);
    return { userIds: (data ?? []).map((r) => r.id), note: "department members" };
  }
  return { userIds: [], note: "no recipient rule matched" };
}

function interpolate(text: string, event: EventRow): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  return text.replace(/{{\s*([a-zA-Z0-9_.]+)\s*}}/g, (_, name: string) => {
    const key = name.startsWith("payload.") ? name.slice(8) : name;
    const value = payload[key];
    return value === undefined || value === null ? `[${key}]` : String(value);
  });
}

async function executeAction(
  admin: Admin,
  event: EventRow,
  workflow: WorkflowRow,
  runId: string,
  action: Action,
  index: number,
  mode: EngineMode,
): Promise<ActionOutcome> {
  const org = event.organization_id;
  const config = (action.config ?? {}) as Record<string, unknown>;
  const idemKey = `${workflow.id}:${event.id}:${index}`;
  const str = (k: string, fallback = "") => (typeof config[k] === "string" ? (config[k] as string) : fallback);

  if (mode === "test") {
    return {
      index,
      type: action.type,
      status: "simulated",
      detail: `Test mode — would run "${action.type}". No customer contacted, no record changed.`,
    };
  }

  if (action.delay_minutes && action.delay_minutes > 0) {
    const claimed = await claimIdempotency(admin, org, "schedule", idemKey);
    if (!claimed) return { index, type: action.type, status: "skipped", detail: "Already scheduled" };
    await admin.from("scheduled_actions").insert({
      organization_id: org,
      branch_id: event.branch_id,
      workflow_id: workflow.id,
      run_id: runId,
      event_id: event.id,
      action_type: action.type,
      action_config: config as never,
      context: { event_type: event.event_type, payload: event.payload } as never,
      scheduled_for: new Date(Date.now() + action.delay_minutes * 60_000).toISOString(),
      idempotency_key: idemKey,
    });
    return { index, type: action.type, status: "completed", detail: `Scheduled in ${action.delay_minutes} min` };
  }

  const claimed = await claimIdempotency(admin, org, action.type, idemKey);
  if (!claimed) return { index, type: action.type, status: "skipped", detail: "Duplicate suppressed" };

  switch (action.type) {
    case "notify_role":
    case "notify_user":
    case "notify_department": {
      const { userIds, note } = await resolveRecipients(admin, org, action);
      if (!userIds.length) {
        return { index, type: action.type, status: "failed", detail: `No recipient resolved (${note})` };
      }
      const rows = userIds.map((uid) => ({
        organization_id: org,
        user_id: uid,
        branch_id: event.branch_id,
        department_id: (config["department_id"] as string) ?? null,
        category: str("category", "automation"),
        title: interpolate(str("title", workflow.name), event),
        body: interpolate(str("body", `${event.event_type} occurred.`), event),
        link: str("link") || null,
        priority: str("priority", "normal"),
      }));
      const { error } = await admin.from("notifications").insert(rows);
      if (error) throw new Error(error.message);
      return { index, type: action.type, status: "completed", detail: `Notified ${rows.length} recipient(s)` };
    }

    case "create_task": {
      const dueMinutes = Number(config["due_in_minutes"] ?? 120);
      const { data, error } = await admin
        .from("tasks")
        .insert({
          organization_id: org,
          branch_id: event.branch_id,
          department_id: (config["department_id"] as string) ?? null,
          station_id: (config["station_id"] as string) ?? null,
          reference: `AUTO-${event.id.slice(0, 8)}-${index}`,
          title: interpolate(str("title", `Automated task: ${workflow.name}`), event),
          description: interpolate(str("description", `Created by automation from ${event.event_type}.`), event),
          assignee_id: (config["assignee_id"] as string) ?? null,
          due_at: new Date(Date.now() + dueMinutes * 60_000).toISOString(),
          priority: str("priority", "normal"),
          status: "open",
        })
        .select("id, assignee_id, department_id")
        .single();
      if (error) throw new Error(error.message);
      if (!data.assignee_id) {
        // No eligible assignee: leave it in the department queue and tell the supervisor.
        const { data: dept } = await admin
          .from("departments")
          .select("manager_id")
          .eq("id", data.department_id ?? "")
          .maybeSingle();
        if (dept?.manager_id) {
          await admin.from("notifications").insert({
            organization_id: org,
            user_id: dept.manager_id,
            branch_id: event.branch_id,
            category: "automation",
            title: "Unassigned automated task",
            body: `A task created by "${workflow.name}" has no eligible assignee and is waiting in the department queue.`,
            link: "/tasks",
            priority: "high",
          });
        }
      }
      return { index, type: action.type, status: "completed", detail: "Task created", result: { task_id: data.id } };
    }

    case "create_approval": {
      const requesterId = (config["requester_id"] as string) ?? event.created_by;
      if (!requesterId) {
        return { index, type: action.type, status: "failed", detail: "No requester could be resolved for the approval" };
      }
      const { data, error } = await admin
        .from("approval_requests")
        .insert({
          organization_id: org,
          branch_id: event.branch_id,
          department_id: (config["department_id"] as string) ?? null,
          reference: `AUTO-APR-${event.id.slice(0, 8)}`,
          approval_type: str("approval_type", "general"),
          requester_id: requesterId,
          reason: interpolate(str("reason", `Raised automatically by ${workflow.name}`), event),
          amount: config["amount"] ? Number(config["amount"]) : null,
          status: "pending_approval",
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return { index, type: action.type, status: "completed", detail: "Approval requested", result: { approval_id: data.id } };
    }

    case "queue_message":
    case "feedback_invitation": {
      if (!event.customer_id) {
        return { index, type: action.type, status: "failed", detail: "No customer linked to this event" };
      }
      const { data: customer } = await admin
        .from("customers")
        .select("id, full_name, email, phone, marketing_consent, preferred_language")
        .eq("id", event.customer_id)
        .maybeSingle();
      if (!customer) return { index, type: action.type, status: "failed", detail: "Customer record not found" };

      const channel = str("channel", "email");
      const isMarketing = Boolean(config["is_marketing"]);
      const recipient = channel === "email" ? (customer.email ?? "") : (customer.phone ?? "");
      if (!recipient) {
        return { index, type: action.type, status: "failed", detail: `Customer has no ${channel} contact` };
      }
      if (isMarketing && !customer.marketing_consent) {
        await admin.from("communication_queue").insert({
          organization_id: org,
          branch_id: event.branch_id,
          customer_id: customer.id,
          channel,
          recipient,
          template_key: str("template_key"),
          is_marketing: true,
          consent_verified: false,
          status: "suppressed",
          suppression_reason: "unsubscribed",
          workflow_id: workflow.id,
          run_id: runId,
          source_module: event.source_module,
          idempotency_key: idemKey,
        });
        return { index, type: action.type, status: "skipped", detail: "Marketing consent not given — suppressed" };
      }

      const { data: template } = await admin
        .from("message_templates")
        .select("id, subject, body, status, is_marketing")
        .eq("organization_id", org)
        .eq("key", str("template_key"))
        .eq("channel", channel)
        .maybeSingle();

      // A hotel that branded this message in Administration → Communication
      // expects that wording to be what leaves the building. Without this the
      // queue silently fell back to the wording typed into the workflow action
      // and the customised template was never used by anything.
      let configured: ComposedMessage | null = null;
      if (!template) {
        const { data: settings } = await admin
          .from("organization_settings")
          .select("communication_templates")
          .eq("organization_id", org)
          .maybeSingle();
        const match = findConfiguredTemplate(
          parseConfiguredTemplates((settings as { communication_templates?: unknown } | null)?.communication_templates),
          str("template_key"),
          channel,
        );
        if (match) configured = composeConfiguredMessage(match, (text) => interpolate(text, event));
      }

      const { error } = await admin.from("communication_queue").insert({
        organization_id: org,
        branch_id: event.branch_id,
        customer_id: customer.id,
        template_id: template?.id ?? null,
        template_key: str("template_key"),
        channel,
        recipient,
        subject: template
          ? interpolate(template.subject, event)
          : (configured?.subject ?? str("subject")),
        rendered_body: template
          ? interpolate(template.body, event)
          : (configured?.body ?? interpolate(str("body"), event)),
        variables: (event.payload ?? {}) as never,
        is_marketing: isMarketing,
        consent_verified: !isMarketing || Boolean(customer.marketing_consent),
        scheduled_for: new Date().toISOString(),
        // A template the hotel enabled in Administration → Communication is an
        // approved template; it queues like any other rather than sitting in draft.
        status: (template && template.status === "active") || configured ? "queued" : "draft",
        workflow_id: workflow.id,
        run_id: runId,
        source_module: event.source_module,
        source_record_id: event.source_record_id,
        idempotency_key: idemKey,
      });
      if (error) throw new Error(error.message);

      if (action.type === "feedback_invitation") {
        await admin.from("feedback_invitations").insert({
          organization_id: org,
          branch_id: event.branch_id,
          customer_id: customer.id,
          source_module: event.source_module,
          source_record_id: event.source_record_id,
          channel,
          status: "scheduled",
          expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
          idempotency_key: idemKey,
        });
      }
      return {
        index,
        type: action.type,
        status: "completed",
        detail: template
          ? "Message queued from approved template"
          : configured
            ? "Message queued from the hotel's configured communication template"
            : "Queued as draft — no active template",
      };
    }

    case "crm_timeline": {
      if (!event.customer_id) return { index, type: action.type, status: "skipped", detail: "No customer on event" };
      const { error } = await admin.from("customer_timeline_events").insert({
        organization_id: org,
        customer_id: event.customer_id,
        branch_id: event.branch_id,
        event_type: event.event_type,
        description: interpolate(str("description", `${event.event_type} recorded automatically.`), event),
        source_module: event.source_module,
        source_record_id: event.source_record_id,
        customer_visible: Boolean(config["customer_visible"]),
      });
      if (error) throw new Error(error.message);
      return { index, type: action.type, status: "completed", detail: "Timeline event added" };
    }

    case "record_communication": {
      if (!event.customer_id) return { index, type: action.type, status: "skipped", detail: "No customer on event" };
      const { error } = await admin.from("customer_communications").insert({
        organization_id: org,
        branch_id: event.branch_id,
        customer_id: event.customer_id,
        channel: str("channel", "in-system"),
        direction: "outgoing",
        category: config["is_marketing"] ? "marketing" : "service",
        subject: interpolate(str("subject", workflow.name), event),
        summary: interpolate(str("summary", ""), event),
        delivery_status: "logged",
        is_marketing: Boolean(config["is_marketing"]),
        consent_verified: true,
        customer_visible: true,
        related_module: event.source_module,
      });
      if (error) throw new Error(error.message);
      return { index, type: action.type, status: "completed", detail: "Communication recorded" };
    }

    case "escalate": {
      const { error } = await admin.from("escalation_events").insert({
        organization_id: org,
        branch_id: event.branch_id,
        subject_type: event.source_module,
        subject_id: event.source_record_id ?? event.id,
        level: Number(config["level"] ?? 1),
        reason: interpolate(str("reason", `Escalated by ${workflow.name}`), event),
        notified_user_id: (config["user_id"] as string) ?? null,
        idempotency_key: idemKey,
      });
      if (error) throw new Error(error.message);
      return { index, type: action.type, status: "completed", detail: "Escalation raised" };
    }

    case "schedule_action":
    default:
      return { index, type: action.type, status: "skipped", detail: `Unsupported action "${action.type}"` };
  }
}

export type EngineReport = {
  eventsProcessed: number;
  runsCreated: number;
  actionsCompleted: number;
  failures: number;
  details: { event: string; workflow: string; outcomes: ActionOutcome[] }[];
};

export async function processDomainEvents(admin: Admin, org: string, limit = 25): Promise<EngineReport> {
  const report: EngineReport = { eventsProcessed: 0, runsCreated: 0, actionsCompleted: 0, failures: 0, details: [] };

  const { data: settings } = await admin
    .from("automation_settings")
    .select("automation_enabled")
    .eq("organization_id", org)
    .maybeSingle();
  if (settings && settings.automation_enabled === false) return report;

  const { data: events } = await admin
    .from("domain_events")
    .select("*")
    .eq("organization_id", org)
    .in("status", ["pending", "retrying"])
    .order("occurred_at", { ascending: true })
    .limit(limit);

  const { data: workflows } = await admin
    .from("workflow_definitions")
    .select("*")
    .eq("organization_id", org)
    .eq("status", "active");

  for (const event of events ?? []) {
    report.eventsProcessed += 1;
    const matching = (workflows ?? []).filter(
      (w) => w.trigger_event === event.event_type && (!w.branch_id || w.branch_id === event.branch_id),
    );

    let eventFailed = false;

    for (const workflow of matching) {
      const { data: version } = await admin
        .from("workflow_versions")
        .select("*")
        .eq("workflow_id", workflow.id)
        .eq("version", workflow.published_version ?? workflow.current_version)
        .maybeSingle();
      if (!version) continue;

      const conditions = (version.conditions ?? []) as unknown as Condition[];
      const actions = (version.actions ?? []) as unknown as Action[];
      const matched = evaluateConditions(event, conditions);

      const { data: run } = await admin
        .from("workflow_runs")
        .insert({
          organization_id: org,
          branch_id: event.branch_id,
          workflow_id: workflow.id,
          workflow_version: version.version,
          event_id: event.id,
          correlation_id: event.correlation_id,
          mode: "live",
          status: matched ? "running" : "skipped",
          matched,
          actions_total: matched ? actions.length : 0,
        })
        .select("id")
        .single();
      if (!run) continue;
      report.runsCreated += 1;
      if (!matched) {
        await admin
          .from("workflow_runs")
          .update({ status: "skipped", finished_at: new Date().toISOString() })
          .eq("id", run.id);
        continue;
      }

      const outcomes: ActionOutcome[] = [];
      let failed = false;

      for (let i = 0; i < actions.length; i += 1) {
        const action = actions[i] as Action;
        try {
          const outcome = await executeAction(admin, event, workflow, run.id, action, i, "live");
          outcomes.push(outcome);
          if (outcome.status === "completed") report.actionsCompleted += 1;
          if (outcome.status === "failed") failed = true;
          await admin.from("workflow_run_steps").insert({
            organization_id: org,
            run_id: run.id,
            step_index: i,
            action_type: action.type,
            status: outcome.status,
            detail: outcome.detail,
            result: (outcome.result ?? {}) as never,
            finished_at: new Date().toISOString(),
          });
        } catch (error) {
          failed = true;
          const message = error instanceof Error ? error.message : "Unknown error";
          outcomes.push({ index: i, type: action.type, status: "failed", detail: message });
          await admin.from("workflow_run_steps").insert({
            organization_id: org,
            run_id: run.id,
            step_index: i,
            action_type: action.type,
            status: "failed",
            detail: message,
            error_message: message,
            finished_at: new Date().toISOString(),
          });
          await admin.from("workflow_failures").insert({
            organization_id: org,
            branch_id: event.branch_id,
            workflow_id: workflow.id,
            run_id: run.id,
            event_id: event.id,
            step_index: i,
            error_category: "action_error",
            error_message: message,
            recommended_action: "Review the action configuration, then retry from Failed Workflows.",
          });
          break;
        }
      }

      await admin
        .from("workflow_runs")
        .update({
          status: failed ? "failed" : "completed",
          actions_completed: outcomes.filter((o) => o.status === "completed").length,
          finished_at: new Date().toISOString(),
        })
        .eq("id", run.id);

      await admin
        .from("workflow_definitions")
        .update({
          last_run_at: new Date().toISOString(),
          successful_runs: workflow.successful_runs + (failed ? 0 : 1),
          failed_runs: workflow.failed_runs + (failed ? 1 : 0),
        })
        .eq("id", workflow.id);

      if (failed) {
        report.failures += 1;
        eventFailed = true;
      }
      report.details.push({ event: event.event_type, workflow: workflow.name, outcomes });
    }

    await admin
      .from("domain_events")
      .update({
        status: eventFailed ? "failed" : "processed",
        processed_at: new Date().toISOString(),
        retry_count: event.retry_count + (eventFailed ? 1 : 0),
      })
      .eq("id", event.id);
  }

  return report;
}

/** Runs due scheduled actions by re-materialising them as live actions. */
export async function processScheduledActions(admin: Admin, org: string, limit = 25) {
  const { data: due } = await admin
    .from("scheduled_actions")
    .select("*")
    .eq("organization_id", org)
    .eq("status", "scheduled")
    .lte("scheduled_for", new Date().toISOString())
    .limit(limit);

  let processed = 0;
  for (const item of due ?? []) {
    if (!item.event_id || !item.workflow_id) {
      await admin.from("scheduled_actions").update({ status: "cancelled", last_error: "Missing source context" }).eq("id", item.id);
      continue;
    }
    const [{ data: event }, { data: workflow }] = await Promise.all([
      admin.from("domain_events").select("*").eq("id", item.event_id).maybeSingle(),
      admin.from("workflow_definitions").select("*").eq("id", item.workflow_id).maybeSingle(),
    ]);
    if (!event || !workflow) {
      await admin.from("scheduled_actions").update({ status: "cancelled", last_error: "Source no longer available" }).eq("id", item.id);
      continue;
    }
    try {
      const outcome = await executeAction(
        admin,
        event,
        workflow,
        item.run_id ?? "",
        { type: item.action_type, config: (item.action_config ?? {}) as Record<string, unknown> },
        999,
        "live",
      );
      await admin
        .from("scheduled_actions")
        .update({ status: outcome.status === "failed" ? "failed" : "completed", attempts: item.attempts + 1, last_error: outcome.status === "failed" ? outcome.detail : null })
        .eq("id", item.id);
      processed += 1;
    } catch (error) {
      await admin
        .from("scheduled_actions")
        .update({
          status: item.attempts >= 2 ? "failed" : "scheduled",
          attempts: item.attempts + 1,
          last_error: error instanceof Error ? error.message : "Unknown error",
        })
        .eq("id", item.id);
    }
  }
  return processed;
}

/**
 * Attempts delivery for queued messages.
 *
 * A message is only marked sent when the provider itself accepted it and
 * returned a reference; every attempt — accepted, refused or blocked — is
 * written to `communication_delivery_events` so the trail is auditable. A
 * refusal the provider will never accept (a malformed address, a rejected
 * sender) is failed permanently instead of being retried indefinitely.
 */
export async function processCommunicationQueue(admin: Admin, org: string, limit = 25) {
  // The live queue has a historical backlog. Releasing it when credentials
  // appear would send stale stock reports and delivery codes to real people.
  // Outbound delivery stays off until an operator sets a reviewed cutover time.
  const cutoff = process.env["NEO_OUTBOUND_CUTOFF"] ?? "";
  if (process.env["NEO_OUTBOUND_ENABLED"] !== "true" || !cutoff ||
      !Number.isFinite(Date.parse(cutoff))) {
    return { queued: 0, blocked: 0, sent: 0, failed: 0, disabled: true };
  }
  const { dispatchMessage } = await import("@/lib/communication-providers.server");
  const { loadProviderSecrets } = await import("@/lib/provider-credentials.server");

  const { data: providers } = await admin
    .from("provider_connections")
    .select("provider, channel, status, enabled, configuration")
    .eq("organization_id", org);

  // The workspace's own provider accounts, when a manager has connected them.
  const secrets = await loadProviderSecrets(admin, org);

  const { data: queued } = await admin
    .from("communication_queue")
    .select("*")
    .eq("organization_id", org)
    .eq("status", "queued")
    .gte("created_at", new Date(cutoff).toISOString())
    .lte("scheduled_for", new Date().toISOString())
    .limit(limit);

  let blocked = 0;
  let sent = 0;
  let failed = 0;

  const logEvent = async (
    messageId: string,
    provider: string,
    eventType: string,
    detail: string,
    reference?: string | null,
  ) => {
    await admin.from("communication_delivery_events").insert({
      organization_id: org,
      communication_queue_id: messageId,
      provider,
      event_type: eventType,
      provider_event_id: reference ?? null,
      detail,
      occurred_at: new Date().toISOString(),
    });
  };

  for (const message of queued ?? []) {
    const now = new Date().toISOString();
    const provider = (providers ?? []).find(
      (p) => p.channel === message.channel && p.enabled && p.status === "connected",
    );

    if (!provider) {
      blocked += 1;
      await admin
        .from("communication_queue")
        .update({
          failure_code: "provider_not_configured",
          failure_message: `No connected ${message.channel} provider. The message stays queued until a provider is connected.`,
          last_attempt_at: now,
        })
        .eq("id", message.id);
      continue;
    }

    if (!message.recipient || !message.rendered_body) {
      failed += 1;
      await admin
        .from("communication_queue")
        .update({
          status: "failed",
          failure_code: "message_incomplete",
          failure_message: "The message has no recipient or no content to send.",
          last_attempt_at: now,
          attempt_count: (message.attempt_count ?? 0) + 1,
        })
        .eq("id", message.id);
      await logEvent(message.id, provider.provider, "failed", "The message has no recipient or no content to send.");
      continue;
    }

    const attempt = (message.attempt_count ?? 0) + 1;
    const maxAttempts = message.max_attempts ?? 3;

    const outcome = await dispatchMessage(
      message.channel,
      {
        channel: message.channel,
        recipient: message.recipient,
        subject: message.subject,
        body: message.rendered_body,
      },
      (provider.configuration ?? {}) as Record<string, unknown>,
      secrets[provider.provider] ?? {},
    );

    if (outcome.ok) {
      sent += 1;
      await admin
        .from("communication_queue")
        .update({
          status: "sent",
          provider: provider.provider,
          provider_reference: outcome.reference,
          failure_code: null,
          failure_message: null,
          attempt_count: attempt,
          last_attempt_at: now,
        })
        .eq("id", message.id);
      await logEvent(message.id, provider.provider, "sent", outcome.detail, outcome.reference);
      continue;
    }

    const giveUp = outcome.permanent || attempt >= maxAttempts;
    // A missing key or sender is a configuration gap, not a message defect:
    // it stays queued so it goes out once the workspace is configured.
    const configurationGap =
      outcome.code === "provider_credentials_missing" ||
      outcome.code === "sender_not_configured" ||
      outcome.code === "channel_not_supported";

    if (configurationGap) blocked += 1;
    else if (giveUp) failed += 1;

    await admin
      .from("communication_queue")
      .update({
        status: configurationGap ? "queued" : giveUp ? "failed" : "queued",
        provider: provider.provider,
        failure_code: outcome.code,
        failure_message: outcome.detail,
        attempt_count: configurationGap ? (message.attempt_count ?? 0) : attempt,
        last_attempt_at: now,
      })
      .eq("id", message.id);

    await logEvent(
      message.id,
      provider.provider,
      configurationGap ? "blocked" : giveUp ? "failed" : "deferred",
      outcome.detail,
    );
  }

  return { queued: queued?.length ?? 0, blocked, sent, failed };
}

/** Creates the two-day supplier/requester reminders before queue delivery. */
export async function queueProcurementDeliveryReminders(admin: Admin, org: string) {
  const { data, error } = await admin.rpc("neo_procurement_queue_due_reminders", { _organization: org });
  if (error) throw new Error(`Procurement reminders could not be prepared: ${error.message}`);
  return data as { queued?: number; skipped?: number; cadence_days?: number } | null;
}

/** Raises escalations for genuinely overdue tasks and approvals. */
export async function processEscalations(admin: Admin, org: string) {
  const now = new Date().toISOString();
  const { data: policies } = await admin
    .from("escalation_policies")
    .select("*")
    .eq("organization_id", org)
    .eq("active", true);

  let raised = 0;

  for (const policy of policies ?? []) {
    if (policy.applies_to === "task") {
      const { data: overdue } = await admin
        .from("tasks")
        .select("id, title, department_id, branch_id, assignee_id, due_at, status")
        .eq("organization_id", org)
        .lt("due_at", now)
        .not("status", "in", "(completed,cancelled)")
        .limit(50);
      for (const task of overdue ?? []) {
        const key = `task-overdue:${task.id}:${policy.id}`;
        const claimed = await claimIdempotency(admin, org, "escalation", key);
        if (!claimed) continue;
        const { data: dept } = await admin
          .from("departments")
          .select("manager_id")
          .eq("id", task.department_id ?? "")
          .maybeSingle();
        await admin.from("escalation_events").insert({
          organization_id: org,
          branch_id: task.branch_id,
          department_id: task.department_id,
          policy_id: policy.id,
          subject_type: "task",
          subject_id: task.id,
          level: 1,
          reason: `Task "${task.title}" passed its due time.`,
          notified_user_id: dept?.manager_id ?? task.assignee_id,
          idempotency_key: key,
        });
        if (dept?.manager_id) {
          await admin.from("notifications").insert({
            organization_id: org,
            user_id: dept.manager_id,
            branch_id: task.branch_id,
            department_id: task.department_id,
            category: "escalation",
            title: "Overdue task escalated",
            body: `"${task.title}" is overdue and has been escalated by policy "${policy.name}".`,
            link: "/tasks",
            priority: "high",
          });
        }
        raised += 1;
      }
    }

    if (policy.applies_to === "approval") {
      const { data: pending } = await admin
        .from("approval_requests")
        .select("id, reference, branch_id, department_id, approver_id, created_at, status")
        .eq("organization_id", org)
        .eq("status", "pending_approval")
        .lt("created_at", new Date(Date.now() - 24 * 3_600_000).toISOString())
        .limit(50);
      for (const approval of pending ?? []) {
        const key = `approval-overdue:${approval.id}:${policy.id}`;
        const claimed = await claimIdempotency(admin, org, "escalation", key);
        if (!claimed) continue;
        await admin.from("escalation_events").insert({
          organization_id: org,
          branch_id: approval.branch_id,
          department_id: approval.department_id,
          policy_id: policy.id,
          subject_type: "approval",
          subject_id: approval.id,
          level: 1,
          reason: `Approval ${approval.reference} has been pending for more than 24 hours.`,
          notified_user_id: approval.approver_id,
          idempotency_key: key,
        });
        raised += 1;
      }
    }
  }
  return raised;
}

/** Simulated run used by Test Mode — nothing is written to operational tables. */
export async function simulateWorkflow(
  admin: Admin,
  org: string,
  workflowId: string,
  eventId: string | null,
): Promise<{ matched: boolean; outcomes: ActionOutcome[]; warnings: string[]; eventType: string | null }> {
  const warnings: string[] = [];
  const { data: workflow } = await admin
    .from("workflow_definitions")
    .select("*")
    .eq("id", workflowId)
    .eq("organization_id", org)
    .maybeSingle();
  if (!workflow) throw new Error("Workflow not found");

  const { data: version } = await admin
    .from("workflow_versions")
    .select("*")
    .eq("workflow_id", workflowId)
    .eq("version", workflow.current_version)
    .maybeSingle();
  if (!version) throw new Error("Workflow has no version to test");

  let event: EventRow | null = null;
  if (eventId) {
    const { data } = await admin.from("domain_events").select("*").eq("id", eventId).eq("organization_id", org).maybeSingle();
    event = data;
  } else {
    const { data } = await admin
      .from("domain_events")
      .select("*")
      .eq("organization_id", org)
      .eq("event_type", workflow.trigger_event ?? "")
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    event = data;
  }
  if (!event) {
    warnings.push("No real event of this type has occurred yet, so conditions could not be evaluated against live data.");
  }

  const conditions = (version.conditions ?? []) as unknown as Condition[];
  const actions = (version.actions ?? []) as unknown as Action[];
  const matched = event ? evaluateConditions(event, conditions) : false;

  const { data: providers } = await admin
    .from("provider_connections")
    .select("channel, status, enabled")
    .eq("organization_id", org);

  const outcomes: ActionOutcome[] = [];
  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i] as Action;
    const config = action.config ?? {};
    if (action.type === "queue_message" || action.type === "feedback_invitation") {
      const channel = String(config["channel"] ?? "email");
      const provider = (providers ?? []).find((p) => p.channel === channel && p.enabled && p.status === "connected");
      if (!provider) warnings.push(`No connected ${channel} provider — messages would remain queued.`);
      const templateKey = String(config["template_key"] ?? "");
      if (!templateKey) warnings.push(`Action ${i + 1} has no message template selected.`);
    }
    if (["notify_role", "notify_user", "notify_department"].includes(action.type)) {
      const { userIds } = await resolveRecipients(admin, org, action);
      if (!userIds.length) warnings.push(`Action ${i + 1} resolves to no recipients.`);
    }
    outcomes.push({
      index: i,
      type: action.type,
      status: "simulated",
      detail: `Would run "${action.type}"${action.delay_minutes ? ` after ${action.delay_minutes} minutes` : ""}.`,
    });
  }

  await admin.from("workflow_runs").insert({
    organization_id: org,
    workflow_id: workflowId,
    workflow_version: version.version,
    event_id: event?.id ?? null,
    mode: "test",
    status: "completed",
    matched,
    actions_total: actions.length,
    actions_completed: 0,
    finished_at: new Date().toISOString(),
  });

  return { matched, outcomes, warnings, eventType: event?.event_type ?? null };
}
