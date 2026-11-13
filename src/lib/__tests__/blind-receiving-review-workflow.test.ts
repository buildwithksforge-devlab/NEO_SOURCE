import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20261112160000_atomic_blind_receiving_review.sql",
  "utf8",
).replace(
  /-- BEGIN REVIEWED CORE RECEIVING REPAIR[\s\S]*?-- END REVIEWED CORE RECEIVING REPAIR/,
  "",
);
// This describe tests the independent-review wrapper with a posting boundary.
// The separate real-engine describe below runs the full migration and engine.
const org = "00000000-0000-4000-8000-000000000001";
const branch = "00000000-0000-4000-8000-000000000002";
const reviewer = "00000000-0000-4000-8000-000000000003";
const submitter = "00000000-0000-4000-8000-000000000004";
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

describe("blind receiving reconciliation and approval", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE SCHEMA auth;
      CREATE ROLE authenticated;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('neo.test_actor', true), '')::uuid
      $$;
      CREATE FUNCTION public.current_org_id() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT '${org}'::uuid
      $$;
      CREATE FUNCTION public.is_org_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT true
      $$;
      CREATE FUNCTION public.has_permission(text,text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
      CREATE FUNCTION public.neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT $1 = '${branch}'::uuid
      $$;

      CREATE TABLE public.purchase_orders (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        order_number text NOT NULL,
        status text NOT NULL DEFAULT 'approved'
      );
      CREATE TABLE public.goods_receipts (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        order_id uuid NOT NULL
      );
      CREATE TABLE public.goods_receipt_lines (id uuid PRIMARY KEY);
      CREATE TABLE public.stock_locations (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid,
        active boolean NOT NULL
      );
      CREATE TABLE public.stock_items (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        name text NOT NULL
      );
      CREATE TABLE public.purchase_order_lines (
        id uuid PRIMARY KEY,
        order_id uuid NOT NULL,
        quantity numeric NOT NULL,
        received_quantity numeric NOT NULL DEFAULT 0,
        cancelled_quantity numeric NOT NULL DEFAULT 0,
        stock_item_id uuid,
        description text,
        unit text
        , accepted_quantity numeric NOT NULL DEFAULT 0
      );
      GRANT DELETE ON public.purchase_orders,
        public.purchase_order_lines,
        public.goods_receipts,
        public.goods_receipt_lines TO authenticated;
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
      CREATE TABLE public.posting_events (id uuid PRIMARY KEY, count_id uuid NOT NULL);
      CREATE FUNCTION public.neo_stores_receive_goods(
        uuid, uuid, jsonb, uuid, text, text, text, text
      )
      RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE
        v_order_id uuid := $1;
        v_attempt_id uuid := $4;
        v_grn_id uuid := '${id(70)}'::uuid;
      BEGIN
        IF current_setting('neo.test_post_failure', true) = 'true' THEN
          INSERT INTO public.posting_events VALUES (v_grn_id, v_attempt_id);
          RAISE EXCEPTION 'Simulated stock posting failure';
        END IF;
        INSERT INTO public.goods_receipts VALUES (v_grn_id, '${org}', v_order_id);
        INSERT INTO public.posting_events VALUES (v_grn_id, v_attempt_id);
        RETURN jsonb_build_object('ok', true, 'status', 'posted', 'grn_id', v_grn_id);
      END
      $$;
    `);
    await db.exec(migration);
    await db.query("SELECT set_config('neo.test_actor', $1, false)", [reviewer]);
  }, 30_000);

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE public.posting_events,
        public.neo_blind_receiving_count_lines,
        public.neo_blind_receiving_counts,
        public.purchase_order_lines,
        public.purchase_orders,
        public.stock_locations,
        public.stock_items;
    `);
    await db.query("SELECT set_config('neo.test_actor', $1, false)", [reviewer]);
    await db.query("INSERT INTO public.purchase_orders VALUES ($1, $2, $3, $4, 'approved')", [
      id(10),
      org,
      branch,
      "LPO-10",
    ]);
    await db.query("INSERT INTO public.stock_locations VALUES ($1, $2, $3, true)", [
      id(14),
      org,
      branch,
    ]);
    await db.query("INSERT INTO public.stock_items VALUES ($1, $2, $3)", [id(11), org, "Rice"]);
    await db.query(
      `INSERT INTO public.purchase_order_lines
       (id, order_id, quantity, received_quantity, cancelled_quantity, stock_item_id, description, unit)
       VALUES ($1, $2, 10, 0, 0, $3, 'Rice', 'kg')`,
      [id(12), id(10), id(11)],
    );
    await db.query(
      `INSERT INTO public.neo_blind_receiving_counts
       (id, organization_id, branch_id, purchase_order_id, receiving_location_id,
        supplier_delivery_note, status, submitted_by)
       VALUES ($1, $2, $3, $4, $5, 'DN-10', 'submitted', $6)`,
      [id(13), org, branch, id(10), id(14), submitter],
    );
    await db.query(
      `INSERT INTO public.neo_blind_receiving_count_lines
       (id, count_id, purchase_order_line_id, quantity_delivered, quantity_rejected)
       VALUES ($1, $2, $3, 10, 0)`,
      [id(15), id(13), id(12)],
    );
  });

  afterAll(async () => {
    await db.close();
  });

  async function queue() {
    const result = await db.query<{ rows: unknown }>(
      "SELECT public.neo_blind_receiving_review_queue() AS rows",
    );
    return result.rows[0]?.["rows"] as Array<Record<string, unknown>>;
  }

  async function decide(countId: string, decision: "approved" | "rejected") {
    const result = await db.query<{ result: unknown }>(
      "SELECT public.neo_blind_receiving_decide($1, $2, 'checked quantities') AS result",
      [countId, decision],
    );
    return result.rows[0]?.["result"] as Record<string, unknown>;
  }

  it("shows a submitter's pending count without allowing self-approval", async () => {
    await db.query("SELECT set_config('neo.test_actor', $1, false)", [submitter]);

    const rows = await queue();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["submitted_by_current_user"]).toBe(true);
    await expect(decide(id(13), "approved")).rejects.toThrow(/cannot review your own/i);

    const counts = await db.query(
      "SELECT status, posted_grn_id FROM public.neo_blind_receiving_counts WHERE id = $1",
      [id(13)],
    );
    expect(counts.rows[0]).toEqual({ status: "submitted", posted_grn_id: null });
  });

  it("posts accepted quantity once when an independent reviewer approves", async () => {
    await db.query(
      `UPDATE public.neo_blind_receiving_count_lines
       SET quantity_delivered = 12, quantity_rejected = 2
       WHERE id = $1`,
      [id(15)],
    );

    const rows = await queue();
    const line = (rows[0]?.["lines"] as Array<Record<string, unknown>>)[0];
    expect(line?.["accepted_quantity"]).toBe(10);
    expect(line?.["reconciliation_result"]).toBe("matched");

    const result = await decide(id(13), "approved");
    expect(result["status"]).toBe("posted");
    expect(result["stock_posted"]).toBe(true);
    expect(result["grn_id"]).toBe(id(70));

    await expect(decide(id(13), "approved")).rejects.toThrow(/already been decided/i);
    const counts = await db.query(
      "SELECT status, posted_grn_id FROM public.neo_blind_receiving_counts WHERE id = $1",
      [id(13)],
    );
    const postings = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.posting_events",
    );
    expect(counts.rows[0]).toEqual({ status: "posted", posted_grn_id: id(70) });
    expect(postings.rows[0]?.["count"]).toBe(1);
  });

  it("does not post stock when a count is rejected", async () => {
    const result = await decide(id(13), "rejected");
    expect(result["status"]).toBe("rejected");
    expect(result["stock_posted"]).toBe(false);
    const postings = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.posting_events",
    );
    expect(postings.rows[0]?.["count"]).toBe(0);
  });

  it("rolls approval back if GRN or stock posting fails", async () => {
    await db.query("SELECT set_config('neo.test_post_failure', 'true', false)");
    await expect(decide(id(13), "approved")).rejects.toThrow(/simulated stock posting failure/i);
    await db.query("SELECT set_config('neo.test_post_failure', 'false', false)");

    const counts = await db.query(
      "SELECT status, reviewed_by, posted_grn_id FROM public.neo_blind_receiving_counts WHERE id = $1",
      [id(13)],
    );
    const postings = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.posting_events",
    );
    expect(counts.rows[0]).toEqual({
      status: "submitted",
      reviewed_by: null,
      posted_grn_id: null,
    });
    expect(postings.rows[0]?.["count"]).toBe(0);
  });

  it("prevents authenticated users from deleting LPOs, GRNs, or their lines", async () => {
    for (const table of [
      "purchase_orders",
      "purchase_order_lines",
      "goods_receipts",
      "goods_receipt_lines",
    ]) {
      const result = await db.query<{ allowed: boolean }>(
        "SELECT has_table_privilege('authenticated', $1, 'DELETE') AS allowed",
        [`public.${table}`],
      );
      expect(result.rows[0]?.["allowed"]).toBe(false);
    }
  });
});

describe("reviewed receiving engine with actual inventory receipt posting", () => {
  let db: PGlite;
  const order = id(301),
    line = id(302),
    store = id(303),
    item = id(304);
  const coreSource = readFileSync(
    "supabase/migrations/20261025100000_o03_grn_quantity_integrity.sql",
    "utf8",
  );
  const inventorySource = readFileSync(
    "supabase/migrations/20260831050052_abb267b0-992c-448b-9292-715775ac34ba.sql",
    "utf8",
  );
  const inventoryStart = inventorySource.indexOf(
    "CREATE OR REPLACE FUNCTION public.inventory_post_receipt(",
  );
  const inventoryEnd =
    inventorySource.indexOf(
      "$function$;",
      inventorySource.indexOf("AS $function$", inventoryStart),
    ) + "$function$;".length;
  const fullReview = readFileSync(
    "supabase/migrations/20261112160000_atomic_blind_receiving_review.sql",
    "utf8",
  );
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role; CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${reviewer}'::uuid $$;
      CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
      CREATE FUNCTION is_org_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
      CREATE FUNCTION has_permission(text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.receive_permission',true),'yes')='yes' $$;
      CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${branch}'::uuid $$;
      CREATE FUNCTION next_document_number(text,text,uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'GRN-'||gen_random_uuid()::text $$;
      CREATE TABLE purchase_orders(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,status text,supplier_id uuid,order_number text);
      CREATE TABLE purchase_order_lines(id uuid PRIMARY KEY,order_id uuid,stock_item_id uuid,quantity numeric,cancelled_quantity numeric DEFAULT 0,
        received_quantity numeric DEFAULT 0,accepted_quantity numeric DEFAULT 0,rejected_quantity numeric DEFAULT 0,returned_quantity numeric DEFAULT 0,unit text,unit_price numeric,description text);
      CREATE TABLE stock_locations(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,active boolean);
      CREATE TABLE stock_items(id uuid PRIMARY KEY,organization_id uuid,base_unit text,name text);
      CREATE TABLE procurement_attempts(organization_id uuid,action text,attempt_key uuid,record_id uuid,result jsonb,UNIQUE(organization_id,action,attempt_key));
      CREATE TABLE goods_receipts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,order_id uuid,supplier_id uuid,location_id uuid,
        grn_number text,status text,received_at timestamptz,received_by uuid,notes text,delivery_note_number text,supplier_invoice_number text,
        posted_at timestamptz,total_value numeric,accrual_journal_id uuid,accrual_error text,is_partial boolean);
      CREATE TABLE goods_receipt_lines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,receipt_id uuid,order_line_id uuid,stock_item_id uuid,
        quantity_ordered numeric,quantity_previously_received numeric,quantity_received numeric,quantity_rejected numeric,quantity_damaged numeric,
        quantity_returned numeric DEFAULT 0,quantity_accepted numeric,unit text,unit_price numeric,batch_number text,expiry_date date,location_id uuid,
        notes text,rejection_reason text,over_receipt_reason text);
      CREATE TABLE neo_blind_receiving_counts(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,purchase_order_id uuid,receiving_location_id uuid,
        supplier_delivery_note text,remarks text,status text,submitted_by uuid,submitted_at timestamptz DEFAULT now(),reviewed_by uuid,reviewed_at timestamptz,
        review_notes text,posted_grn_id uuid);
      CREATE TABLE neo_blind_receiving_count_lines(id uuid PRIMARY KEY,count_id uuid,purchase_order_line_id uuid,quantity_delivered numeric,quantity_rejected numeric,
        rejection_reason text,batch_number text,expiry_date date);
      -- Movement and Finance adapters are fixture boundaries. The receiving
      -- engine and inventory_post_receipt below are actual repository routines.
      CREATE TABLE movement_evidence(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),item uuid,location uuid,quantity numeric,receipt uuid,attempt text UNIQUE);
      CREATE TABLE journal_evidence(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),receipt uuid UNIQUE,debit numeric,credit numeric);
      CREATE TABLE failed_finance_evidence(receipt uuid,detail text);
      CREATE FUNCTION inventory_convert(numeric,text,text) RETURNS numeric LANGUAGE sql AS $$ SELECT $1 $$;
      CREATE FUNCTION inventory_apply_movement(uuid,uuid,numeric,text,text,numeric,text,uuid,text,text,text,date) RETURNS uuid LANGUAGE plpgsql AS $$
      DECLARE movement uuid;
      BEGIN
        IF current_setting('test.stock_failure',true)='yes' THEN RAISE EXCEPTION 'Stock movement failed'; END IF;
        INSERT INTO movement_evidence(item,location,quantity,receipt,attempt) VALUES($1,$2,$3,$8,$10) RETURNING id INTO movement;
        RETURN movement;
      END $$;
      CREATE FUNCTION neo_grn_post_accrual(uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE journal uuid;
      BEGIN
        IF current_setting('test.finance_failure',true)='yes' THEN RAISE EXCEPTION 'Finance unavailable'; END IF;
        INSERT INTO journal_evidence(receipt,debit,credit) SELECT id,total_value,total_value FROM goods_receipts WHERE id=$1
          ON CONFLICT(receipt) DO UPDATE SET receipt=EXCLUDED.receipt RETURNING id INTO journal;
        UPDATE goods_receipts SET accrual_journal_id=journal WHERE id=$1;
        RETURN jsonb_build_object('journal_id',journal);
      END $$;
      CREATE FUNCTION neo_record_posting_receipt(uuid,uuid,text,uuid,text,text,numeric,text,uuid,text,text,date) RETURNS uuid LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO failed_finance_evidence VALUES($4,$11); RETURN gen_random_uuid(); END $$;
    `);
    await db.exec(coreSource);
    await db.exec(inventorySource.slice(inventoryStart, inventoryEnd));
    await db.exec(fullReview);
  }, 30000);
  beforeEach(async () => {
    await db.exec(`TRUNCATE purchase_orders,purchase_order_lines,stock_locations,stock_items,procurement_attempts,goods_receipts,goods_receipt_lines,
      neo_blind_receiving_counts,neo_blind_receiving_count_lines,movement_evidence,journal_evidence,failed_finance_evidence;
      SELECT set_config('test.receive_permission','yes',false),set_config('test.stock_failure','no',false),set_config('test.finance_failure','no',false);
      INSERT INTO purchase_orders VALUES('${order}','${org}','${branch}','approved','${id(305)}','LPO-REAL-ENGINE');
      INSERT INTO purchase_order_lines(id,order_id,stock_item_id,quantity,unit,unit_price,description) VALUES('${line}','${order}','${item}',10,'kg',50,'Rice');
      INSERT INTO stock_locations VALUES('${store}','${org}','${branch}',true);
      INSERT INTO stock_items VALUES('${item}','${org}','kg','Rice');`);
  });
  afterAll(async () => {
    await db.close();
  });
  const receive = async (
    delivered: number,
    rejected = 0,
    attempt = crypto.randomUUID(),
    extras = {},
  ) => {
    const result = await db.query<{ result: Record<string, unknown> }>(
      "SELECT neo_stores_receive_goods($1,$2,$3::jsonb,$4,NULL,NULL,NULL,NULL) result",
      [
        order,
        store,
        JSON.stringify([
          {
            order_line_id: line,
            quantity_received: delivered,
            quantity_rejected: rejected,
            rejection_reason: rejected ? "Quality rejected" : null,
            ...extras,
          },
        ]),
        attempt,
      ],
    );
    return result.rows[0]!.result;
  };
  it("preserves 12 physically delivered/2 rejected while posting only 10 accepted and value 500", async () => {
    const result = await receive(12, 2);
    expect(
      (
        await db.query(
          "SELECT quantity_received,quantity_rejected,quantity_accepted FROM goods_receipt_lines",
        )
      ).rows[0],
    ).toEqual({ quantity_received: "12", quantity_rejected: "2", quantity_accepted: "10" });
    expect(
      (
        await db.query(
          "SELECT received_quantity,accepted_quantity,rejected_quantity FROM purchase_order_lines",
        )
      ).rows[0],
    ).toEqual({ received_quantity: "12", accepted_quantity: "10", rejected_quantity: "2" });
    expect((await db.query("SELECT quantity FROM movement_evidence")).rows[0]).toEqual({
      quantity: "10",
    });
    expect((await db.query("SELECT debit,credit FROM journal_evidence")).rows[0]).toEqual({
      debit: "500",
      credit: "500",
    });
    expect(result['partial']).toBe(false);
  });
  it("permits replacement of rejected goods after a partial receipt, without counting physical deliveries twice", async () => {
    await receive(6, 2);
    await receive(6);
    const row = (
      await db.query("SELECT received_quantity,accepted_quantity FROM purchase_order_lines")
    ).rows[0];
    expect(row).toEqual({ received_quantity: "12", accepted_quantity: "10" });
    expect(
      (await db.query("SELECT sum(quantity) quantity FROM movement_evidence")).rows[0],
    ).toEqual({ quantity: "10" });
  });
  it("returns the original receipt on retry but refuses changed input under the same identity", async () => {
    const attempt = crypto.randomUUID();
    const first = await receive(6, 2, attempt);
    expect((await receive(6, 2, attempt))['receipt_id']).toBe(first['receipt_id']);
    await expect(receive(5, 1, attempt)).rejects.toThrow("receipt_attempt_input_mismatch");
    expect((await db.query("SELECT count(*)::int n FROM movement_evidence")).rows[0]).toEqual({
      n: 1,
    });
  });
  it("refuses net over-receipt and rolls back the complete GRN", async () => {
    await expect(receive(12, 1)).rejects.toThrow("over_receipt_refused");
    expect((await db.query("SELECT count(*)::int n FROM goods_receipts")).rows[0]).toEqual({
      n: 0,
    });
  });
  it("does not return a previous receipt to a caller whose receiving authority was revoked", async () => {
    const attempt = crypto.randomUUID();
    await receive(10, 0, attempt);
    await db.exec("SELECT set_config('test.receive_permission','no',false)");
    await expect(receive(10, 0, attempt)).rejects.toThrow("insufficient_privilege");
    expect((await db.query("SELECT count(*)::int n FROM movement_evidence")).rows[0]).toEqual({
      n: 1,
    });
  });
  it("refuses foreign property line-location overrides", async () => {
    await db.exec(`INSERT INTO stock_locations VALUES('${id(399)}','${org}','${id(398)}',true)`);
    await expect(receive(10, 0, crypto.randomUUID(), { location_id: id(399) })).rejects.toThrow(
      "receipt_line_location_out_of_scope",
    );
    expect((await db.query("SELECT count(*)::int n FROM goods_receipts")).rows[0]).toEqual({
      n: 0,
    });
  });
  it("rolls GRN and order quantities back if real receipt posting cannot deliver stock", async () => {
    await db.exec("SELECT set_config('test.stock_failure','yes',false)");
    await expect(receive(10)).rejects.toThrow("Stock movement failed");
    expect((await db.query("SELECT count(*)::int n FROM goods_receipts")).rows[0]).toEqual({
      n: 0,
    });
    expect((await db.query("SELECT accepted_quantity FROM purchase_order_lines")).rows[0]).toEqual({
      accepted_quantity: "0",
    });
  });
  it("retains Finance failure visibly and retries accrual without another stock movement", async () => {
    await db.exec("SELECT set_config('test.finance_failure','yes',false)");
    const result = await receive(10);
    expect(result['posting']).toMatchObject({
      status: "pending-finance",
      finance_error: "Finance unavailable",
    });
    expect((await db.query("SELECT count(*)::int n FROM failed_finance_evidence")).rows[0]).toEqual(
      { n: 1 },
    );
    await db.exec("SELECT set_config('test.finance_failure','no',false)");
    await db.query("SELECT inventory_post_receipt($1)", [result['receipt_id']]);
    expect((await db.query("SELECT count(*)::int n FROM movement_evidence")).rows[0]).toEqual({
      n: 1,
    });
    expect((await db.query("SELECT debit,credit FROM journal_evidence")).rows[0]).toEqual({
      debit: "500",
      credit: "500",
    });
  });
  it("allows the delegated receiving manager to approve and post through the actual engine", async () => {
    await db.exec(`INSERT INTO neo_blind_receiving_counts(id,organization_id,branch_id,purchase_order_id,receiving_location_id,supplier_delivery_note,status,submitted_by)
      VALUES('${id(306)}','${org}','${branch}','${order}','${store}','ACTUAL GOODS','submitted','${submitter}');
      INSERT INTO neo_blind_receiving_count_lines(id,count_id,purchase_order_line_id,quantity_delivered,quantity_rejected,rejection_reason)
      VALUES('${id(307)}','${id(306)}','${line}',12,2,'Quality rejected')`);
    const result = await db.query<{ result: Record<string, unknown> }>(
      "SELECT neo_blind_receiving_decide($1,'approved','Count checked') result",
      [id(306)],
    );
    expect(result.rows[0]!.result['stock_posted']).toBe(true);
    expect((await db.query("SELECT quantity FROM movement_evidence")).rows[0]).toEqual({
      quantity: "10",
    });
  });
  it("refuses unknown installed receiving code before installing any replacement", async () => {
    const original = (
      await db.query<{ body: string }>(
        "SELECT pg_get_functiondef('neo_stores_receive_goods(uuid,uuid,jsonb,uuid,text,text,text,text)'::regprocedure) body",
      )
    ).rows[0]!.body;
    await db.exec(original.replace("DECLARE", "DECLARE\n -- unreviewed source drift\n"));
    await expect(db.exec(fullReview)).rejects.toThrow(
      "Receiving engine differs from reviewed source",
    );
    await db.exec("ROLLBACK");
    await db.exec(original);
  });
  it("reapplies reviewed definitions without reposting stock or changing receipt history", async () => {
    await receive(10);
    await db.exec(fullReview);
    expect((await db.query("SELECT count(*)::int n FROM movement_evidence")).rows[0]).toEqual({
      n: 1,
    });
    expect(
      (await db.query("SELECT received_quantity,accepted_quantity FROM purchase_order_lines"))
        .rows[0],
    ).toEqual({ received_quantity: "10", accepted_quantity: "10" });
  });
});
