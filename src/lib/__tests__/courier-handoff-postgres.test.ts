import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

describe("courier and in-house rider handoff", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.actor', true), '')::uuid $$;
      CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-0000-0000-000000000002'::uuid $$;
      CREATE FUNCTION has_permission(text, text, text DEFAULT NULL) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
      CREATE TABLE delivery_orders (id uuid PRIMARY KEY, organization_id uuid, rider_id uuid, order_status text);
      CREATE TABLE delivery_dispatch_jobs (id uuid PRIMARY KEY, delivery_order_id uuid, organization_id uuid, state text, state_detail text, branch_id uuid, updated_at timestamptz);
      CREATE TABLE delivery_dispatch_events (organization_id uuid, job_id uuid, from_state text, to_state text, detail text);
    `);
    await db.exec(readFileSync("supabase/migrations/20261121123500_courier_handoff_exclusivity.sql", "utf8"));
    await db.exec(readFileSync("supabase/migrations/20261121123600_courier_handoff_claim.sql", "utf8"));
  });

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE delivery_dispatch_events, delivery_dispatch_jobs, delivery_orders;
      INSERT INTO delivery_orders VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', NULL, 'ready-for-pickup');
      INSERT INTO delivery_dispatch_jobs (id, delivery_order_id, organization_id, state) VALUES ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'requested');
      SET test.actor = '00000000-0000-0000-0000-000000000005';
    `);
  });

  afterAll(async () => db?.close());

  const claim = `SELECT neo_delivery_dispatch_claim('00000000-0000-0000-0000-000000000003') AS claimed`;
  const assign = `UPDATE delivery_orders SET rider_id='00000000-0000-0000-0000-000000000004'`;

  it("claims once, records the transition and blocks manual assignment while courier confirmation is pending", async () => {
    expect((await db.query(claim)).rows).toEqual([{ claimed: true }]);
    expect((await db.query(claim)).rows).toEqual([{ claimed: false }]);
    await expect(db.exec(assign)).rejects.toMatchObject({ code: "23514" });
    expect((await db.query("SELECT from_state, to_state FROM delivery_dispatch_events")).rows).toEqual([
      { from_state: "requested", to_state: "sent" },
    ]);
    await db.exec("UPDATE delivery_dispatch_jobs SET state='failed'");
    await expect(db.exec(assign)).resolves.toBeDefined();
  });

  it("blocks a courier handoff after the in-house rider won the assignment", async () => {
    await db.exec(assign);
    await expect(db.query(claim)).rejects.toMatchObject({ code: "23514" });
    expect((await db.query("SELECT state FROM delivery_dispatch_jobs")).rows).toEqual([{ state: "requested" }]);
  });

  it("refuses anonymous callers and jobs outside the dispatcher's branch scope", async () => {
    expect((await db.query("SELECT has_function_privilege('anon', 'public.neo_delivery_dispatch_claim(uuid)', 'EXECUTE') AS allowed")).rows).toEqual([{ allowed: false }]);
    await db.exec("UPDATE delivery_dispatch_jobs SET branch_id='00000000-0000-0000-0000-000000000006'");
    expect((await db.query(claim)).rows).toEqual([{ claimed: false }]);
    await db.exec("RESET test.actor");
    await expect(db.query(claim)).rejects.toMatchObject({ code: "42501" });
  });
});
