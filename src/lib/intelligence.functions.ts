/**
 * NEØ Intelligence — optional generated narrative.
 *
 * The briefing itself is deterministic and produced by `neo_intelligence`.
 * This function only rewrites those already-authorised figures into prose when
 * an AI provider is configured. With no provider it returns `not_configured`
 * and the page keeps showing the deterministic System advisories — it never
 * invents an AI answer.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const generateBriefingNarrative = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { branchId?: string | null; from?: string | null; to?: string | null }) => ({
    branchId: input?.branchId ?? null,
    from: input?.from ?? null,
    to: input?.to ?? null,
  }))
  .handler(async ({ data, context }) => {
    const client = context.supabase as unknown as {
      rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
    };

    // Re-read the scoped payload server-side: the browser never chooses the numbers.
    const { data: payload, error } = await client.rpc("neo_intelligence", {
      _branch: data.branchId,
      _from: data.from,
      _to: data.to,
    });
    if (error) throw new Error(error.message);

    const result = (payload ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (result["authorised"] === false) {
      return { status: "unauthorised" as const, text: null, model: null, detail: "You cannot view this briefing." };
    }

    const briefing = (result["briefing"] ?? {}) as Record<string, unknown>;
    const currency = String(result["currency"] ?? "");
    const period = (result["period"] ?? {}) as { from?: string; to?: string };
    const anomalies = (result["anomalies"] ?? []) as { title: string; detail: string }[];

    const label = (key: string) => key.replace(/_/g, " ");
    const metrics = Object.entries(briefing)
      .filter(([, v]) => typeof v === "number")
      .map(([k, v]) => ({
        label: label(k),
        value: /revenue|sales|value|collected|receivables|payables|forecast/.test(k)
          ? `${currency} ${Number(v)}`
          : String(v),
      }))
      .slice(0, 24);

    for (const a of anomalies.slice(0, 6)) metrics.push({ label: a.title, value: a.detail });

    const { generateNarrative } = await import("@/lib/ai-assistant.server");
    const profile = await (context.supabase as unknown as { from: (t: string) => any }) // eslint-disable-line @typescript-eslint/no-explicit-any
      .from("profiles")
      .select("organization_id")
      .eq("id", context.userId)
      .maybeSingle();
    const organizationId = (profile?.data?.organization_id as string | undefined) ?? null;
    const startedAt = Date.now();
    const narrative = await generateNarrative({
      question:
        "Write the daily operations briefing for hotel leadership: what stands out, what needs a decision today, and what is at risk.",
      intentId: "daily_briefing",
      period: { from: String(period.from ?? ""), to: String(period.to ?? "") },
      metrics,
    }, organizationId);

    // The trace makes the provenance of this panel checkable: which provider
    // answered, how long it took, and exactly which deterministic values were
    // supplied. When no provider is configured the same trace explains what
    // the System advisories were built from.
    return {
      status: narrative.status,
      text: narrative.text,
      model: narrative.model,
      detail: narrative.detail ?? null,
      trace: {
        provider: narrative.provider,
        model: narrative.model,
        generated_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        source: "neo_intelligence",
        period: { from: String(period.from ?? ""), to: String(period.to ?? "") },
        currency,
        input_count: metrics.length,
        inputs: metrics.map((m) => ({ label: m.label, value: String(m.value) })),
      },
    };
  });
