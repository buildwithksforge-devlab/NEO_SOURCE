import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20261112090000_block_virtual_blind_receiving.sql",
  "utf8",
);
const org = "00000000-0000-4000-8000-000000000001";
const branch = "00000000-0000-4000-8000-000000000002";
const actor = "00000000-0000-4000-8000-000000000003";
const submitter = "00000000-0000-4000-8000-000000000004";
const otherActor = "00000000-0000-4000-8000-000000000005";
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

describe("blind receiving virtual-only posting guard", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('neo.test_actor', true), '')::uuid
      $$;
      CREATE FUNCTION public.current_org_id() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT '${org}'::uuid
      $$;
      CREATE FUNCTION public.is_org_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT true
      $$;
      CREATE FUNCTION public.neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT $1 = '${branch}'::uuid
      $$;

      CREATE TABLE public.purchase_orders (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        order_number text NOT NULL,
        status text NOT NULL
      );
      CREATE TABLE public.stock_locations (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid,
        active boolean NOT NULL
      );
      CREATE TABLE public.neo_blind_receiving_counts (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        purchase_order_id uuid NOT NULL,
        receiving_location_id uuid NOT NULL,
        supplier_delivery_note text NOT NULL,
        remarks text,
        status text NOT NULL,
        submitted_by uuid NOT NULL,
        submitted_at timestamptz NOT NULL DEFAULT now(),
        reviewed_by uuid,
        reviewed_at timestamptz,
        review_notes text,
        posted_grn_id uuid
      );
      CREATE TABLE public.neo_blind_receiving_count_lines (
        id uuid PRIMARY KEY,
        count_id uuid NOT NULL,
        purchase_order_line_id uuid NOT NULL,
        quantity_delivered numeric NOT NULL,
        quantity_rejected numeric NOT NULL,
        rejection_reason text,
        batch_number text,
        expiry_date date
      );
      CREATE TABLE public.purchase_order_lines (
        id uuid PRIMARY KEY,
        order_id uuid NOT NULL,
        quantity numeric NOT NULL,
        received_quantity numeric NOT NULL DEFAULT 0,
        cancelled_quantity numeric NOT NULL DEFAULT 0,
        stock_item_id uuid
      );
      CREATE TABLE public.goods_receipts (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        order_id uuid NOT NULL
      );
      CREATE FUNCTION public.neo_stores_receive_goods(
        uuid, uuid, jsonb, uuid, text, text, text, text
      ) RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE
        v_grn uuid := gen_random_uuid();
      BEGIN
        INSERT INTO public.goods_receipts(id, organization_id, order_id)
        VALUES (v_grn, public.current_org_id(), $1);
        RETURN jsonb_build_object('grn_id', v_grn, 'posting', jsonb_build_object('status', 'posted'));
      END
      $$;
    `);
    await db.exec(migration);
    await db.query("SELECT set_config('neo.test_actor', $1, false)", [actor]);
  }, 30_000);

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE public.neo_blind_receiving_count_lines,
        public.neo_blind_receiving_counts,
        public.purchase_order_lines,
        public.purchase_orders,
        public.stock_locations,
        public.goods_receipts;
    `);
  });

  afterAll(async () => {
    await db.close();
  });

  async function seedCount(input: {
    countId: string;
    orderId: string;
    lineId: string;
    orderLineId: string;
    deliveryNote: string;
    remarks?: string;
    reviewNotes?: string;
    submitterId?: string;
  }) {
    const locationId = id(90);
    await db.query("INSERT INTO public.purchase_orders VALUES ($1,$2,$3,$4,'approved')", [
      input.orderId,
      org,
      branch,
      `LPO-${input.orderId.slice(-4)}`,
    ]);
    await db.query("INSERT INTO public.stock_locations VALUES ($1,$2,$3,true)", [
      locationId,
      org,
      branch,
    ]);
    await db.query(
      `INSERT INTO public.neo_blind_receiving_counts
        (id,organization_id,branch_id,purchase_order_id,receiving_location_id,
         supplier_delivery_note,remarks,status,submitted_by,reviewed_by,reviewed_at,review_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'approved',$8,$9,now(),$10)`,
      [
        input.countId,
        org,
        branch,
        input.orderId,
        locationId,
        input.deliveryNote,
        input.remarks ?? null,
        input.submitterId ?? submitter,
        otherActor,
        input.reviewNotes ?? null,
      ],
    );
    await db.query(
      `INSERT INTO public.purchase_order_lines
        (id,order_id,quantity,received_quantity,cancelled_quantity,stock_item_id)
       VALUES ($1,$2,1,0,0,$3)`,
      [input.orderLineId, input.orderId, id(91)],
    );
    await db.query(
      `INSERT INTO public.neo_blind_receiving_count_lines
        (id,count_id,purchase_order_line_id,quantity_delivered,quantity_rejected)
       VALUES ($1,$2,$3,1,0)`,
      [input.lineId, input.countId, input.orderLineId],
    );
  }

  async function post(countId: string) {
    const result = await db.query<{ result: unknown }>(
      "SELECT public.neo_post_approved_blind_receiving($1) AS result",
      [countId],
    );
    const row = result.rows[0]?.["result"];
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("Posting RPC did not return a result object");
    }
    return row as Record<string, unknown>;
  }

  async function queueRow() {
    const result = await db.query<{ result: unknown }>(
      "SELECT public.neo_blind_receiving_approved_queue() AS result",
    );
    const rows = result.rows[0]?.["result"];
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new Error("Approved receiving queue did not return one count");
    }
    const row = rows[0];
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("Approved receiving queue returned an invalid count");
    }
    return row as Record<string, unknown>;
  }

  it("surfaces and refuses explicitly virtual counts before any GRN or stock posting", async () => {
    const countId = id(10);
    await seedCount({
      countId,
      orderId: id(11),
      lineId: id(12),
      orderLineId: id(13),
      deliveryNote: "NEO-UAT-DN2-REPLACEMENT",
      reviewNotes: "Virtual test only; no real goods/payment or supplier commitment.",
    });

    const row = await queueRow();
    expect(row["posting_block_reason"]).toMatch(/virtual\/test-only/i);
    await expect(post(countId)).rejects.toThrow(/virtual\/test-only/i);

    const count = await db.query(
      "SELECT status, posted_grn_id FROM public.neo_blind_receiving_counts WHERE id = $1",
      [countId],
    );
    const receipts = await db.query("SELECT id FROM public.goods_receipts");
    expect(count.rows[0]).toEqual({ status: "approved", posted_grn_id: null });
    expect(receipts.rows).toHaveLength(0);
  });

  it("continues to post genuine approved counts once and replay the saved GRN", async () => {
    const countId = id(20);
    await seedCount({
      countId,
      orderId: id(21),
      lineId: id(22),
      orderLineId: id(23),
      deliveryNote: "SUPPLIER-DN-204",
      reviewNotes: "Physical delivery counted and independently approved.",
    });

    const row = await queueRow();
    expect(row["posting_block_reason"]).toBeNull();

    const first = await post(countId);
    const replay = await post(countId);
    const receipts = await db.query("SELECT id FROM public.goods_receipts");
    expect(first["status"]).toBe("posted");
    expect(replay["replayed"]).toBe(true);
    expect(replay["grn_id"]).toBe(first["grn_id"]);
    expect(receipts.rows).toHaveLength(1);
  });

  it("retains the independent maker/poster guard", async () => {
    const countId = id(30);
    await seedCount({
      countId,
      orderId: id(31),
      lineId: id(32),
      orderLineId: id(33),
      deliveryNote: "SUPPLIER-DN-305",
      submitterId: actor,
    });

    await expect(post(countId)).rejects.toThrow(/cannot post your own receiving count/i);
    const receipts = await db.query("SELECT id FROM public.goods_receipts");
    expect(receipts.rows).toHaveLength(0);
  });
});
