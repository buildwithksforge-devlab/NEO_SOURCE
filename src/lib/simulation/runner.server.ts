/**
 * NEØ System Test — run orchestration (server only).
 *
 * A run belongs to the workspace that started it, but every record it creates
 * lives inside the isolated QA workspaces. The run persists its cases as it
 * goes, so a failure part-way through still leaves a readable report.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { Recorder } from "./harness.server";
import { SUITES, type SuiteContext } from "./suites.server";
import { issueSessions, provisionEnvironment, purgeEnvironment, type TestAccount, type TestEnvironment } from "./environment.server";

type Admin = SupabaseClient;

export type EnvironmentRow = {
  id: string;
  control_org_id: string;
  test_org_id: string | null;
  label: string;
  kind: string;
  owner_user_id: string | null;
  branch_id: string | null;
  accounts: TestAccount[];
  seed: Record<string, string>;
  status: string;
};

/**
 * Invented house names for QA workspaces only. Two distinct names are drawn per
 * environment pair so no two test workspaces ever read the same in the list.
 * These are fictional QA labels, never live customer names.
 */
const TEST_HOUSE_NAMES = [
  "Kigio Sands Retreat",
  "Marara Heights Lodge",
  "Olkaria Bay Residence",
  "Chania Vale Hotel",
  "Suswa Ridge Suites",
  "Nyali Dune Resort",
  "Tsavo Lantern Inn",
  "Elgon Mist Manor",
  "Rusinga Reef Hotel",
  "Amboseli Fig Lodge",
  "Kerio Terrace Hotel",
  "Lamu Coral House",
];

function pickTestHouseNames(): [string, string] {
  const pool = [...TEST_HOUSE_NAMES];
  const first = pool.splice(Math.floor(Math.random() * pool.length), 1)[0]!;
  const second = pool.splice(Math.floor(Math.random() * pool.length), 1)[0]!;
  return [first, second];
}

function shortRef() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(2, 12);
  return `${stamp}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
}

/** Creates the two isolated QA workspaces (Hotel A and Hotel B). */
export async function createEnvironment(
  admin: Admin,
  controlOrg: string,
  createdBy: string,
): Promise<{ primary: EnvironmentRow; secondary: EnvironmentRow }> {
  const tag = crypto.randomUUID().slice(0, 6);
  const rows: EnvironmentRow[] = [];
  const [primaryName, secondaryName] = pickTestHouseNames();

  for (const spec of [
    { kind: "primary", label: `NEØ QA — ${primaryName} (TEST ${tag})` },
    { kind: "secondary", label: `NEØ QA — ${secondaryName} (TEST ${tag})` },
  ]) {
    const built = await provisionEnvironment(admin, { label: spec.label, kind: spec.kind, tag: `${tag}-${spec.kind}` });
    const { data, error } = await admin
      .from("neo_test_environments")
      .insert({
        control_org_id: controlOrg,
        test_org_id: built.orgId,
        label: built.label,
        kind: built.kind,
        owner_user_id: built.ownerUserId,
        branch_id: built.branchId,
        accounts: built.accounts,
        seed: built.seed,
        status: "active",
        created_by: createdBy,
      } as never)
      .select("*")
      .single();
    if (error) throw new Error(`The test environment could not be registered: ${error.message}`);
    rows.push(data as unknown as EnvironmentRow);
  }

  return { primary: rows[0]!, secondary: rows[1]! };
}

function toEnvironment(row: EnvironmentRow): TestEnvironment {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    orgId: row.test_org_id!,
    branchId: row.branch_id!,
    ownerUserId: row.owner_user_id!,
    accounts: row.accounts ?? [],
    seed: row.seed ?? {},
  };
}

async function signInAll(admin: Admin, accounts: TestAccount[]) {
  // Credentials are minted for this run only and never stored anywhere.
  return issueSessions(admin, accounts);
}

/**
 * A test workspace is reused between runs. If an earlier run stopped part way
 * through, its guest can still be occupying the only test room, which makes
 * every later run fail on availability. This releases that leftover stay inside
 * the test workspace only — no live property is ever touched.
 */
async function releaseLeftoverTestStays(admin: Admin, orgId: string) {
  await admin
    .from("reservations")
    .update({ status: "cancelled", room_id: null } as never)
    .eq("organization_id", orgId)
    .in("status", ["pending", "confirmed", "checked-in"]);
  const { data: testRooms } = await admin.from("rooms").select("id").eq("organization_id", orgId);
  const roomIds = ((testRooms ?? []) as { id: string }[]).map((r) => r.id);
  if (roomIds.length > 0) {
    await admin
      .from("room_assignments")
      .update({ status: "released" } as never)
      .in("room_id", roomIds)
      .eq("status", "active");
    await admin
      .from("reservation_holds")
      .update({ status: "released" } as never)
      .in("room_id", roomIds)
      .eq("status", "active");
  }
  await admin
    .from("rooms")
    .update({
      occupancy_status: "vacant",
      room_condition: "vacant-clean",
      housekeeping_status: "clean",
    } as never)
    .eq("organization_id", orgId);

  // A cleaning task left open by an interrupted run blocks the next checkout,
  // because a room may only carry one open task at a time. Closing it here is
  // confined to the QA workspace and keeps the guard itself untouched.
  await admin
    .from("housekeeping_jobs")
    .update({ status: "cancelled", notes: "Closed automatically before a new system test run." } as never)
    .eq("organization_id", orgId)
    .in("status", ["pending", "assigned", "in-progress", "rework"]);
}



/** Runs every suite against the isolated environments and stores the report. */
export async function runFullSystemTest(
  admin: Admin,
  input: { controlOrg: string; createdBy: string; primary: EnvironmentRow; secondary: EnvironmentRow },
) {
  const runRef = shortRef();
  const started = Date.now();

  // A terminated request must not block every later certification attempt.
  await admin.rpc("neo_test_run_recover_stale", { _older_than: "15 minutes" } as never);

  const { data: runRow, error: runError } = await admin
    .from("neo_test_runs")
    .insert({
      control_org_id: input.controlOrg,
      run_ref: runRef,
      environment: "Simulation",
      status: "running",
      created_by: input.createdBy,
    } as never)
    .select("id")
    .single();
  if (runError) throw new Error(`The run could not be started: ${runError.message}`);
  const runId = (runRow as { id: string }).id;

  const rec = new Recorder();
  try {
    const a = toEnvironment(input.primary);
    const b = toEnvironment(input.secondary);
    await releaseLeftoverTestStays(admin, a.orgId);
    await releaseLeftoverTestStays(admin, b.orgId);
    const ctx: SuiteContext = {
      admin,
      runRef,
      a,
      b,
      clientsA: await signInAll(admin, a.accounts),
      clientsB: await signInAll(admin, b.accounts),
      rec,
      state: {},
    };

    for (const suite of SUITES) {
      await admin.from("neo_test_runs").update({ heartbeat_at: new Date().toISOString(), current_suite: suite.name } as never).eq("id", runId);
      const before = rec.cases.length;
      try {
        await suite.run(ctx);
      } catch (error) {
        await rec.run(suite.name, 99, `${suite.key}.suite`, `${suite.name} suite`, async () => {
          throw error instanceof Error ? error : new Error(String(error));
        });
      }
      const fresh = rec.cases.slice(before);
      if (fresh.length > 0) {
        const { error } = await admin.from("neo_test_results").insert(
          fresh.map((c) => ({
            run_id: runId,
            control_org_id: input.controlOrg,
            suite: c.suite,
            suite_order: c.suiteOrder,
            case_key: c.caseKey,
            name: c.name,
            status: c.status,
            severity: c.severity,
            duration_ms: c.durationMs,
            assertions: c.assertions,
            evidence: c.evidence,
            detail: c.detail,
          })) as never,
        );
        if (error) throw new Error(`Results could not be stored: ${error.message}`);
      }
      await admin.from("neo_test_runs").update({ heartbeat_at: new Date().toISOString(), totals: rec.totals() } as never).eq("id", runId);
    }

    const totals = rec.totals();
    const status = totals.critical > 0 ? "critical" : totals.failed > 0 ? "failed" : totals.warnings > 0 ? "warning" : "passed";
    await admin.from("neo_test_runs").update({ status, totals, current_suite: null, finished_at: new Date().toISOString(), duration_ms: Date.now() - started } as never).eq("id", runId);
    return { runId, runRef, status, totals, cases: rec.cases };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await admin.from("neo_test_runs").update({
      status: "failed",
      totals: rec.totals(),
      current_suite: null,
      failure_detail: detail,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
    } as never).eq("id", runId);
    throw error;
  }
}

/**
 * Removes the isolated QA workspaces and their temporary accounts, then proves
 * it. A workspace is only marked cleaned once verification shows nothing of it
 * remains — otherwise it keeps its old status and the exact reason is reported.
 */
export async function cleanEnvironment(admin: Admin, rows: EnvironmentRow[]) {
  const problems: string[] = [];
  const details: { label: string; cleaned: boolean; problems: string[] }[] = [];
  let removed = 0;

  for (const row of rows) {
    const result = await purgeEnvironment(admin, { orgId: row.test_org_id, accounts: row.accounts ?? [] });
    const accountsGone = result.accountsRemoved === (row.accounts ?? []).length;
    const cleaned = result.organisationRemoved && result.leftovers.length === 0 && accountsGone && result.problems.length === 0;
    if (!accountsGone) result.problems.push("Some temporary accounts could not be removed.");

    if (cleaned) {
      removed += 1;
      await admin
        .from("neo_test_environments")
        .update({
          status: "purged",
          purged_at: new Date().toISOString(),
          test_org_id: null,
          accounts: [],
          cleanup_problems: [],
        } as never)
        .eq("id", row.id);
    } else {
      await admin
        .from("neo_test_environments")
        .update({ status: "cleanup_failed", cleanup_problems: result.problems } as never)
        .eq("id", row.id);
    }
    details.push({ label: row.label, cleaned, problems: result.problems });
    problems.push(...result.problems.map((p) => `${row.label}: ${p}`));
  }

  // Nothing may keep a credential once a run is over.
  const { data: leftoverSecrets } = await admin
    .from("neo_test_environments")
    .select("id, accounts")
    .in("id", rows.map((r) => r.id));
  for (const row of (leftoverSecrets ?? []) as { id: string; accounts: unknown }[]) {
    if (JSON.stringify(row.accounts ?? []).toLowerCase().includes("password")) {
      problems.push("A test environment record still holds credential material.");
    }
  }

  return { removed, problems, details, verified: problems.length === 0 };
}
