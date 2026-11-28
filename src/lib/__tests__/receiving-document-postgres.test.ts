import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
const read = (path: string) => readFileSync(path, "utf8");
const fn = (source: string, name: string) => source.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$\\s*;`))![0];
const queueMigration = read("supabase/migrations/20261116234000_receiving_queue_handoff.sql");
const documentMigration = read("supabase/migrations/20261116234500_grn_inspection_document_details.sql");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const org = id(1), branch = id(2), actor = id(3), submitter = id(4), purchase = id(5), receipt = id(6), count = id(7);
describe("saved receiving documents and authorized handoff", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE authenticated; CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.actor',true),'')::uuid $$;
      CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${org}'::uuid $$;
      CREATE FUNCTION is_org_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
      CREATE FUNCTION has_permission(text,text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('test.allowed',true),'false')='true' $$;
      CREATE FUNCTION has_permission(text,text,text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('test.allowed',true),'false')='true' $$;
      CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT $1='${branch}'::uuid $$;
      CREATE TABLE purchase_orders(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,order_number text);
      CREATE TABLE neo_blind_receiving_counts(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,purchase_order_id uuid,supplier_delivery_note text,remarks text,review_notes text,submitted_at timestamptz,reviewed_at timestamptz,status text,posted_grn_id uuid,submitted_by uuid);
      CREATE TABLE neo_blind_receiving_count_lines(id uuid,count_id uuid);
      CREATE TABLE goods_receipts(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,order_id uuid,supplier_id uuid,grn_number text,received_at timestamptz,created_at timestamptz,status text,delivery_note_number text,supplier_invoice_number text,total_value numeric,is_partial boolean,discrepancy_notes text,notes text);
      CREATE TABLE goods_receipt_lines(id uuid PRIMARY KEY,receipt_id uuid,stock_item_id uuid,quantity_received numeric,quantity_accepted numeric,quantity_rejected numeric,quantity_ordered numeric,unit text,unit_price numeric,rejection_reason text,batch_number text,expiry_date date,created_at timestamptz);
      CREATE TABLE stock_items(id uuid,name text);
      CREATE TABLE suppliers(id uuid,name text);
      CREATE TABLE branches(id uuid,name text,code text,address text,city text,country text,phone text,email text,currency text,timezone text);
      CREATE TABLE organizations(id uuid,name text,legal_name text);
      CREATE TABLE organization_settings(organization_id uuid,regional jsonb,contact jsonb,brand jsonb);
    `);
    await db.exec(fn(read("supabase/migrations/20261112090000_block_virtual_blind_receiving.sql"), "neo_blind_receiving_approved_queue"));
    await db.exec(fn(read("supabase/migrations/20261110173000_scoped_waiter_receipt_printing.sql"), "neo_document_payload"));
    await db.exec(`REVOKE ALL ON FUNCTION neo_document_payload(text,uuid),neo_blind_receiving_approved_queue() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION neo_document_payload(text,uuid),neo_blind_receiving_approved_queue() TO authenticated;`);
    await db.exec(queueMigration);
    await db.exec(documentMigration);
  }, 30_000);
  beforeEach(async () => {
    await db.exec(`TRUNCATE purchase_orders,neo_blind_receiving_counts,neo_blind_receiving_count_lines,goods_receipts,goods_receipt_lines,stock_items,suppliers,branches,organizations,organization_settings;
      SELECT set_config('test.actor','${actor}',false),set_config('test.allowed','true',false);
      INSERT INTO purchase_orders VALUES('${purchase}','${org}','${branch}','LPO-1');
      INSERT INTO neo_blind_receiving_counts VALUES('${count}','${org}','${branch}','${purchase}','DN-1',null,'Inspected',now(),now(),'approved',null,'${submitter}');
      INSERT INTO neo_blind_receiving_count_lines VALUES('${id(8)}','${count}');
      INSERT INTO goods_receipts VALUES('${receipt}','${org}','${branch}','${purchase}','${id(9)}','GRN-1',now(),now(),'received','DN-1','SUP-INV-1',40,true,'2 rejected','Checked');
      INSERT INTO goods_receipt_lines VALUES('${id(10)}','${receipt}','${id(11)}',12,10,2,15,'kg',4,'Damaged packaging','BATCH-42','2027-03-01',now());
      INSERT INTO stock_items VALUES('${id(11)}','Rice');
      INSERT INTO suppliers VALUES('${id(9)}','Supplier One');
      INSERT INTO branches VALUES('${branch}','Hotel One','H1',null,null,null,null,null,'KES','Africa/Nairobi');
      INSERT INTO organizations VALUES('${org}','Hotel Group','Hotel Group Limited');`);
  });
  afterAll(async () => { await db?.close(); });
  async function queue() { return (await db.query<{ value: Record<string, unknown>[] }>("SELECT neo_blind_receiving_approved_queue() value")).rows[0]!.value; }
  async function document() { return (await db.query<{ value: any }>("SELECT neo_document_payload('goods_receipt',$1) value", [receipt])).rows[0]!.value; }
  it("allows a receiving manager without organization administrator authority and returns original purchase/property", async () => {
    expect(await queue()).toMatchObject([{ count_id: count, branch_id: branch, purchase_order_id: purchase, order_number: "LPO-1", line_count: 1 }]);
  });
  it("refuses missing receiving authority", async () => {
    await db.exec("SELECT set_config('test.allowed','false',false)");
    await expect(queue()).rejects.toThrow(/posting access required/);
  });
  it("keeps self-posting, other properties, posted counts and other organizations out of the queue", async () => {
    for (const update of [
      `submitted_by='${actor}'`, `branch_id='${id(20)}'`, `posted_grn_id='${receipt}'`, `organization_id='${id(21)}'`,
    ]) {
      await db.exec("BEGIN");
      await db.exec(`UPDATE neo_blind_receiving_counts SET ${update}`);
      expect(await queue()).toEqual([]);
      await db.exec("ROLLBACK");
    }
  });
  it("retains the virtual-count block reason for authorized receiving managers", async () => {
    await db.exec("UPDATE neo_blind_receiving_counts SET remarks='VIRTUAL TEST ONLY'");
    expect((await queue())[0]?.["posting_block_reason"]).toMatch(/posting is prohibited/);
  });
  it("prints physical, accepted/rejected quantities, reason, batch and expiry with original GRN/purchase identity", async () => {
    const value = await document();
    expect(value.document).toMatchObject({ number: "GRN-1", subtitle: "Against LPO-1" });
    expect(value.lines[0]).toMatchObject({ quantity: 12, total: 40, note: expect.stringContaining("accepted 10") });
    for (const detail of ["ordered 15", "rejected 2", "reason: Damaged packaging", "batch: BATCH-42", "expiry: 2027-03-01"]) expect(value.lines[0].note).toContain(detail);
    expect(value.party.lines).toEqual(["DN-1", "SUP-INV-1"]);
    await db.exec("UPDATE purchase_orders SET order_number='LPO-1'; UPDATE goods_receipts SET status='closed'");
    expect((await document()).document.number).toBe("GRN-1");
    expect((await db.query("SELECT count(*)::int n FROM goods_receipts")).rows[0]).toEqual({ n: 1 });
  });
  it("keeps unavailable batch/expiry empty instead of inventing traceability", async () => {
    await db.exec("UPDATE goods_receipt_lines SET batch_number=null,expiry_date=null,rejection_reason=null");
    const value = await document();
    expect(value.lines[0].note).not.toMatch(/batch:|expiry:|reason:/);
    expect(value.lines[0].note).toContain("rejected 2");
  });
  it("retains tenant/property and permission enforcement for saved documents", async () => {
    await db.exec(`UPDATE goods_receipts SET organization_id='${id(21)}'`);
    await expect(document()).rejects.toThrow(/not visible in your scope/);
    await db.exec(`UPDATE goods_receipts SET organization_id='${org}',branch_id='${id(20)}'`);
    await expect(document()).rejects.toThrow(/outside your access scope/);
    await db.exec(`UPDATE goods_receipts SET branch_id='${branch}'; SELECT set_config('test.allowed','false',false)`);
    await expect(document()).rejects.toThrow(/permission/);
  });
  it("replays migration installation without changing grants or issuing another GRN", async () => {
    await db.exec(queueMigration); await db.exec(documentMigration);
    const grants = await db.query("SELECT has_function_privilege('authenticated','neo_document_payload(text,uuid)','EXECUTE') doc,has_function_privilege('authenticated','neo_blind_receiving_approved_queue()','EXECUTE') queue");
    expect(grants.rows[0]).toEqual({ doc: true, queue: true });
    expect((await db.query("SELECT count(*)::int n FROM goods_receipts")).rows[0]).toEqual({ n: 1 });
  });
  it("refuses an unknown installed definition without replacing it", async () => {
    const original = (await db.query<{ body: string }>("SELECT pg_get_functiondef('neo_document_payload(text,uuid)'::regprocedure) body")).rows[0]!.body;
    await db.exec(original.replace("_module := case _type", "_module := case lower(_type)"));
    await expect(db.exec(documentMigration)).rejects.toThrow(/differs from reviewed source/);
    await db.exec("ROLLBACK");
    await db.exec(original);
  });
});
