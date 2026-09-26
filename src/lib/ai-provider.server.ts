/**
 * NEØ AI provider resolution — server only.
 *
 * A workspace may either use the built-in Lovable AI gateway or point NEØ at
 * its own OpenAI-compatible provider. The secret key never leaves the server:
 * it is read with the service-role client inside a handler and used only to
 * make the outbound request.
 */
export type AiProviderConfig = {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string | null;
  enabled: boolean;
  source: "workspace" | "platform" | "none";
};

const LOVABLE_BASE = "https://ai.gateway.lovable.dev/v1";
const DEFAULT_BASE: Record<string, string> = {
  lovable: LOVABLE_BASE,
  openai: "https://api.openai.com/v1",
};

export const DEFAULT_MODEL = "google/gemini-3-flash-preview";

/** Resolves the provider for an organisation, falling back to the platform gateway. */
export async function resolveAiProvider(organizationId: string | null): Promise<AiProviderConfig> {
  const platformKey = process.env["LOVABLE_API_KEY"] ?? null;
  const fallback: AiProviderConfig = {
    provider: "lovable",
    model: DEFAULT_MODEL,
    baseUrl: LOVABLE_BASE,
    apiKey: platformKey,
    enabled: true,
    source: platformKey ? "platform" : "none",
  };

  if (!organizationId) return fallback;

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await (supabaseAdmin as unknown as {
      from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
    })
      .from("ai_provider_settings")
      .select("provider, model, base_url, api_key, enabled")
      .eq("organization_id", organizationId)
      .maybeSingle();

    if (!data) return fallback;
    const row = data as Record<string, unknown>;
    const provider = String(row["provider"] ?? "lovable");
    const key = (row["api_key"] as string | null) || null;
    const baseUrl =
      (row["base_url"] as string | null) || DEFAULT_BASE[provider] || LOVABLE_BASE;
    const enabled = row["enabled"] !== false;

    if (provider === "lovable" && !key) {
      return { ...fallback, model: String(row["model"] ?? DEFAULT_MODEL), enabled };
    }
    return {
      provider,
      model: String(row["model"] ?? DEFAULT_MODEL),
      baseUrl,
      apiKey: key,
      enabled,
      source: key ? "workspace" : platformKey ? "platform" : "none",
    };
  } catch {
    return fallback;
  }
}

export type ProviderCallResult = {
  ok: boolean;
  text: string | null;
  status: "ok" | "not_configured" | "disabled" | "quota" | "unauthorised" | "unavailable";
  detail?: string;
  httpStatus?: number;
};

/** Single outbound call used by both the narrative path and the connectivity test. */
export async function callProvider(
  config: AiProviderConfig,
  messages: { role: string; content: string }[],
  maxTokens = 320,
): Promise<ProviderCallResult> {
  if (!config.enabled) {
    return { ok: false, text: null, status: "disabled", detail: "AI is switched off for this workspace." };
  }
  if (!config.apiKey) {
    return { ok: false, text: null, status: "not_configured", detail: "No AI provider key is configured." };
  }

  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, temperature: 0.2, max_tokens: maxTokens, messages }),
    });

    if (res.ok) {
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = json?.choices?.[0]?.message?.content ?? null;
      return { ok: Boolean(text), text, status: text ? "ok" : "unavailable", httpStatus: res.status };
    }

    const body = await res.text();
    const quota = /insufficient_quota|credit_balance|no credits|quota/i.test(body);
    if (res.status === 402 || quota) {
      return {
        ok: false,
        text: null,
        status: "quota",
        httpStatus: res.status,
        detail: "The AI provider reports no remaining credits or quota for this key.",
      };
    }
    if (res.status === 429) {
      return { ok: false, text: null, status: "quota", httpStatus: 429, detail: "AI usage limit reached — try again shortly." };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, text: null, status: "unauthorised", httpStatus: res.status, detail: "The AI provider rejected this key." };
    }
    if (res.status === 400) {
      return { ok: false, text: null, status: "unavailable", httpStatus: 400, detail: "The provider rejected the request — check the model name." };
    }
    return { ok: false, text: null, status: "unavailable", httpStatus: res.status, detail: "AI temporarily unavailable." };
  } catch {
    return { ok: false, text: null, status: "unavailable", detail: "The AI provider could not be reached." };
  }
}
