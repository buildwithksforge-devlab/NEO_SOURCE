import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

it("returns the issued LPO and its actual lines only for the named supplier relationship and property", async () => {
  const db = new PGlite();
  const [org, branch, supplier, relationship, actor, order, other] = Array.from({ length: 7 }, (_, i) => id(i + 1));
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT current_setting('test.actor',true)::uuid $$;
      CREATE TABLE neo_access_relationships(id uuid,auth_user_id uuid,organization_id uuid,branch_id uuid,door text,status text,supplier_id uuid);
      CREATE TABLE branches(id uuid,organization_id uuid,name text,logo_url text,timezone text,active boolean);
      CREATE TABLE suppliers(id uuid,organization_id uuid,name text);
      CREATE TABLE purchase_orders(id uuid,branch_id uuid,organization_id uuid,supplier_id uuid,order_number text,
        status text,sent_at timestamptz,created_at timestamptz,expected_date date,currency text,
        subtotal numeric,discount_amount numeric,tax_amount numeric,total_amount numeric,payment_terms text,delivery_address text);
      CREATE TABLE stock_items(id uuid,organization_id uuid,name text);
      CREATE TABLE purchase_order_lines(id uuid,order_id uuid,stock_item_id uuid,description text,quantity numeric,
        unit text,unit_price numeric,discount_amount numeric,tax_amount numeric,line_total numeric,created_at timestamptz,
        organization_id uuid,tax_rate numeric);
      CREATE FUNCTION neo_pos_sales_tax_receipt(uuid,jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT $2 $$;
      CREATE FUNCTION neo_document_payload(_type text,_id uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE _org uuid:='${org}'; _totals jsonb:='[{"label":"Tax","amount":16}]';
      BEGIN
        RETURN jsonb_build_object('totals', CASE WHEN _type='pos_receipt' THEN public.neo_pos_sales_tax_receipt(_id,coalesce(_totals,'[]'::jsonb))
          ELSE coalesce(_totals,'[]'::jsonb) END, 'type', _type);
      END $$;
      INSERT INTO branches VALUES ('${branch}','${org}','Hotel',NULL,'Africa/Nairobi',true);
      INSERT INTO suppliers VALUES ('${supplier}','${org}','Supplier');
      INSERT INTO neo_access_relationships VALUES ('${relationship}','${actor}','${org}','${branch}','partner','active','${supplier}');
      INSERT INTO purchase_orders VALUES
        ('${order}','${branch}','${org}','${supplier}','LPO-01','approved',now(),now(),NULL,'KES',100,0,16,116,'30 days',NULL),
        ('${other}','${branch}','${org}','${supplier}','LPO-02','draft',NULL,now(),NULL,'KES',50,0,0,50,NULL,NULL);
      INSERT INTO purchase_order_lines VALUES ('${id(8)}','${order}',NULL,'Flour',2,'kg',50,0,16,116,now(),'${org}',16);
    `);
    await db.exec(readFileSync("supabase/migrations/20261121123200_partner_lpo_download.sql", "utf8"));
    const taxUpgrade = readFileSync("supabase/migrations/20261122162500_purchase_order_document_tax_rows.sql", "utf8");
    await db.exec(taxUpgrade);
    await db.exec(taxUpgrade);
    expect((await db.query("SELECT neo_document_payload('purchase_order',$1) AS payload", [order])).rows)
      .toEqual([{ payload: { type: "purchase_order", totals: [{ label: "Tax at 16%", amount: 16, section: "tax" }] } }]);
    const query = "SELECT neo_partner_lpo_payload($1,$2,$3) AS payload";
    await db.exec(`SET ROLE authenticated; SET test.actor='${actor}'`);
    const allowed = (await db.query(query,[branch,relationship,"LPO-01"])).rows[0];
    expect(allowed).toMatchObject({payload:{document:{number:"LPO-01"},party:{name:"Supplier"},lines:[{description:"Flour",quantity:2,total:116}],
      totals:expect.arrayContaining([{ label: "Tax at 16%", amount: 16, section: "tax" },{ label: "Order total", amount: 116, emphasis: true }])}});
    for (const args of [[branch,relationship,"LPO-02"],[other,relationship,"LPO-01"],[branch,other,"LPO-01"]]) {
      expect((await db.query(query,args)).rows).toEqual([{payload:null}]);
    }
    await db.exec(`SET test.actor='${other}'`);
    expect((await db.query(query,[branch,relationship,"LPO-01"])).rows).toEqual([{payload:null}]);
    await db.exec("RESET ROLE; SET ROLE anon");
    await expect(db.query(query,[branch,relationship,"LPO-01"])).rejects.toThrow(/permission denied/i);
  } finally {
    await db.close();
  }
}, 20000);
