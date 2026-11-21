import {
  simulationConfigurationIssue,
  simulationConnectionActions,
  simulationRegistryIssue,
} from "../src/lib/simulation/connection-status.ts";

let issue = simulationConfigurationIssue(process.env);
if (!issue) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY.trim();
  try {
    const url = new URL("/rest/v1/neo_test_environments?select=id&limit=0", process.env.SUPABASE_URL);
    const response = await fetch(url, {
      headers: { apikey: key, ...(key.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${key}` }) },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (response.ok) {
      await response.body?.cancel();
    } else {
      const error = await response.json().catch(() => null);
      issue = simulationRegistryIssue(response.status, error?.code);
    }
  } catch {
    issue = "unreachable";
  }
}

console.log(issue
  ? JSON.stringify({ available: false, issue, action: simulationConnectionActions[issue] })
  : JSON.stringify({ available: true, check: "simulation_registry" }));
if (issue) process.exitCode = 1;
