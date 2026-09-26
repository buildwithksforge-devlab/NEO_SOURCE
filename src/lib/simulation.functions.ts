/**
 * NEØ System Test — authenticated entry points.
 *
 * Only a workspace administrator may create a test environment, start a run or
 * clear one down. Everything privileged happens on the server, inside the
 * isolated QA workspaces; the caller's own workspace is only ever the owner of
 * the run record.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Ctx = { supabase: unknown; userId: string };

async function adminTenant(context: Ctx) {
  const client = context.supabase as {
    rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown }>;
    from: (t: string) => {
      select: (c: string) => {
        eq: (c: string, v: string) => { maybeSingle: () => Promise<{ data: { organization_id: string } | null }> };
      };
    };
  };
  const { data: profile } = await client.from("profiles").select("organization_id").eq("id", context.userId).maybeSingle();
  if (!profile?.organization_id) throw new Error("No workspace is linked to this account.");
  const { data: isAdmin } = await client.rpc("is_org_admin");
  if (isAdmin !== true) throw new Error("Only a workspace administrator can use the Simulation Centre.");
  return profile.organization_id;
}

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/** Creates the two isolated QA workspaces with their temporary staff accounts. */
export const createTestEnvironment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const org = await adminTenant(context as unknown as Ctx);
    const runner = await import("./simulation/runner.server");
    const created = await runner.createEnvironment(await admin(), org, (context as unknown as Ctx).userId);
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
    const supabaseAdmin = await admin();
    const runner = await import("./simulation/runner.server");

    const { data } = await supabaseAdmin
      .from("neo_test_environments")
      .select("*")
      .eq("control_org_id", org)
      .eq("status", "active")
      .order("created_at", { ascending: false });
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
    const supabaseAdmin = await admin();
    const runner = await import("./simulation/runner.server");
    const { data } = await supabaseAdmin
      .from("neo_test_environments")
      .select("*")
      .eq("control_org_id", org)
      .eq("status", "active");
    const result = await runner.cleanEnvironment(supabaseAdmin, (data ?? []) as never);
    return result;
  });
