/**
 * Phase 6 — authenticated server entry points for the automation engine.
 *
 * Every function verifies the caller's tenant and automation permission before
 * touching privileged data. Provider secrets are only ever read here, on the
 * server, and never returned to the browser.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertAutomation(
  context: { supabase: { rpc: (fn: never, args: never) => Promise<{ data: unknown }> } },
  action: "view" | "create" | "edit" | "delete" | "approve" | "override",
) {
  const { data } = await context.supabase.rpc("has_permission" as never, {
    _module: "automation",
    _action: action,
  } as never);
  if (data !== true) throw new Error("You do not have permission to perform this automation action.");
}

async function tenant(context: { supabase: { from: (t: never) => never }; userId: string }) {
  const client = context.supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (c: string, v: string) => { maybeSingle: () => Promise<{ data: { organization_id: string } | null }> };
      };
    };
  };
  const { data } = await client.from("profiles").select("organization_id").eq("id", context.userId).maybeSingle();
  if (!data?.organization_id) throw new Error("No organisation is linked to this account.");
  return data.organization_id;
}

/**
 * Prepares and sends the two-day delivery reminders for purchase orders that
 * still have outstanding quantities. Only stored supplier and requester email
 * addresses are used; a missing address is recorded as skipped, never invented.
 */
export const sendProcurementDeliveryReminders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: allowed } = await (
      context as unknown as { supabase: { rpc: (fn: string, args: unknown) => Promise<{ data: unknown }> } }
    ).supabase.rpc("has_permission", { _module: "procurement", _action: "edit" });
    if (allowed !== true) throw new Error("You do not have permission to send procurement reminders.");

    const org = await tenant(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const engine = await import("./automation-engine.server");

    const prepared = await engine.queueProcurementDeliveryReminders(supabaseAdmin, org);
    const queue = await engine.processCommunicationQueue(supabaseAdmin, org);
    return { prepared, queue };
  });

/** Processes pending business events, due scheduled actions and escalations. */
export const runAutomationEngine = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAutomation(context as never, "edit");
    const org = await tenant(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const engine = await import("./automation-engine.server");

    const report = await engine.processDomainEvents(supabaseAdmin, org);
    const scheduled = await engine.processScheduledActions(supabaseAdmin, org);
    const procurementReminders = await engine.queueProcurementDeliveryReminders(supabaseAdmin, org);
    const queue = await engine.processCommunicationQueue(supabaseAdmin, org);
    const escalations = await engine.processEscalations(supabaseAdmin, org);

    return { ...report, scheduledProcessed: scheduled, procurementReminders, queue, escalationsRaised: escalations };
  });

/** Read-only status; managers must see that a queued message is not sent. */
export const getOutboundReleaseStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAutomation(context as never, "view");
    const cutoff = process.env["NEO_OUTBOUND_CUTOFF"] ?? "";
    return {
      enabled: process.env["NEO_OUTBOUND_ENABLED"] === "true" &&
        Boolean(cutoff) && Number.isFinite(Date.parse(cutoff)),
      cutoff: Number.isFinite(Date.parse(cutoff)) ? cutoff : null,
    };
  });

/** Safe Test Mode run — never contacts a guest and never changes a record. */
export const testWorkflow = createServerFn({ method: "POST" })
  .inputValidator((input: { workflowId: string; eventId?: string | null }) => input)
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    await assertAutomation(context as never, "edit");
    const org = await tenant(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const engine = await import("./automation-engine.server");
    return engine.simulateWorkflow(supabaseAdmin, org, data.workflowId, data.eventId ?? null);
  });

/** Re-queues a failed event for processing, preserving idempotency. */
export const retryWorkflowFailure = createServerFn({ method: "POST" })
  .inputValidator((input: { failureId: string }) => input)
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    await assertAutomation(context as never, "override");
    const org = await tenant(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: failure } = await supabaseAdmin
      .from("workflow_failures")
      .select("id, event_id, retry_count")
      .eq("id", data.failureId)
      .eq("organization_id", org)
      .maybeSingle();
    if (!failure) throw new Error("Failure record not found.");

    if (failure.event_id) {
      await supabaseAdmin.from("domain_events").update({ status: "retrying" }).eq("id", failure.event_id);
    }
    await supabaseAdmin
      .from("workflow_failures")
      .update({ status: "retry-scheduled", retry_count: failure.retry_count + 1 })
      .eq("id", failure.id);

    const engine = await import("./automation-engine.server");
    return engine.processDomainEvents(supabaseAdmin, org, 5);
  });

/**
 * Truthful provider status. A provider is only "connected" when its secrets
 * genuinely exist in the server environment; nothing is assumed.
 */
export const refreshProviderStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAutomation(context as never, "view");
    const org = await tenant(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const catalogue = [
      { provider: "resend", display_name: "Resend", channel: "email", secrets: ["RESEND_API_KEY"] },
      { provider: "whatsapp", display_name: "WhatsApp Business API", channel: "whatsapp", secrets: ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID"] },
      { provider: "africastalking", display_name: "Africa's Talking", channel: "sms", secrets: ["AT_API_KEY", "AT_USERNAME"] },
      { provider: "openai", display_name: "OpenAI", channel: "ai", secrets: ["OPENAI_API_KEY"] },
    ];

    // A workspace that has connected its own account is connected even when no
    // platform-wide key exists: its own credentials are what will be used.
    const { loadProviderSecrets, providerHasCredentials, CREDENTIAL_FIELDS } = await import(
      "@/lib/provider-credentials.server"
    );
    const stored = await loadProviderSecrets(supabaseAdmin, org);

    const results: { provider: string; status: string; missing: string[]; source: string }[] = [];
    for (const item of catalogue) {
      const check = providerHasCredentials(item.provider, stored, item.secrets);
      const fields = CREDENTIAL_FIELDS[item.provider] ?? [];
      const partial = fields.length
        ? fields.some((field) => (stored[item.provider] ?? {})[field])
        : item.secrets.some((name) => process.env[name]);
      const status = check.ready ? "connected" : partial ? "configuration_incomplete" : "not_configured";
      results.push({ provider: item.provider, status, missing: check.missing, source: check.source });
      await supabaseAdmin
        .from("provider_connections")
        .upsert(
          {
            organization_id: org,
            provider: item.provider,
            display_name: item.display_name,
            channel: item.channel,
            status,
            secret_names: item.secrets as never,
            last_checked_at: new Date().toISOString(),
            last_error: check.ready
              ? null
              : check.missing.length
                ? `Still needed: ${check.missing.join(", ")}`
                : "No account details have been saved for this provider yet.",
            enabled: check.ready,
          },
          { onConflict: "organization_id,provider" },
        );
    }
    return results;
  });

/**
 * The workspace's own provider accounts, described but never revealed. Only
 * the last four characters of a saved value are returned so a manager can tell
 * which account is connected without the value leaving the server intact.
 */
export const getProviderCredentialSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAutomation(context as never, "view");
    const org = await tenant(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { loadProviderSecrets, maskCredential, CREDENTIAL_FIELDS } = await import(
      "@/lib/provider-credentials.server"
    );
    const stored = await loadProviderSecrets(supabaseAdmin, org);

    const summary: Record<string, Record<string, string | null>> = {};
    for (const [provider, fields] of Object.entries(CREDENTIAL_FIELDS)) {
      const held = stored[provider] ?? {};
      summary[provider] = Object.fromEntries(
        fields.map((field) => [field, held[field] ? maskCredential(held[field]) : null]),
      );
    }
    return summary;
  });

/**
 * Saves the workspace's own provider account. Values are written straight to a
 * table the Data API cannot read; a blank field clears the stored value rather
 * than overwriting it with an empty string.
 */
export const saveProviderCredentials = createServerFn({ method: "POST" })
  .inputValidator((input: { provider: string; values: Record<string, string> }) => input)
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    await assertAutomation(context as never, "edit");
    const org = await tenant(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { loadProviderSecrets, CREDENTIAL_FIELDS } = await import("@/lib/provider-credentials.server");

    const fields = CREDENTIAL_FIELDS[data.provider];
    if (!fields) throw new Error("That provider cannot be connected from this screen.");

    const stored = await loadProviderSecrets(supabaseAdmin, org);
    const next: Record<string, string> = { ...(stored[data.provider] ?? {}) };
    for (const field of fields) {
      const value = data.values[field];
      if (value === undefined) continue;
      const trimmed = value.trim();
      if (trimmed) next[field] = trimmed;
      else delete next[field];
    }

    const { error } = await supabaseAdmin.from("provider_credentials").upsert(
      {
        organization_id: org,
        provider: data.provider,
        credentials: next as never,
        updated_by: (context as unknown as { userId: string }).userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,provider" },
    );
    if (error) throw new Error(error.message);

    await supabaseAdmin.from("audit_logs").insert({
      organization_id: org,
      user_id: (context as unknown as { userId: string }).userId,
      action: "automation.provider.credentials.saved",
      module: "automation",
      record_id: data.provider,
      new_value: { provider: data.provider, fields_set: Object.keys(next) } as never,
      reason: "Workspace provider account updated",
    });

    return { saved: true, configured: fields.every((field) => Boolean(next[field])) };
  });

/**
 * Saves the sending identity for a channel (the address a guest sees as the
 * sender). Credentials themselves stay in backend secrets; only the visible
 * sender details are stored here, scoped to the caller's own workspace.
 */
export const saveProviderSender = createServerFn({ method: "POST" })
  .inputValidator(
    (input: {
      provider: string;
      fromEmail?: string;
      fromName?: string;
      replyTo?: string;
      senderId?: string;
      defaultCountryCode?: string;
      templateName?: string;
      templateLanguage?: string;
    }) => input,
  )
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    await assertAutomation(context as never, "edit");
    const org = await tenant(context as never);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const clean = (value?: string) => (value ?? "").trim();
    const email = clean(data.fromEmail);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("That sending address is not a valid email address.");
    }
    const replyTo = clean(data.replyTo);
    if (replyTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)) {
      throw new Error("That reply-to address is not a valid email address.");
    }

    const { data: existing } = await supabaseAdmin
      .from("provider_connections")
      .select("id, configuration")
      .eq("organization_id", org)
      .eq("provider", data.provider)
      .maybeSingle();
    if (!existing) throw new Error("That provider is not set up for this workspace yet.");

    const configuration: Record<string, string> = {
      ...((existing.configuration ?? {}) as Record<string, string>),
    };
    const set = (key: string, value: string) => {
      if (value) configuration[key] = value;
      else delete configuration[key];
    };
    if (data.fromEmail !== undefined) set("from_email", email);
    if (data.fromName !== undefined) set("from_name", clean(data.fromName));
    if (data.replyTo !== undefined) set("reply_to", replyTo);
    if (data.senderId !== undefined) set("sender_id", clean(data.senderId));
    if (data.defaultCountryCode !== undefined)
      set("default_country_code", clean(data.defaultCountryCode).replace(/[^\d+]/g, ""));
    if (data.templateName !== undefined) set("template_name", clean(data.templateName));
    if (data.templateLanguage !== undefined) set("template_language", clean(data.templateLanguage));

    const { error } = await supabaseAdmin
      .from("provider_connections")
      .update({ configuration: configuration as never, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
    return { saved: true };
  });

/**
 * AI smart notifications. Uses only real tenant data. When OpenAI is not
 * configured the caller is told so explicitly instead of receiving invented text.
 */
export const generateAiBrief = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAutomation(context as never, "view");
    const org = await tenant(context as never);
    const apiKey = process.env["OPENAI_API_KEY"];
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const [events, failures, queue, escalations] = await Promise.all([
      supabaseAdmin.from("domain_events").select("event_type, status").eq("organization_id", org).gte("occurred_at", since),
      supabaseAdmin.from("workflow_failures").select("error_category").eq("organization_id", org).eq("status", "new"),
      supabaseAdmin.from("communication_queue").select("status, channel").eq("organization_id", org).gte("created_at", since),
      supabaseAdmin.from("escalation_events").select("subject_type").eq("organization_id", org).gte("created_at", since),
    ]);

    const facts = {
      period: { from: since, to: new Date().toISOString() },
      events: (events.data ?? []).length,
      failedEvents: (events.data ?? []).filter((e) => e.status === "failed").length,
      openFailures: (failures.data ?? []).length,
      messagesQueued: (queue.data ?? []).filter((m) => m.status === "queued").length,
      messagesSuppressed: (queue.data ?? []).filter((m) => m.status === "suppressed").length,
      escalations: (escalations.data ?? []).length,
    };

    if (!apiKey) {
      return {
        configured: false as const,
        reason: "An AI provider key has not been added to the backend, so no summary can be produced.",
        facts,
        summary: null,
        generatedAt: new Date().toISOString(),
      };
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are an operations assistant for a hotel group. Summarise ONLY the supplied figures. Never invent events, guests or amounts. If a figure is zero, say there is insufficient data for that area.",
          },
          { role: "user", content: JSON.stringify(facts) },
        ],
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      let message = `The AI provider rejected the request (HTTP ${response.status}).`;
      try {
        const parsed = JSON.parse(detail) as { error?: { message?: string; code?: string } };
        if (parsed.error?.code === "credit_balance_exhausted" || parsed.error?.message?.includes("credits")) {
          message = "The AI provider account has no credits remaining, so no summary can be produced. Add credits and try again.";
        } else if (parsed.error?.message) {
          message = parsed.error.message;
        }
      } catch {
        /* non-JSON provider error: keep the status-based message */
      }
      return {
        configured: false as const,
        reason: message,
        facts,
        summary: null,
        generatedAt: new Date().toISOString(),
      };
    }
    const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    return {
      configured: true as const,
      reason: null,
      facts,
      summary: json.choices?.[0]?.message?.content ?? "",
      generatedAt: new Date().toISOString(),
    };
  });
