export const SIMULATION_BRIDGE_CONTRACT = "routed-cash-journal-v1";
export const SIMULATION_BRIDGE_HEADER = "x-neo-simulation-contract";

export const simulationConnectionActions = {
  missing_configuration: "The Simulation backend connection is missing. Check that the managed Horizon route is enabled for this deployment.",
  wrong_project: "Use the same Supabase project for browser sign-in and the Simulation server.",
  invalid_credential: "The Simulation backend's Supabase credential was rejected. Check whether this request is reaching the authorized backend.",
  registry_missing: "Apply the Simulation registry migrations to the configured Supabase project.",
  registry_denied: "The server key cannot read the Simulation registry. Check the project's server-role grants.",
  unreachable: "The server could not reach the Simulation registry. Check network access and retry.",
} as const;

export type SimulationConnectionIssue = keyof typeof simulationConnectionActions;

export function simulationConfigurationIssue(env: Record<string, string | undefined>): SimulationConnectionIssue | null {
  const url = env["SUPABASE_URL"]?.trim();
  const key = env["SUPABASE_SERVICE_ROLE_KEY"]?.trim();
  const browserUrl = env["VITE_SUPABASE_URL"];
  if (!url || !key) return "missing_configuration";
  try {
    const origin = new URL(url).origin;
    if (browserUrl && origin !== new URL(browserUrl).origin) return "wrong_project";
  } catch {
    return "missing_configuration";
  }

  if (/^sb_secret_[A-Za-z0-9_-]+$/.test(key)) return null;
  const [header, payload, signature, extra] = key.split(".");
  if (!header || !payload || !signature || extra !== undefined) return "invalid_credential";
  try {
    const claims: unknown = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    if (claims && typeof claims === "object" && "role" in claims && claims.role === "service_role") return null;
  } catch {
    return "invalid_credential";
  }
  return "invalid_credential";
}

export function simulationRegistryIssue(status: number, code?: string | null): SimulationConnectionIssue {
  if (status === 401) return "invalid_credential";
  if (code === "PGRST205" || code === "42P01" || status === 404) return "registry_missing";
  if (status === 403 || code === "42501") return "registry_denied";
  return "unreachable";
}
