/**
 * NEØ System Test — authenticated entry points.
 *
 * Only a workspace administrator may create a test environment, start a run or
 * clear one down. Everything privileged happens on the server, inside the
 * isolated QA workspaces; the caller's own workspace is only ever the owner of
 * the run record.
 */
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  SIMULATION_BRIDGE_CONTRACT,
  SIMULATION_BRIDGE_HEADER,
  simulationConfigurationIssue,
  simulationConnectionActions,
  simulationRegistryIssue,
} from "./simulation/connection-status";

type Ctx = { supabase: unknown; userId: string };

async function adminTenant(context: Ctx) {
  const client = context.supabase as {
    rpc: (fn: string) => Promise<{ data: unknown; error: unknown }>;
  };
  const [workspace, authority] = await Promise.all([
    client.rpc("current_org_id"),
    client.rpc("is_org_admin"),
  ]);
  if (workspace.error || typeof workspace.data !== "string" || !workspace.data)
    throw new Error("The active workspace could not be verified.");
  if (authority.error || authority.data !== true)
    throw new Error("Only a workspace administrator can use the Simulation Centre.");
  return workspace.data;
}

async function admin() {
  const issue = simulationConfigurationIssue(process.env);
  if (issue) throw new Error(simulationConnectionActions[issue]);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function registryIssue(client: Awaited<ReturnType<typeof admin>>) {
  try {
    const { error, status } = await client.from("neo_test_environments").select("id", { head: true }).limit(0);
    return error ? simulationRegistryIssue(status, error.code) : null;
  } catch {
    return "unreachable" as const;
  }
}

async function requireSimulationAdmin() {
  const client = await admin();
  const issue = await registryIssue(client);
  if (issue) throw new Error(simulationConnectionActions[issue]);
  return client;
}

export const checkSimulationService = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await adminTenant(context as unknown as Ctx);
    const checkedAt = new Date().toISOString();
    const configurationIssue = simulationConfigurationIssue(process.env);
    if (configurationIssue) return { available: false, issue: configurationIssue, checkedAt };
    const issue = await registryIssue(await admin());
    if (!issue) setResponseHeader(SIMULATION_BRIDGE_HEADER, SIMULATION_BRIDGE_CONTRACT);
    return { available: !issue, issue, checkedAt };
  });

/** Creates the two isolated QA workspaces with their temporary staff accounts. */
export const createTestEnvironment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const org = await adminTenant(context as unknown as Ctx);
    const runner = await import("./simulation/runner.server");
    const created = await runner.createEnvironment(await requireSimulationAdmin(), org, (context as unknown as Ctx).userId);
    return {
      primary: { id: created.primary.id, label: created.primary.label, accounts: created.primary.accounts.length },
      secondary: { id: created.secondary.id, label: created.secondary.label, accounts: created.secondary.accounts.length },
    };
  });

/** Runs every suite against the active QA environments. */
export const runSystemTest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const org = await adminTenant(context as unknown as Ctx);
    const supabaseAdmin = await requireSimulationAdmin();
    const runner = await import("./simulation/runner.server");

    const { data, error } = await supabaseAdmin
      .from("neo_test_environments")
      .select("*")
      .eq("control_org_id", org)
      .eq("status", "active")
      .order("created_at", { ascending: false });
    if (error) throw new Error("Simulation could not read the test registry. Check the server database connection in Simulation Centre.");
    const rows = (data ?? []) as unknown as runnerRow[];
    const primary = rows.find((r) => r.kind === "primary");
    const secondary = rows.find((r) => r.kind === "secondary");
    if (!primary || !secondary)
      throw new Error("No test environment is available. Create the test environment first.");

    const result = await runner.runFullSystemTest(supabaseAdmin, {
      controlOrg: org,
      createdBy: (context as unknown as Ctx).userId,
      primary: primary as never,
      secondary: secondary as never,
    });
    return { runId: result.runId, runRef: result.runRef, status: result.status, totals: result.totals };
  });

type runnerRow = { id: string; kind: string; status: string };

/** Removes the QA workspaces and their temporary accounts. */
export const cleanTestEnvironment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const org = await adminTenant(context as unknown as Ctx);
    const supabaseAdmin = await requireSimulationAdmin();
    const runner = await import("./simulation/runner.server");
    const { data, error } = await supabaseAdmin
      .from("neo_test_environments")
      .select("*")
      .eq("control_org_id", org)
      .in("status", ["active", "cleanup_failed"]);
    if (error) throw new Error("Simulation could not load environments to clean. Recheck the connection before retrying.");
    if (!data?.length) throw new Error("No test environments were found to clean.");
    const result = await runner.cleanEnvironment(supabaseAdmin, (data ?? []) as never);
    return result;
  });
