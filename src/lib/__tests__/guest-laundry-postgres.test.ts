import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
const read = (name: string) =>
  readFileSync(`supabase/migrations/${name}`, "utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n");
function fn(file: string, name: string, delimiter = "function") {
  const sql = read(file);
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const tag = delimiter === "plain" ? "$$" : `$${delimiter}$`;
  const body = sql.indexOf(`AS ${tag}`, start);
  const end = sql.indexOf(`${tag};`, body + tag.length + 3);
  if (start < 0 || body < 0 || end < 0) throw new Error(`Missing canonical function ${name}`);
  return sql.slice(start, end + tag.length + 1);
}
const org = "00000000-0000-0000-0000-000000000001",
  branch = "00000000-0000-0000-0000-000000000002";
const room = "00000000-0000-0000-0000-000000000205",
  stay = "00000000-0000-0000-0000-000000000003";
const reservation = "00000000-0000-0000-0000-000000000004",
  customer = "00000000-0000-0000-0000-000000000005";
const folio = "00000000-0000-0000-0000-000000000006",
  price = "00000000-0000-0000-0000-000000000007";
const actor = "00000000-0000-0000-0000-000000000008";

describe("guest laundry atomic intake and first folio posting", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${actor}'::uuid $$;
    CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
    CREATE FUNCTION has_permission(text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('neo.test_permission',true),'yes')<>'no' $$;
    CREATE FUNCTION has_permission(text,text,text) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('neo.test_permission',true),'yes')<>'no' $$;
    CREATE FUNCTION is_org_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT $1='${branch}'::uuid AND coalesce(current_setting('neo.test_scope',true),'yes')<>'no' $$;
    CREATE FUNCTION neo_system_posting() RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('neo.system_posting',true),'off')='on' $$;
    CREATE SEQUENCE document_seq;
    CREATE FUNCTION next_document_number(text) RETURNS text LANGUAGE sql AS $$ SELECT 'LN-'||nextval('document_seq') $$;
    CREATE FUNCTION neo_fact_currency(uuid,uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'KES'::text $$;
    CREATE FUNCTION neo_canonical_posting_module(text) RETURNS text LANGUAGE sql AS $$ SELECT $1 $$;
    CREATE TABLE rooms(id uuid,organization_id uuid,branch_id uuid);
    CREATE TABLE reservations(id uuid,organization_id uuid,branch_id uuid,customer_id uuid);
    CREATE TABLE stays(id uuid,organization_id uuid,branch_id uuid,room_id uuid,reservation_id uuid,customer_id uuid,status text,checked_out_at timestamptz);
    CREATE TABLE folios(id uuid,organization_id uuid,branch_id uuid,reservation_id uuid,stay_id uuid,customer_id uuid,corporate_account_id uuid,
      folio_type text DEFAULT 'guest',status text DEFAULT 'open',currency text DEFAULT 'KES',created_at timestamptz DEFAULT now(),total_charges numeric DEFAULT 0,
      total_discounts numeric DEFAULT 0,total_taxes numeric DEFAULT 0,balance numeric DEFAULT 0,updated_at timestamptz);
    CREATE TABLE laundry_price_items(id uuid,organization_id uuid,branch_id uuid,name text,service_type text,normal_price numeric,express_price numeric,tax_rate numeric,active boolean DEFAULT true);
    CREATE TABLE guest_laundry_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,laundry_number text,customer_id uuid,
      reservation_id uuid,folio_id uuid,room_id uuid,service_type text,express boolean,express_charge numeric,special_instructions text,status text DEFAULT 'requested',
      created_by uuid,subtotal numeric DEFAULT 0,tax_amount numeric DEFAULT 0,total numeric DEFAULT 0,posting_status text DEFAULT 'unposted',folio_line_id uuid,
      discrepancy_notes text,posted_at timestamptz,delivered_at timestamptz,delivery_confirmed_by text,collected_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz);
    CREATE TABLE guest_laundry_items(id uuid DEFAULT gen_random_uuid(),organization_id uuid,order_id uuid REFERENCES guest_laundry_orders(id) ON DELETE CASCADE,
      price_item_id uuid,description text,service_type text,quantity numeric,unit_price numeric,tax_rate numeric,line_total numeric);
    CREATE TABLE laundry_batches(id uuid DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,guest_order_id uuid,batch_kind text,status text,created_at timestamptz DEFAULT now());
    CREATE TABLE audit_logs(id uuid DEFAULT gen_random_uuid(),organization_id uuid,user_id uuid,user_name text,action text,module text,record_id text,previous_value jsonb,new_value jsonb);
    CREATE FUNCTION log_audit_event(text,text,text,jsonb,jsonb,text,text,uuid,uuid,uuid,text,jsonb,text) RETURNS uuid LANGUAGE plpgsql AS $$
      DECLARE v_id uuid; BEGIN
      IF coalesce(current_setting('neo.test_audit_failure',true),'no')='yes' THEN RAISE EXCEPTION 'Controlled audit failure'; END IF;
      INSERT INTO audit_logs(organization_id,action,module,record_id,new_value) VALUES(current_org_id(),$1,$2,$3,$5) RETURNING id INTO v_id;
      RETURN v_id; END $$;
    CREATE FUNCTION log_audit_event(uuid,text,text,text,jsonb,jsonb,text) RETURNS uuid LANGUAGE sql AS $$
      SELECT public.log_audit_event($2,$3,$4,$5,$6,$7,NULL,NULL,NULL,NULL,NULL,NULL,NULL) $$;
    CREATE TABLE folio_lines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,folio_id uuid,reservation_id uuid,customer_id uuid,
      line_type text,category text,revenue_centre text,reference text,source_module text,source_record_id text,source_record_uuid uuid,idempotency_key text,
      description text,quantity numeric,unit_price numeric,gross_amount numeric,discount_amount numeric,tax_amount numeric,service_charge_amount numeric,
      net_amount numeric,posted_by uuid,actor_id uuid,correlation_id uuid,status text,UNIQUE(organization_id,idempotency_key));
    CREATE TABLE finance_posting_receipts(id uuid DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,source_module text,source_id uuid,
      source_reference text,idempotency_key text,status text,amount numeric,currency text,folio_line_id uuid,detail text,attempts int,last_error text,
      requested_by uuid,posted_at timestamptz,occurred_on date,UNIQUE(organization_id,idempotency_key));
    CREATE FUNCTION test_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.status='posted' AND coalesce(current_setting('neo.test_finance_failure',true),'no')='yes' THEN RAISE EXCEPTION 'Controlled financial receipt failure'; END IF;
      RETURN NEW; END $$;
    CREATE TRIGGER test_finance_failure BEFORE INSERT OR UPDATE ON finance_posting_receipts FOR EACH ROW EXECUTE FUNCTION test_receipt_failure();
  `);
    await db.exec(fn("20260924150000_cross_entry_guest_rider_guards.sql", "folio_post_charge"));
    await db.exec(
      fn("20260823160304_9c21238f-a2f4-422d-a265-f32d0931df4f.sql", "laundry_post_charge", "plain"),
    );
    await db.exec(
      fn("20260824061118_b3604370-6047-45fc-a87b-6fc007e631d1.sql", "neo_record_posting_receipt"),
    );
    await db.exec(
      fn("20260830132716_f7834761-a304-4f1b-94d2-eff911e970b8.sql", "neo_finance_post_source"),
    );
    const lifecycle = "20260924140000_guest_laundry_lifecycle_guard.sql";
    for (const name of [
      "neo_laundry_completion_guard",
      "neo_laundry_autopost_after_delivery",
      "neo_sync_guest_laundry_from_batch",
      "neo_laundry_order_advance",
    ]) {
      await db.exec(fn(lifecycle, name));
    }
    const legacy = fn(
      "20260924160000_laundry_retry_preflight_guard.sql",
      "neo_laundry_retry_posting",
    );
    await db.exec(legacy);
    await db.exec(
      legacy.replace("public.neo_laundry_retry_posting(", "public.test_legacy_laundry_retry("),
    );
    await db.exec(read("20261106091000_atomic_guest_laundry_intake.sql"));
    await db.exec(read("20261106091100_laundry_folio_posting_boundary.sql"));
    await db.exec(
      fn(lifecycle, "neo_laundry_order_advance").replace(
        "public.neo_laundry_order_advance(",
        "public.test_legacy_laundry_advance(",
      ),
    );
    await db.exec(read("20261106091200_laundry_delivery_actor_type.sql"));
    await db.exec(`CREATE TRIGGER laundry_guard BEFORE INSERT OR UPDATE ON guest_laundry_orders FOR EACH ROW EXECUTE FUNCTION neo_laundry_completion_guard();
    CREATE TRIGGER laundry_autopost AFTER UPDATE OF status,total,folio_id ON guest_laundry_orders FOR EACH ROW EXECUTE FUNCTION neo_laundry_autopost_after_delivery();
    CREATE TRIGGER laundry_batch_sync AFTER INSERT OR UPDATE OF status ON laundry_batches FOR EACH ROW EXECUTE FUNCTION neo_sync_guest_laundry_from_batch();`);
  }, 60000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.exec(`TRUNCATE guest_laundry_items,guest_laundry_orders,laundry_batches,folio_lines,finance_posting_receipts,audit_logs,rooms,reservations,stays,folios,laundry_price_items CASCADE;
    SELECT set_config('neo.test_permission','yes',false),set_config('neo.test_scope','yes',false),set_config('neo.test_finance_failure','no',false),set_config('neo.test_audit_failure','no',false),set_config('neo.system_posting','off',false);
    INSERT INTO rooms VALUES('${room}','${org}','${branch}');
    INSERT INTO reservations VALUES('${reservation}','${org}','${branch}','${customer}');
    INSERT INTO stays VALUES('${stay}','${org}','${branch}','${room}','${reservation}','${customer}','in-house',NULL);
    INSERT INTO folios(id,organization_id,branch_id,reservation_id,stay_id,customer_id) VALUES('${folio}','${org}','${branch}','${reservation}','${stay}','${customer}');
    INSERT INTO laundry_price_items VALUES('${price}','${org}','${branch}','Shirt','wash-iron',100,150,16,true);`);
  });
  async function intake(
    key = "test-1",
    items: unknown = [{ price_item_id: price, quantity: 2 }],
    express = false,
  ) {
    return (
      await db.query<{ result: Record<string, unknown> }>(
        "SELECT neo_laundry_order_create($1,$2,$3::jsonb,$4,$5) AS result",
        [branch, room, JSON.stringify(items), key, express],
      )
    ).rows[0]!.result;
  }
  async function order(id: unknown) {
    return (
      await db.query<Record<string, unknown>>("SELECT * FROM guest_laundry_orders WHERE id=$1", [
        id,
      ])
    ).rows[0]!;
  }
  async function ready(id: unknown) {
    // Completed garment reconciliation is an explicit fixture prerequisite here;
    // the real batch-to-order synchronisation and delivery guards still execute.
    await db.query(
      "INSERT INTO laundry_batches(organization_id,branch_id,guest_order_id,batch_kind,status) VALUES($1,$2,$3,'guest','completed')",
      [org, branch, id],
    );
  }
  async function deliver(id: unknown) {
    return (
      await db.query<{ result: Record<string, unknown> }>(
        "SELECT neo_laundry_order_advance($1,'delivered',NULL) AS result",
        [id],
      )
    ).rows[0]!.result;
  }
  async function count(table: string) {
    return (await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`))
      .rows[0]!.count;
  }
  it("creates header, garments, correct stay/folio links and audit together", async () => {
    const result = await intake();
    const row = await order(result["order_id"]);
    expect(row).toMatchObject({
      reservation_id: reservation,
      folio_id: folio,
      customer_id: customer,
      room_id: room,
    });
    expect(Number(row["total"])).toBe(232);
    expect(await count("guest_laundry_items")).toBe(1);
    expect(await count("audit_logs")).toBe(1);
    expect(result["audit_id"]).toBeTruthy();
  });
  it("prices from the catalogue and ignores browser amount/tax claims", async () => {
    const result = await intake(
      "price",
      [{ price_item_id: price, quantity: 2, unit_price: 1, tax_rate: 0 }],
      true,
    );
    expect(Number(result["total"])).toBe(348);
  });
  it("retries an intake without duplicate header, garments or audit", async () => {
    const first = await intake();
    const again = await intake();
    expect(again["order_id"]).toBe(first["order_id"]);
    expect(again["idempotent"]).toBe(true);
    expect(await count("guest_laundry_orders")).toBe(1);
    expect(await count("audit_logs")).toBe(1);
  });
  it("uses a fresh identity for a separate identical business order", async () => {
    expect((await intake("fresh-1"))["order_id"]).not.toBe((await intake("fresh-2"))["order_id"]);
  });
  it("rejects changed input under an existing intake identity", async () => {
    await intake();
    await expect(intake("test-1", [{ price_item_id: price, quantity: 3 }])).rejects.toThrow(
      "different laundry",
    );
  });
  it("rolls back the header and first garment when a later garment is invalid", async () => {
    await expect(
      intake("invalid", [
        { price_item_id: price, quantity: 2 },
        { price_item_id: actor, quantity: 1 },
      ]),
    ).rejects.toThrow("active price");
    expect(await count("guest_laundry_orders")).toBe(0);
    expect(await count("guest_laundry_items")).toBe(0);
    expect(await count("audit_logs")).toBe(0);
  });
  it.each([0, -1, "NaN", "Infinity"])(
    "rejects invalid quantity %s without an orphan",
    async (quantity) => {
      await expect(intake("qty", [{ price_item_id: price, quantity }])).rejects.toThrow(
        "positive and finite",
      );
      expect(await count("guest_laundry_orders")).toBe(0);
    },
  );
  it("rolls the entire intake back if its audit cannot be saved", async () => {
    await db.query("SELECT set_config('neo.test_audit_failure','yes',false)");
    await expect(intake()).rejects.toThrow("audit failure");
    expect(await count("guest_laundry_orders")).toBe(0);
    expect(await count("guest_laundry_items")).toBe(0);
  });
  it.each(["neo.test_permission", "neo.test_scope"])(
    "checks %s before returning an existing intake",
    async (setting) => {
      await intake();
      await db.query("SELECT set_config($1,'no',false)", [setting]);
      await expect(intake()).rejects.toThrow(/Not permitted|outside your access/);
    },
  );
  it("accepts both active-stay vocabularies used by the existing check-in paths", async () => {
    await db.exec("UPDATE stays SET status='checked-in'");
    expect((await intake())["ok"]).toBe(true);
  });
  it("blocks a foreign-currency folio rather than silently using property prices", async () => {
    await db.exec("UPDATE folios SET currency='USD'");
    await expect(intake()).rejects.toThrow("folio currency differs");
    expect(await count("guest_laundry_orders")).toBe(0);
  });
  it("refuses no active stay and ambiguous active stays", async () => {
    await db.exec("UPDATE stays SET checked_out_at=now()");
    await expect(intake()).rejects.toThrow("exactly one active");
    await db.exec(
      "UPDATE stays SET checked_out_at=NULL; INSERT INTO stays SELECT gen_random_uuid(),organization_id,branch_id,room_id,reservation_id,customer_id,status,NULL FROM stays",
    );
    await expect(intake()).rejects.toThrow("exactly one active");
    expect(await count("guest_laundry_orders")).toBe(0);
  });
  it("refuses closed or ambiguous guest folios", async () => {
    await db.exec("UPDATE folios SET status='closed'");
    await expect(intake()).rejects.toThrow("exactly one open");
    await db.exec(
      "UPDATE folios SET status='open'; INSERT INTO folios(id,organization_id,branch_id,reservation_id,stay_id,customer_id) SELECT gen_random_uuid(),organization_id,branch_id,reservation_id,stay_id,customer_id FROM folios",
    );
    await expect(intake()).rejects.toThrow("exactly one open");
  });
  it("reproduces the actor-type handover crash and confirms the corrected handover", async () => {
    const id = (await intake())["order_id"];
    await ready(id);
    await expect(
      db.query("SELECT test_legacy_laundry_advance($1,'delivered',NULL)", [id]),
    ).rejects.toThrow("COALESCE types text and uuid");
    expect((await order(id))["status"]).toBe("ready-for-delivery");
    await deliver(id);
    expect((await order(id))["delivery_confirmed_by"]).toBe(actor);
  });
  it("reproduces the old retry deadlock after a failed first posting, then recovers", async () => {
    const result = await intake();
    const id = result["order_id"];
    await ready(id);
    await db.exec("SELECT set_config('neo.test_finance_failure','yes',false)");
    await deliver(id);
    expect((await order(id))["posting_status"]).toBe("blocked");
    expect(await count("folio_lines")).toBe(0);
    await db.exec("SELECT set_config('neo.test_finance_failure','no',false)");
    const old = await db.query<{ result: Record<string, unknown> }>(
      "SELECT test_legacy_laundry_retry($1) AS result",
      [id],
    );
    expect(old.rows[0]!.result).toMatchObject({ ok: false, reason: "missing_folio_charge" });
    const fixed = await db.query<{ result: Record<string, unknown> }>(
      "SELECT neo_laundry_retry_posting($1) AS result",
      [id],
    );
    expect(fixed.rows[0]!.result).toMatchObject({ ok: true, folio_charged: true, folio_id: folio });
    expect(await count("folio_lines")).toBe(1);
    expect(
      Number((await db.query<{ balance: string }>("SELECT balance FROM folios")).rows[0]!.balance),
    ).toBe(232);
  });
  it("delivers and posts one folio line and receipt; a repeated posting returns the same line", async () => {
    const result = await intake();
    const id = result["order_id"];
    await ready(id);
    await deliver(id);
    const saved = await order(id);
    expect(saved["posting_status"]).toBe("posted");
    expect(saved["delivery_confirmed_by"]).toBe(actor);
    const repeat = await db.query<{ result: Record<string, unknown> }>(
      "SELECT neo_laundry_retry_posting($1) AS result",
      [id],
    );
    expect(repeat.rows[0]!.result["folio_line_id"]).toBe(saved["folio_line_id"]);
    expect(await count("folio_lines")).toBe(1);
    expect(await count("finance_posting_receipts")).toBe(1);
  });
  it("requires processing and handover before posting; preserves posted retry after checkout", async () => {
    const id = (await intake())["order_id"];
    const early = await db.query<{ result: Record<string, unknown> }>(
      "SELECT neo_laundry_retry_posting($1) AS result",
      [id],
    );
    expect(early.rows[0]!.result["ok"]).toBe(false);
    await expect(deliver(id)).rejects.toThrow(/guest batch|Reconcile/);
    await ready(id);
    await deliver(id);
    await db.exec("UPDATE folios SET status='closed'");
    const retry = await db.query<{ result: Record<string, unknown> }>(
      "SELECT neo_laundry_retry_posting($1) AS result",
      [id],
    );
    expect(retry.rows[0]!.result["already_posted"]).toBe(true);
  });
  it("keeps property denial ahead of an already-posted retry", async () => {
    const id = (await intake())["order_id"];
    await ready(id);
    await deliver(id);
    await db.exec("SELECT set_config('neo.test_scope','no',false)");
    await expect(db.query("SELECT neo_laundry_retry_posting($1)", [id])).rejects.toThrow(
      "another property",
    );
  });
  it("retains the caller's system-posting context", async () => {
    const id = (await intake())["order_id"];
    await ready(id);
    await db.exec("SELECT set_config('neo.system_posting','on',false)");
    await deliver(id);
    expect(
      (await db.query<{ value: string }>("SELECT current_setting('neo.system_posting') AS value"))
        .rows[0]!.value,
    ).toBe("on");
  });
});
