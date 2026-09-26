/**
 * Phase 16 — AI Chat Assistant entry point.
 *
 * Flow: authenticate → resolve tenant → resolve an ALLOWLISTED intent →
 * check the module permission that intent requires → run the permission-aware
 * `bi_kpis` function as the user (RLS applies) → minimise the result →
 * optionally add a labelled AI narrative → log the interaction.
 *
 * The model never sees SQL, schema, identifiers or personal data, and cannot
 * modify anything: there is no write path in this function.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { REFUSAL_MESSAGE, metricValue, resolveIntent } from "@/lib/analytics";
import { generateNarrative } from "@/lib/ai-assistant.server";

export const askAssistant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { question: string; branchId?: string | null; from?: string; to?: string }) => {
    const question = String(input?.question ?? "").trim();
    if (!question) throw new Error("Ask a question first.");
    if (question.length > 500) throw new Error("Please shorten the question.");
    return {
      question,
      branchId: input.branchId ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
    };
  })
  .handler(async ({ data, context }) => {
    const client = context.supabase as unknown as {
      rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
      from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
    };

    const profile = await client
      .from("profiles")
      .select("organization_id")
      .eq("id", context.userId)
      .maybeSingle();
    const organizationId = profile?.data?.organization_id as string | undefined;
    if (!organizationId) throw new Error("No organisation is linked to this account.");

    const logInteraction = async (fields: Record<string, unknown>) => {
      await client.from("ai_query_logs").insert({
        organization_id: organizationId,
        user_id: context.userId,
        question: data.question,
        branch_scope: data.branchId,
        data_period_start: data.from,
        data_period_end: data.to,
        ...fields,
      });
    };

    // 1. Can this user use the assistant at all?
    const allowedAi = await client.rpc("has_permission", { _module: "ai", _action: "create" });
    const isAdmin = await client.rpc("is_org_admin");
    if (allowedAi.data !== true && isAdmin.data !== true) {
      await logInteraction({ refused: true, refusal_reason: "no_ai_permission", result_classification: "refusal" });
      return {
        refused: true as const,
        answer: "You do not have permission to use the AI assistant. Ask an administrator for the AI assistant permission.",
        classification: "refusal",
      };
    }

    // 2. Allowlisted intent only — no free-form querying is possible.
    const intent = resolveIntent(data.question);
    if (!intent) {
      await logInteraction({ refused: true, refusal_reason: "no_matching_intent", result_classification: "refusal" });
      return { refused: true as const, answer: REFUSAL_MESSAGE, classification: "refusal" };
    }

    // 3. The module permission this intent requires.
    const allowedModule = await client.rpc("has_permission", {
      _module: intent.permission.module,
      _action: intent.permission.action,
    });
    if (allowedModule.data !== true && isAdmin.data !== true) {
      await logInteraction({
        resolved_intent: intent.id,
        refused: true,
        refusal_reason: "module_permission_denied",
        result_classification: "refusal",
      });
      return {
        refused: true as const,
        answer: `That question needs ${intent.permission.module} access, which your role does not have. I cannot answer it.`,
        classification: "refusal",
      };
    }

    // 4. Scope enforcement — the assistant may only read the properties this
    //    user is actually posted to. A wider request is narrowed, never widened.
    const scopeRes = await client.rpc("current_access_scope");
    const scope = String(scopeRes.data ?? "personal");
    const branchRes = await client.rpc("current_branch_ids");
    const myBranches = Array.isArray(branchRes.data) ? (branchRes.data as string[]) : [];
    const orgWide = isAdmin.data === true || scope === "organization" || scope === "all";

    let branchScope = data.branchId;
    if (!orgWide) {
      if (myBranches.length === 0) {
        await logInteraction({
          resolved_intent: intent.id,
          refused: true,
          refusal_reason: "no_scope_assignment",
          result_classification: "refusal",
        });
        return {
          refused: true as const,
          answer:
            "Your account is not posted to a property yet, so there is no data in your scope to report on.",
          classification: "refusal",
        };
      }
      if (branchScope && !myBranches.includes(branchScope)) {
        await logInteraction({
          resolved_intent: intent.id,
          refused: true,
          refusal_reason: "branch_outside_scope",
          result_classification: "refusal",
        });
        return {
          refused: true as const,
          answer: "That property is outside your assigned scope, so I cannot report on it.",
          classification: "refusal",
        };
      }
      if (!branchScope) branchScope = myBranches[0] ?? null;
    }

    const period = {
      from: data.from ?? new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10),
      to: data.to ?? new Date().toISOString().slice(0, 10),
    };
    const kpis = await client.rpc("bi_kpis", {
      _branch: branchScope,
      _from: period.from,
      _to: period.to,
    });

    if (kpis.error) {
      await logInteraction({
        resolved_intent: intent.id,
        refused: true,
        refusal_reason: "analytics_unavailable",
        result_classification: "error",
      });
      throw new Error("Analytics data could not be read for your scope.");
    }

    // 5. Minimise: only the metric paths this intent declares.
    const payload = (kpis.data ?? {}) as Record<string, unknown>;
    const metrics = intent.metricPaths.map((path) => {
      const value = metricValue(payload as never, path);
      return {
        label: path.split(".").pop()!.replace(/_/g, " "),
        path,
        value: value === null ? "no recorded value" : String(value),
      };
    });

    // 6. Optional labelled narrative. Facts stand alone if AI is unavailable.
    const narrative = await generateNarrative({
      question: data.question,
      intentId: intent.id,
      period,
      metrics: metrics.map((m) => ({ label: m.label, value: m.value })),
    }, organizationId);

    await logInteraction({
      resolved_intent: intent.id,
      approved_query: `bi_kpis → ${intent.metricPaths.join(", ")}`,
      sources_used: intent.sources,
      result_classification: intent.classification,
      refused: false,
    });

    await client.from("ai_usage_records").insert({
      organization_id: organizationId,
      user_id: context.userId,
      feature: "assistant",
      model: narrative.model,
      request_count: narrative.status === "ok" ? 1 : 0,
      error: narrative.status === "ok" ? null : (narrative.detail ?? narrative.status),
      limit_status: narrative.status === "ok" ? "ok" : narrative.status,
    });

    return {
      refused: false as const,
      intentId: intent.id,
      intentQuestion: intent.question,
      classification: intent.classification,
      period,
      branchScoped: Boolean(branchScope),
      scope,


      metrics,
      sources: intent.sources,
      generatedAt: (payload["generated_at"] as string | undefined) ?? new Date().toISOString(),
      narrative: narrative.text,
      aiStatus: narrative.status,
      aiDetail: narrative.detail ?? null,
      aiProvider: narrative.provider,
      aiModel: narrative.model,
    };
  });
