/**
 * Workspace-owned messaging credentials (server only).
 *
 * A manager connects their own Africa's Talking or WhatsApp Cloud account and
 * the values are written to `provider_credentials`, a table the Data API cannot
 * read. Nothing here is ever returned to the browser: callers get a masked
 * summary, never the stored value.
 */

type Admin = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => Promise<{ data: unknown; error: { message: string } | null }>;
    };
  };
};

export type ProviderSecretMap = Record<string, Record<string, string>>;

/** Field names a workspace may store per provider. Anything else is ignored. */
export const CREDENTIAL_FIELDS: Record<string, string[]> = {
  africastalking: ["username", "api_key"],
  whatsapp: ["token", "phone_id"],
  resend: ["api_key"],
};

/** Shows that a value exists without revealing it. */
export function maskCredential(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

/** Loads every stored credential set for an organisation, keyed by provider. */
export async function loadProviderSecrets(admin: unknown, organizationId: string): Promise<ProviderSecretMap> {
  const client = admin as Admin;
  const { data, error } = await client
    .from("provider_credentials")
    .select("provider, credentials")
    .eq("organization_id", organizationId);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { provider: string; credentials: Record<string, unknown> | null }[];
  const map: ProviderSecretMap = {};
  for (const row of rows) {
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(row.credentials ?? {})) {
      if (typeof value === "string" && value.trim()) entries[key] = value.trim();
    }
    map[row.provider] = entries;
  }
  return map;
}

/** True when the workspace (or the platform) can actually reach the provider. */
export function providerHasCredentials(
  provider: string,
  secrets: ProviderSecretMap,
  envNames: string[],
): { ready: boolean; source: "workspace" | "platform" | "none"; missing: string[] } {
  const fields = CREDENTIAL_FIELDS[provider] ?? [];
  const held = secrets[provider] ?? {};
  const missingWorkspace = fields.filter((field) => !held[field]);
  if (fields.length && missingWorkspace.length === 0) {
    return { ready: true, source: "workspace", missing: [] };
  }
  const missingEnv = envNames.filter((name) => !process.env[name]);
  if (envNames.length && missingEnv.length === 0) {
    return { ready: true, source: "platform", missing: [] };
  }
  // Report the workspace gap: that is the one a manager can close themselves.
  return {
    ready: false,
    source: "none",
    missing: fields.length ? missingWorkspace : missingEnv,
  };
}
