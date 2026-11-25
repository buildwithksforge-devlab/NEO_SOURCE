import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

const ids = {
  org: "30000000-0000-4000-8000-000000000001",
  otherOrg: "40000000-0000-4000-8000-000000000001",

  branch: "30000000-0000-4000-8000-000000000002",
  foreignBranch: "40000000-0000-4000-8000-000000000002",

  waiterA: "30000000-0000-4000-8000-000000000010",
  waiterB: "30000000-0000-4000-8000-000000000011",
  waiterC: "30000000-0000-4000-8000-000000000012",

  order: "30000000-0000-4000-8000-000000000100",
  newOrder: "30000000-0000-4000-8000-000000000101",
  foreignOrder: "40000000-0000-4000-8000-000000000100",
};

type AssignmentHistoryRow = {
  event_type: string;
  previous_waiter_id: string | null;
  new_waiter_id: string | null;
  original_creator_id: string | null;
  changed_by: string | null;
};

const migration = readFileSync(
  "supabase/migrations/" +
    "20261124151000_pos_assignment_accountability.sql",
  "utf8",
);

describe("NE? permanent POS assignment accountability", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();

    await db.exec(`
      CREATE SCHEMA auth;

      CREATE ROLE authenticated;
      CREATE ROLE anon;

      CREATE FUNCTION auth.uid()
      RETURNS uuid
      LANGUAGE sql STABLE
      AS $$
        SELECT NULLIF(
          current_setting('test.actor', true), ''
        )::uuid
      $$;

      CREATE TABLE public.pos_orders (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid,
        waiter_id uuid,
        created_by uuid,
        status text NOT NULL DEFAULT 'draft'
      );

      ALTER TABLE public.pos_orders
      ENABLE ROW LEVEL SECURITY;

      CREATE POLICY pos_test_read
      ON public.pos_orders
      FOR SELECT
      TO authenticated
      USING (
        organization_id = '${ids.org}'::uuid
        AND (
          created_by = auth.uid()
          OR waiter_id = auth.uid()
        )
      );

      GRANT USAGE
      ON SCHEMA public, auth
      TO authenticated;

      GRANT SELECT
      ON public.pos_orders
      TO authenticated;

      INSERT INTO public.pos_orders (
        id, organization_id, branch_id,
        waiter_id, created_by
      )
      VALUES
        (
          '${ids.order}',
          '${ids.org}',
          '${ids.branch}',
          '${ids.waiterA}',
          '${ids.waiterA}'
        ),
        (
          '${ids.foreignOrder}',
          '${ids.otherOrg}',
          '${ids.foreignBranch}',
          '${ids.waiterB}',
          '${ids.waiterB}'
        );

      SET test.actor = '${ids.waiterA}';
    `);

    await db.exec(migration);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("creates an honest baseline for existing orders", async () => {
    const result = await db.query<AssignmentHistoryRow>(
      `SELECT event_type, previous_waiter_id,
              new_waiter_id, original_creator_id,
              changed_by
       FROM public.pos_order_assignment_history
       WHERE order_id = $1::uuid`,
      [ids.order],
    );

    expect(result.rows).toHaveLength(1);

    expect(result.rows[0]?.event_type)
      .toBe("baseline");

    expect(result.rows[0]?.new_waiter_id)
      .toBe(ids.waiterA);

    expect(result.rows[0]?.previous_waiter_id)
      .toBeNull();

    expect(result.rows[0]?.changed_by)
      .toBeNull();
  });

  it("records the first assignment for new orders", async () => {
    await db.query(
      `INSERT INTO public.pos_orders (
         id, organization_id, branch_id,
         created_by, waiter_id
       )
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid)`,
      [
        ids.newOrder,
        ids.org,
        ids.branch,
        ids.waiterA,
        ids.waiterA,
      ],
    );

    const result = await db.query<AssignmentHistoryRow>(
      `SELECT event_type, new_waiter_id, changed_by
       FROM public.pos_order_assignment_history
       WHERE order_id = $1::uuid`,
      [ids.newOrder],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.event_type).toBe("assigned");
    expect(result.rows[0]?.changed_by).toBe(ids.waiterA);
  });

  it("records multiple transfers without erasing earlier owners", async () => {
    await db.query(
      `UPDATE public.pos_orders
       SET waiter_id = $1::uuid
       WHERE id = $2::uuid`,
      [ids.waiterB, ids.order],
    );

    await db.query(
      `UPDATE public.pos_orders
       SET waiter_id = $1::uuid
       WHERE id = $2::uuid`,
      [ids.waiterC, ids.order],
    );

    const result = await db.query<AssignmentHistoryRow>(
      `SELECT event_type, previous_waiter_id,
              new_waiter_id, original_creator_id
       FROM public.pos_order_assignment_history
       WHERE order_id = $1::uuid
       ORDER BY event_at, id`,
      [ids.order],
    );

    const transfers = result.rows.filter(
      (row) => row.event_type === "transferred",
    );

    expect(transfers).toHaveLength(2);

    expect(
      transfers.some(
        (row) =>
          row.previous_waiter_id === ids.waiterA &&
          row.new_waiter_id === ids.waiterB,
      ),
    ).toBe(true);

    expect(
      transfers.some(
        (row) =>
          row.previous_waiter_id === ids.waiterB &&
          row.new_waiter_id === ids.waiterC,
      ),
    ).toBe(true);

    expect(
      result.rows.every(
        (row) => row.original_creator_id === ids.waiterA,
      ),
    ).toBe(true);
  });

  it("does not invent transfer events for unchanged assignments", async () => {
    const before = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM public.pos_order_assignment_history
       WHERE order_id = $1::uuid`,
      [ids.order],
    );

    await db.query(
      `UPDATE public.pos_orders
       SET waiter_id = waiter_id, status = 'closed'
       WHERE id = $1::uuid`,
      [ids.order],
    );

    const after = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM public.pos_order_assignment_history
       WHERE order_id = $1::uuid`,
      [ids.order],
    );

    expect(after.rows[0]?.count)
      .toBe(before.rows[0]?.count);
  });

  it("records removal of an assigned waiter", async () => {
    await db.query(
      `UPDATE public.pos_orders
       SET waiter_id = NULL
       WHERE id = $1::uuid`,
      [ids.order],
    );

    const result = await db.query<AssignmentHistoryRow>(
      `SELECT event_type, previous_waiter_id,
              new_waiter_id
       FROM public.pos_order_assignment_history
       WHERE order_id = $1::uuid
         AND event_type = 'unassigned'`,
      [ids.order],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.previous_waiter_id)
      .toBe(ids.waiterC);
    expect(result.rows[0]?.new_waiter_id).toBeNull();
  });

  it("prevents editing or deleting audit records", async () => {
    await expect(
      db.query(
        `UPDATE public.pos_order_assignment_history
         SET event_type = 'created'
         WHERE order_id = $1::uuid`,
        [ids.order],
      ),
    ).rejects.toThrow("append-only");

    await expect(
      db.query(
        `DELETE FROM public.pos_order_assignment_history
         WHERE order_id = $1::uuid`,
        [ids.order],
      ),
    ).rejects.toThrow("append-only");
  });

  it("uses existing POS visibility rules for reading history", async () => {
    await db.exec("SET ROLE authenticated");

    try {
      await db.query(
        "SELECT set_config('test.actor',$1,false)",
        [ids.waiterA],
      );

      const visible = await db.query<{ order_id: string }>(
        `SELECT order_id
         FROM public.pos_order_assignment_history
         WHERE order_id = $1::uuid`,
        [ids.newOrder],
      );

      expect(visible.rows).toHaveLength(1);

      const foreign = await db.query<{ order_id: string }>(
        `SELECT order_id
         FROM public.pos_order_assignment_history
         WHERE order_id = $1::uuid`,
        [ids.foreignOrder],
      );

      expect(foreign.rows).toHaveLength(0);
    } finally {
      await db.exec("RESET ROLE");
    }
  });


  it("retains assignment audit after a controlled draft deletion", async () => {
    const temporaryOrder =
      "30000000-0000-4000-8000-000000000199";

    await db.query(
      `INSERT INTO public.pos_orders (
         id, organization_id, branch_id,
         created_by, waiter_id
       )
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid)`,
      [
        temporaryOrder,
        ids.org,
        ids.branch,
        ids.waiterA,
        ids.waiterA,
      ],
    );

    await db.query(
      `DELETE FROM public.pos_orders
       WHERE id = $1::uuid`,
      [temporaryOrder],
    );

    const history = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM public.pos_order_assignment_history
       WHERE order_id = $1::uuid`,
      [temporaryOrder],
    );

    expect(history.rows[0]?.count).toBe("1");
  });


  it("rejects assignment events for nonexistent orders", async () => {
    await expect(
      db.query(
        `INSERT INTO public.pos_order_assignment_history (
          organization_id,branch_id,order_id,event_type,
          original_creator_id
        )
        VALUES ($1::uuid,$2::uuid,$3::uuid,'baseline',$4::uuid)`,
        [
          ids.org,
          ids.branch,
          "30000000-0000-4000-8000-000000000198",
          ids.waiterA,
        ],
      ),
    ).rejects.toThrow(
      "Assignment history requires an existing POS order",
    );
  });

  it("rejects forged organization attribution", async () => {
    await expect(
      db.query(
        `INSERT INTO public.pos_order_assignment_history (
          organization_id,branch_id,order_id,event_type,
          original_creator_id
        )
        VALUES ($1::uuid,$2::uuid,$3::uuid,'baseline',$4::uuid)`,
        [
          ids.otherOrg,
          ids.branch,
          ids.order,
          ids.waiterA,
        ],
      ),
    ).rejects.toThrow(
      "Assignment history order identity mismatch",
    );
  });

  it("rejects forged original-creator attribution", async () => {
    await expect(
      db.query(
        `INSERT INTO public.pos_order_assignment_history (
          organization_id,branch_id,order_id,event_type,
          original_creator_id
        )
        VALUES ($1::uuid,$2::uuid,$3::uuid,'baseline',$4::uuid)`,
        [
          ids.org,
          ids.branch,
          ids.order,
          ids.waiterB,
        ],
      ),
    ).rejects.toThrow(
      "Assignment history order identity mismatch",
    );
  });

  it("rejects forged property attribution", async () => {
    await expect(
      db.query(
        `INSERT INTO public.pos_order_assignment_history (
          organization_id,branch_id,order_id,event_type,
          original_creator_id
        )
        VALUES ($1::uuid,$2::uuid,$3::uuid,'baseline',$4::uuid)`,
        [
          ids.org,
          ids.foreignBranch,
          ids.order,
          ids.waiterA,
        ],
      ),
    ).rejects.toThrow(
      "Assignment history order identity mismatch",
    );
  });

  it("does not grant staff permission to rewrite history", async () => {
    await db.exec("SET ROLE authenticated");

    try {
      await expect(
        db.query(
          `DELETE FROM public.pos_order_assignment_history
           WHERE order_id = $1::uuid`,
          [ids.newOrder],
        ),
      ).rejects.toThrow();
    } finally {
      await db.exec("RESET ROLE");
    }
  });
});
