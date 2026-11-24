import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/api/public/print-agent.$action";
const mock = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mock.rpc } }));
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const base = read("supabase/migrations/20261101123000_complete_physical_print_agent.sql");
function canonical(name: string) {
  const start = base.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const end = base.indexOf("\n$$;", base.indexOf("AS $$", start));
  if (start < 0 || end < 0) throw Error(name);
  return base.slice(start, end + 4);
}
const org = "00000000-0000-0000-0000-000000000001",
  branch = "00000000-0000-0000-0000-000000000002",
  other = "00000000-0000-0000-0000-000000000003",
  actor = "00000000-0000-0000-0000-000000000004",
  agent = "00000000-0000-0000-0000-000000000005",
  printer = "00000000-0000-0000-0000-000000000006",
  job = "00000000-0000-0000-0000-000000000007";
const token = "neopc_" + "a".repeat(64);
let hash: string;
type Handler = (ctx: { request: Request; params: { action: string } }) => Promise<Response>;
const handler = (Route.options as unknown as { server: { handlers: { POST: Handler } } }).server
  .handlers.POST;
let db: PGlite;
async function query(fn: string, args: unknown[] = []) {
  return (
    await db.query<{ value: unknown }>(
      `SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(",")}) AS value`,
      args,
    )
  ).rows[0]!.value as Record<string, unknown>;
}
async function api(action: string, body: unknown = {}, bearer = token) {
  return handler({
    request: new Request(`https://neo.test/api/public/print-agent/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    }),
    params: { action },
  });
}
async function claim() {
  const response = await api("claim", { printer_id: printer });
  expect(response.status).toBe(200);
  return (await response.json()).job;
}
beforeAll(async () => {
  hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  db = new PGlite();
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${actor}'::uuid $$;
 CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
 CREATE FUNCTION is_org_admin_for(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
 CREATE FUNCTION has_permission(text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('neo.test_permission',true),'yes')<>'no' $$;
 CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${branch}'::uuid AND coalesce(current_setting('neo.test_scope',true),'yes')<>'no' $$;
 CREATE TABLE organizations(id uuid PRIMARY KEY);CREATE TABLE branches(id uuid PRIMARY KEY,organization_id uuid);CREATE TABLE profiles(id uuid PRIMARY KEY);
 CREATE TABLE printer_profiles(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,department_id uuid,station_id uuid,printer_role text,name text,connection_type text,address text,active boolean DEFAULT true,status text,health_status text DEFAULT 'unknown',fallback_printer_id uuid,retry_backoff_seconds int DEFAULT 1,last_success_at timestamptz,last_checked_at timestamptz,last_error text,last_failure_at timestamptz,updated_at timestamptz);
 CREATE TABLE print_jobs(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,printer_id uuid,document_type text,title text,payload jsonb,status text DEFAULT 'queued',attempts int DEFAULT 0,max_attempts int DEFAULT 3,next_attempt_at timestamptz DEFAULT now(),created_at timestamptz DEFAULT now(),updated_at timestamptz,completed_at timestamptz,last_error text,failed_over boolean DEFAULT false);
 `);
  await db.exec(base.slice(0, base.indexOf("ALTER TABLE public.print_jobs")));
  await db.exec(
    `ALTER TABLE print_jobs ADD COLUMN claim_id uuid,ADD COLUMN claimed_by_agent_id uuid,ADD COLUMN claimed_at timestamptz,ADD COLUMN claim_expires_at timestamptz;`,
  );
  for (const name of [
    "neo_print_agent_printers",
    "neo_print_agent_claim",
    "neo_print_agent_finish",
  ])
    await db.exec(canonical(name));
  const packageDirectory = process.env["NEO_PRINT_SQL_PACKAGE_DIRECTORY"];
  if (packageDirectory) {
    await db.exec(
      "CREATE SCHEMA supabase_migrations;CREATE TABLE supabase_migrations.schema_migrations(version text)",
    );
    await db.exec(read(`${packageDirectory}/25_READ_ONLY_PRINT_PREFLIGHT.sql`));
    await db.exec(read(`${packageDirectory}/30_APPLY_LOCAL_PRINTER_DISCOVERY.sql`));
    await db.exec(read(`${packageDirectory}/96_READ_ONLY_PRINT_POSTCHECK.sql`));
  } else {
    await db.exec(read("supabase/migrations/20261106092000_local_printer_discovery.sql"));
  }
}, 60000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec(`TRUNCATE neo_print_agents,print_jobs,printer_profiles,profiles,branches,organizations CASCADE;
 SELECT set_config('neo.test_permission','yes',false),set_config('neo.test_scope','yes',false);
 INSERT INTO organizations VALUES('${org}');INSERT INTO branches VALUES('${branch}','${org}'),('${other}','${org}');INSERT INTO profiles VALUES('${actor}');
 INSERT INTO neo_print_agents(id,organization_id,branch_id,name,token_hash) VALUES('${agent}','${org}','${branch}','Local test agent','${hash}');
 INSERT INTO printer_profiles(id,organization_id,branch_id,name,printer_role,connection_type,address) VALUES('${printer}','${org}','${branch}','Thermal fixture','receipt','network','127.0.0.1:9100');
 INSERT INTO print_jobs(id,organization_id,branch_id,printer_id,document_type,title,payload) VALUES('${job}','${org}','${branch}','${printer}','test','Labelled test','{}');`);
  mock.rpc.mockReset();
  mock.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    // PostgreSQL resolves real named argument identifiers, catching API/SQL drift.
    const entries = Object.entries(args);
    const casts: Record<string, string> = {
      _token_hash: "text",
      _printer: "uuid",
      _job: "uuid",
      _claim: "uuid",
      _outcome: "text",
      _error: "text",
      _request: "uuid",
      _result: "jsonb",
    };
    try {
      const result = await db.query<{ data: unknown }>(
        `SELECT public.${name}(${entries.map(([key], i) => `${key}=>$${i + 1}::${casts[key]}`).join(",")}) AS data`,
        entries.map(([key, value]) => (key === "_result" ? JSON.stringify(value) : value)),
      );
      return { data: result.rows[0]!.data, error: null };
    } catch (error) {
      return { data: null, error: { message: (error as Error).message } };
    }
  });
});
describe("actual print agent API and PostgreSQL contract", () => {
  it("returns the claimed JSON object and acknowledges its exact claim_id through the real SQL signature", async () => {
    const saved = await claim();
    expect(saved.job_id).toBe(job);
    expect(saved.claim_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.printer.address).toBe("127.0.0.1:9100");
    expect(await claim()).toBeNull();
    const finish = await api("finish", {
      job_id: job,
      claim_id: saved.claim_id,
      outcome: "completed",
    });
    expect(finish.status).toBe(200);
    expect((await finish.json()).status.status).toBe("completed");
    expect((await db.query("SELECT status,attempts FROM print_jobs")).rows[0]).toEqual({
      status: "completed",
      attempts: 1,
    });
    expect(mock.rpc.mock.calls.every(([, args]) => args._token_hash === hash)).toBe(true);
  });
  it("rejects replayed or wrong claims without a second acknowledgement", async () => {
    const saved = await claim();
    expect(
      (await api("finish", { job_id: job, claim_id: other, outcome: "completed" })).status,
    ).toBe(409);
    await api("finish", { job_id: job, claim_id: saved.claim_id, outcome: "completed" });
    expect(
      (await api("finish", { job_id: job, claim_id: saved.claim_id, outcome: "completed" })).status,
    ).toBe(409);
  });
  it("keeps an uncertain physical outcome failed and never silently resends it", async () => {
    const saved = await claim();
    await api("finish", {
      job_id: job,
      claim_id: saved.claim_id,
      outcome: "outcome_unknown",
      error: "Connection lost after write",
    });
    expect((await db.query("SELECT status,last_error FROM print_jobs")).rows[0]).toMatchObject({
      status: "failed",
      last_error: expect.stringContaining("Physical outcome unknown"),
    });
    expect(await claim()).toBeNull();
  });
  it("requeues a known not-printed outcome on the same business job", async () => {
    const saved = await claim();
    const result = await api("finish", {
      job_id: job,
      claim_id: saved.claim_id,
      outcome: "not_printed",
    });
    expect((await result.json()).status.status).toBe("queued");
    expect(
      (await db.query<{ count: number }>("SELECT count(*)::int AS count FROM print_jobs")).rows[0]!
        .count,
    ).toBe(1);
  });
  it("denies a printer from a different property", async () => {
    await db.exec(`UPDATE printer_profiles SET branch_id='${other}'`);
    expect((await api("claim", { printer_id: printer })).status).toBe(409);
  });
  it("rejects malformed bearer tokens before database dispatch and revoked tokens at the database", async () => {
    expect((await api("claim", {}, "invalid")).status).toBe(401);
    expect(mock.rpc).not.toHaveBeenCalled();
    await db.exec("UPDATE neo_print_agents SET active=false");
    expect((await api("printers")).status).toBe(401);
  });
  it.each([[], {}, { job_id: job }])(
    "does not silently discard a malformed claimed result %j",
    async (data) => {
      mock.rpc.mockResolvedValue({ data, error: null });
      expect((await api("claim", { printer_id: printer })).status).toBe(502);
    },
  );
  it.each([null, {}, { status: "pretend_printed" }])(
    "does not acknowledge missing completion proof %j",
    async (data) => {
      mock.rpc.mockResolvedValue({ data, error: null });
      expect(
        (await api("finish", { job_id: job, claim_id: other, outcome: "completed" })).status,
      ).toBe(502);
    },
  );
});
describe("owned-local discovery PostgreSQL boundary", () => {
  it("reapplies discovery schema safely while refusing a different physical-agent function", async () => {
    const migration = read("supabase/migrations/20261106092000_local_printer_discovery.sql");
    await db.exec(migration);
    await db.exec(
      "CREATE OR REPLACE FUNCTION public.neo_print_agent_claim(_token_hash text,_printer uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$",
    );
    try {
      await expect(db.exec(migration)).rejects.toThrow(
        "differs from reviewed physical-agent source",
      );
    } finally {
      await db.exec("ROLLBACK");
      await db.exec(canonical("neo_print_agent_claim"));
    }
    expect(
      (await db.query<{ count: number }>("SELECT count(*)::int AS count FROM print_jobs")).rows[0]!
        .count,
    ).toBe(1);
  });
  async function request(kind = "network") {
    return query("neo_print_discovery_request", [agent, kind]);
  }
  it("round-trips a persisted request, local report and status through scoped endpoints", async () => {
    const saved = await request();
    expect((await request())["request_id"]).toBe(saved["request_id"]);
    const poll = await api("discovery");
    expect((await poll.json()).request).toEqual({
      request_id: saved["request_id"],
      kind: "network",
    });
    const result = {
      printers: [
        { name: "Actual queue", address: "192.168.1.50:9100", connection_type: "network" },
      ],
      notes: ["No print sent"],
    };
    expect((await api("discovered", { request_id: saved["request_id"], result })).status).toBe(200);
    expect((await query("neo_print_discovery_status", [agent]))["result"]).toEqual(result);
    expect((await api("discovery")).status).toBe(200);
    expect((await (await api("discovery")).json()).request).toBeNull();
  });
  it("does not overwrite an active search with another transport", async () => {
    await request();
    await expect(request("usb")).rejects.toThrow("current printer search");
  });
  it.each(["neo.test_permission", "neo.test_scope"])(
    "checks %s before exposing results or requesting work",
    async (setting) => {
      await db.query("SELECT set_config($1,'no',false)", [setting]);
      await expect(request()).rejects.toThrow();
      await expect(query("neo_print_discovery_status", [agent])).rejects.toThrow();
    },
  );
  it("never accepts a different request identity or an expired report", async () => {
    const saved = await request();
    expect((await api("discovered", { request_id: other, result: { printers: [] } })).status).toBe(
      409,
    );
    await db.exec("UPDATE neo_print_agents SET discovery_requested_at=now()-interval '3 minutes'");
    expect(
      (await api("discovered", { request_id: saved["request_id"], result: { printers: [] } }))
        .status,
    ).toBe(409);
  });
  it("records an acknowledgement once without replacing the results on retry", async () => {
    const saved = await request();
    await api("discovered", {
      request_id: saved["request_id"],
      result: { printers: [], notes: ["first"] },
    });
    await api("discovered", {
      request_id: saved["request_id"],
      result: { printers: [], notes: ["changed"] },
    });
    expect((await query("neo_print_discovery_status", [agent]))["result"]).toEqual({
      printers: [],
      notes: ["first"],
    });
  });
  it("rejects malformed inventory rather than exposing unusable selections", async () => {
    const saved = await request();
    await expect(
      query("neo_print_agent_discovery_report", [
        hash,
        saved["request_id"],
        JSON.stringify({ printers: [{ name: "", connection_type: "network" }] }),
      ]),
    ).rejects.toThrow("Invalid discovered printer");
  });
  it("reserves discovery execution for the appropriate database callers", async () => {
    const rows = (
      await db.query(
        "SELECT has_function_privilege('anon','neo_print_discovery_request(uuid,text)','EXECUTE') AS anon_request,has_function_privilege('authenticated','neo_print_agent_discovery_poll(text)','EXECUTE') AS staff_poll,has_function_privilege('service_role','neo_print_agent_discovery_poll(text)','EXECUTE') AS agent_poll",
      )
    ).rows[0];
    expect(rows).toEqual({ anon_request: false, staff_poll: false, agent_poll: true });
  });
  it("never returns a pending inventory belonging to an earlier search", async () => {
    const saved = await request();
    await api("discovered", { request_id: saved["request_id"], result: { printers: [] } });
    await db.exec("UPDATE neo_print_agents SET discovery_requested_at=now()-interval '3 minutes'");
    const next = await request();
    expect(next["request_id"]).not.toBe(saved["request_id"]);
    expect((await query("neo_print_discovery_status", [agent]))["result"]).toBeNull();
  });
});
