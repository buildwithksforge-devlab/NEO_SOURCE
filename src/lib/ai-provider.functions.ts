/**
 * AI provider configuration — typed RPC used by the administration screen.
 *
 * Reads and writes go through guarded database routines, so the capability
 * check lives in the database, not the browser. The secret key is write-only:
 * the client can set or clear it but never read it back.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rpc = { rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: any; error: { message: string } | null }>; from: (t: string) => any };

export type AiProviderSettings = {
  authorised: boolean;
  reason?: string;
  configured?: boolean;
  provider?: string;
  model?: string;
  base_url?: string | null;
  enabled?: boolean;
  has_key?: boolean;
  last_check_at?: string | null;
  last_check_status?: string | null;
  last_check_detail?: string | null;
  platform_key_available?: boolean;
};

export const getAiProviderSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AiProviderSettings> => {
    const client = context.supabase as unknown as Rpc;
    const { data, error } = await client.rpc("neo_ai_provider_get");
    if (error) throw new Error(error.message);
    return { ...(data ?? { authorised: false }), platform_key_available: Boolean(process.env["LOVABLE_API_KEY"]) };
  });

export const saveAiProviderSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: {
    provider: string;
    model: string;
    baseUrl?: string | null;
    apiKey?: string | null;
    enabled?: boolean;
    clearKey?: boolean;
  }) => ({
    provider: String(input?.provider ?? "").trim(),
    model: String(input?.model ?? "").trim(),
    baseUrl: input?.baseUrl ? String(input.baseUrl).trim() : null,
    apiKey: input?.apiKey ? String(input.apiKey).trim() : null,
    enabled: input?.enabled !== false,
    clearKey: Boolean(input?.clearKey),
  }))
  .handler(async ({ data, context }) => {
    const client = context.supabase as unknown as Rpc;
    const { data: result, error } = await client.rpc("neo_ai_provider_save", {
      _provider: data.provider,
      _model: data.model,
      _base_url: data.baseUrl,
      _api_key: data.apiKey,
      _enabled: data.enabled,
      _clear_key: data.clearKey,
    });
    if (error) throw new Error(error.message);
    return (result ?? { authorised: false }) as { authorised: boolean; saved?: boolean; reason?: string };
  });

/** Makes one minimal live request so connectivity is proven before runtime use. */
export const testAiProvider = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const client = context.supabase as unknown as Rpc;
    const { data: settings, error } = await client.rpc("neo_ai_provider_get");
    if (error) throw new Error(error.message);
    if (!settings?.authorised) {
      return { authorised: false as const, status: "unauthorised", detail: settings?.reason ?? "Not permitted." };
    }

    const profile = await client.from("profiles").select("organization_id").eq("id", context.userId).maybeSingle();
    const organizationId = (profile?.data?.organization_id as string | undefined) ?? null;

    const { resolveAiProvider, callProvider } = await import("@/lib/ai-provider.server");
    const config = await resolveAiProvider(organizationId);
    const startedAt = Date.now();
    const result = await callProvider(
      config,
      [
        { role: "system", content: "Reply with the single word: ready" },
        { role: "user", content: "Connectivity check." },
      ],
      16,
    );

    await client.rpc("neo_ai_provider_record_check", {
      _status: result.status,
      _detail: result.detail ?? (result.ok ? "Provider responded successfully." : null),
    });

    return {
      authorised: true as const,
      ok: result.ok,
      status: result.status,
      detail: result.detail ?? (result.ok ? "Provider responded successfully." : "No response text returned."),
      provider: config.provider,
      model: config.model,
      source: config.source,
      duration_ms: Date.now() - startedAt,
    };
  });
