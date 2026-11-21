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
      CREATE TABLE delivery_orders (id uuid PRIMARY KEY, organization_id uuid, rider_id uuid, order_status text);
      CREATE TABLE delivery_dispatch_jobs (id uuid PRIMARY KEY, delivery_order_id uuid, organization_id uuid, state text, state_detail text);
      CREATE TABLE delivery_dispatch_events (organization_id uuid, job_id uuid, from_state text, to_state text, detail text);
    `);
    await db.exec(readFileSync("supabase/migrations/20261121123500_courier_handoff_exclusivity.sql", "utf8"));
  });

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE delivery_dispatch_events, delivery_dispatch_jobs, delivery_orders;
      INSERT INTO delivery_orders VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', NULL, 'ready-for-pickup');
      INSERT INTO delivery_dispatch_jobs VALUES ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'requested', NULL);
    `);
  });

  afterAll(async () => db?.close());

  const claim = `UPDATE delivery_dispatch_jobs SET state='sent', state_detail='Handoff started. Waiting for courier confirmation.' WHERE state='requested' RETURNING id`;
  const assign = `UPDATE delivery_orders SET rider_id='00000000-0000-0000-0000-000000000004'`;

  it("claims once, records the transition and blocks manual assignment while courier confirmation is pending", async () => {
    expect((await db.query(claim)).rows).toHaveLength(1);
    expect((await db.query(claim)).rows).toHaveLength(0);
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
});
