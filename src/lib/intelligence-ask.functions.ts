/**
 * Ask NEØ — authenticated, scope-bound question answering.
 *
 * The browser never chooses the numbers: the payload is re-read server-side
 * through `neo_intelligence`, which resolves organisation, property, period and
 * capability inside the database. The deterministic answer is produced from
 * that payload; a configured language model may only rephrase it.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { answerFacts, answerQuestion } from "@/lib/intelligence-ask";
import { priorPeriod } from "@/lib/intelligence-engine";
import type { IntelligencePayload } from "@/lib/intelligence-data";

type RpcClient = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  from: (table: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

export const askNeo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      question?: string;
      branchId?: string | null;
      from?: string | null;
      to?: string | null;
      propertyLabel?: string | null;
      compare?: boolean;
    }) => ({
      question: String(input?.question ?? "").slice(0, 400).trim(),
      branchId: input?.branchId ?? null,
      from: input?.from ?? null,
      to: input?.to ?? null,
      propertyLabel: input?.propertyLabel ?? "Your permitted properties",
      compare: input?.compare !== false,
    }),
  )
  .handler(async ({ data, context }) => {
    if (!data.question) {
      return { ok: false as const, reason: "empty_question" as const };
    }

    const client = context.supabase as unknown as RpcClient;
    const { data: payload, error } = await client.rpc("neo_intelligence", {
      _branch: data.branchId,
      _from: data.from,
      _to: data.to,
    });
    if (error) throw new Error(error.message);
    const current = (payload ?? { authorised: false }) as IntelligencePayload;

    let prior: IntelligencePayload | undefined;
    if (data.compare && current.period?.from && current.period?.to) {
      const window = priorPeriod(current.period.from, current.period.to);
      const { data: priorPayload } = await client.rpc("neo_intelligence", {
        _branch: data.branchId,
        _from: window.from,
        _to: window.to,
      });
      prior = (priorPayload ?? undefined) as IntelligencePayload | undefined;
    }

    const answer = answerQuestion(data.question, {
      payload: current,
      prior,
      scope: {
        propertyLabel: data.propertyLabel ?? "Your permitted properties",
        from: current.period?.from ?? String(data.from ?? "—"),
        to: current.period?.to ?? String(data.to ?? "—"),
        freshness: current.generated_at,
      },
    });

    // Optional prose. The model receives only the deterministic statements it
    // is allowed to rephrase — never the database, never free-form SQL.
    let narrative: string | null = null;
    let narrativeStatus = "not_attempted";
    if (answer.limitation === null) {
      try {
        const { generateNarrative } = await import("@/lib/ai-assistant.server");
        const profile = await client
          .from("profiles")
          .select("organization_id")
          .eq("id", context.userId)
          .maybeSingle();
        const organizationId = (profile?.data?.organization_id as string | undefined) ?? null;
        const result = await generateNarrative(
          {
            question: answer.question,
            intentId: `ask_neo:${answer.topic}`,
            period: { from: answer.scope.from, to: answer.scope.to },
            metrics: answerFacts(answer),
          },
          organizationId,
        );
        narrative = result.text;
        narrativeStatus = result.status;
      } catch {
        narrative = null;
        narrativeStatus = "unavailable";
      }
    }

    return {
      ok: true as const,
      answer,
      narrative,
      narrativeStatus,
      recordCount: answer.evidence.reduce((s, e) => s + (e.recordCount ?? 0), 0),
    };
  });
