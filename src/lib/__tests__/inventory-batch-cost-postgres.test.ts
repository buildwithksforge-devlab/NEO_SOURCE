import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
const read=(path:string)=>readFileSync(path,"utf8");
const extract=(path:string,name:string)=>read(path).match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$\\s*;`))![0];
const repair=read("supabase/migrations/20261116235900_inventory_batch_cost_integrity.sql");
const transferRepair=read("supabase/migrations/20261116235930_transfer_batch_cost_handoff.sql");
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const org=id(1),branch=id(2),actor=id(3),main=id(4),mini=id(5),item=id(6),order=id(7),orderLine=id(8);
describe("actual receiving, stock movements, batches and shared costing",()=>{
  let db:PGlite;
  beforeAll(async()=>{
    db=new PGlite();
    await db.exec(`CREATE ROLE authenticated; CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${actor}'::uuid $$;
      CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${org}'::uuid $$;
      CREATE FUNCTION has_permission(text,text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('test.allowed',true),'true')='true' $$;
      CREATE FUNCTION is_org_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
      CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT $1='${branch}'::uuid $$;
      CREATE FUNCTION neo_system_posting() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
      CREATE FUNCTION neo_inventory_allows_negative(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
      CREATE FUNCTION next_document_number(text,text,uuid) RETURNS text LANGUAGE sql VOLATILE AS $$ SELECT 'GRN-'||gen_random_uuid()::text $$;
      CREATE TABLE uom_units(organization_id uuid,code text,base_code text,factor_to_base numeric);
      INSERT INTO uom_units VALUES(null,'unit','unit',1),(null,'box','unit',12);
      CREATE TABLE stock_locations(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,active boolean,name text);
      CREATE TABLE stock_items(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,name text,base_unit text,average_cost numeric,last_cost numeric,track_batches boolean);
      ALTER TABLE stock_items ADD COLUMN active boolean DEFAULT true;
      CREATE TABLE stock_transfers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,transfer_number text,from_location_id uuid,to_location_id uuid,status text,reason text,notes text,attempt_key text,requested_by uuid,dispatched_by uuid,dispatched_at timestamptz,received_by uuid,received_at timestamptz,cancelled_by uuid,cancelled_at timestamptz,updated_at timestamptz);
      CREATE UNIQUE INDEX transfer_attempt ON stock_transfers(organization_id,attempt_key);
      CREATE TABLE stock_transfer_lines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,transfer_id uuid,stock_item_id uuid,quantity numeric,received_quantity numeric,unit text,updated_at timestamptz);
      CREATE FUNCTION neo_can_transfer_stock() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT has_permission('inventory','transfers.manage') $$;
      CREATE FUNCTION current_branch_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY['${branch}'::uuid] $$;
      CREATE FUNCTION next_document_number(text) RETURNS text LANGUAGE sql VOLATILE AS $$ SELECT 'TR-'||gen_random_uuid()::text $$;
      CREATE TABLE stock_levels(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,stock_item_id uuid,location_id uuid,quantity_on_hand numeric,opening_balance numeric DEFAULT 0,quantity_damaged numeric DEFAULT 0,quantity_expired numeric DEFAULT 0,last_movement_at timestamptz,UNIQUE(stock_item_id,location_id));
      CREATE TABLE stock_batches(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,stock_item_id uuid,location_id uuid,batch_number text,expiry_date date,quantity numeric,unit_cost numeric,status text DEFAULT 'active',received_at timestamptz DEFAULT now());
      CREATE TABLE stock_movements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,stock_item_id uuid,location_id uuid,batch_id uuid,movement_type text,quantity numeric,unit text,unit_cost numeric,value numeric,balance_after numeric,reference_type text,reference_id uuid,reason text,idempotency_key text,performed_by uuid,UNIQUE(organization_id,idempotency_key));
      CREATE TABLE purchase_orders(id uuid PRIMARY KEY,organization_id uuid,branch_id uuid,status text,supplier_id uuid,order_number text);
      CREATE TABLE purchase_order_lines(id uuid PRIMARY KEY,order_id uuid,stock_item_id uuid,quantity numeric,cancelled_quantity numeric DEFAULT 0,received_quantity numeric DEFAULT 0,accepted_quantity numeric DEFAULT 0,rejected_quantity numeric DEFAULT 0,returned_quantity numeric DEFAULT 0,unit text,unit_price numeric,description text);
      CREATE TABLE procurement_attempts(organization_id uuid,action text,attempt_key uuid,record_id uuid,result jsonb,UNIQUE(organization_id,action,attempt_key));
      CREATE TABLE goods_receipts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,branch_id uuid,order_id uuid,supplier_id uuid,location_id uuid,grn_number text,status text,received_at timestamptz,received_by uuid,notes text,delivery_note_number text,supplier_invoice_number text,posted_at timestamptz,total_value numeric,accrual_journal_id uuid,accrual_error text,is_partial boolean);
      CREATE TABLE goods_receipt_lines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,receipt_id uuid,order_line_id uuid,stock_item_id uuid,quantity_ordered numeric,quantity_previously_received numeric,quantity_received numeric,quantity_rejected numeric,quantity_damaged numeric,quantity_returned numeric DEFAULT 0,quantity_accepted numeric,unit text,unit_price numeric,batch_number text,expiry_date date,location_id uuid,notes text,rejection_reason text,over_receipt_reason text);
      CREATE FUNCTION neo_grn_post_accrual(uuid) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN
        IF current_setting('test.finance_failed',true)='true' THEN RAISE EXCEPTION 'Accounting unavailable'; END IF;
        UPDATE goods_receipts SET accrual_journal_id=gen_random_uuid() WHERE id=$1;
        RETURN jsonb_build_object('ok',true); END $$;
      CREATE FUNCTION neo_record_posting_receipt(uuid,uuid,text,uuid,text,text,numeric,text,uuid,text,text,date) RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
    `);
    const conversion=read("supabase/migrations/20260829015934_3f452398-9982-4ea6-85d3-cd2b15071132.sql").match(/CREATE OR REPLACE FUNCTION public\.inventory_convert_strict\([\s\S]*?END;\s*\$\$;/)![0];
    await db.exec(conversion);
    await db.exec(read("scripts/fixtures/queue-batch-29/original-inventory_apply_movement.sql"));
    await db.exec(extract("supabase/migrations/20260831050052_abb267b0-992c-448b-9292-715775ac34ba.sql","inventory_post_receipt"));
    const receiving=read("supabase/migrations/20261112160000_atomic_blind_receiving_review.sql").match(/CREATE OR REPLACE FUNCTION public\.neo_stores_receive_goods\([\s\S]*?END \$\$;/)![0];
    await db.exec(receiving);
    await db.exec("REVOKE ALL ON FUNCTION inventory_apply_movement(uuid,uuid,numeric,text,text,numeric,text,uuid,text,text,text,date),inventory_post_receipt(uuid) FROM PUBLIC; GRANT EXECUTE ON FUNCTION inventory_apply_movement(uuid,uuid,numeric,text,text,numeric,text,uuid,text,text,text,date),inventory_post_receipt(uuid) TO authenticated");
    await db.exec(repair);
    for(const name of ["neo_stores_transfer_create","neo_stores_transfer_receive","neo_stores_transfer_cancel"]){
      await db.exec(extract("supabase/migrations/20260919051525_feb17559-e7b1-43aa-87ff-c5a20b5ee274.sql",name));
    }
    await db.exec(read("supabase/migrations/20261116235000_store_transfer_scope_and_replay.sql"));
    await db.exec(transferRepair);
  },30_000);
  beforeEach(async()=>{
    await db.exec(`TRUNCATE stock_locations,stock_items,stock_levels,stock_batches,stock_movements,purchase_orders,purchase_order_lines,procurement_attempts,goods_receipts,goods_receipt_lines,stock_transfers,stock_transfer_lines;
      SELECT set_config('test.allowed','true',false),set_config('test.finance_failed','false',false);
      INSERT INTO stock_locations VALUES('${main}','${org}','${branch}',true,'Main'),('${mini}','${org}','${branch}',true,'Mini');
      INSERT INTO stock_items VALUES('${item}','${org}',null,'Water','unit',0,0,true,true);
      INSERT INTO purchase_orders VALUES('${order}','${org}','${branch}','approved','${id(9)}','LPO-BATCH');
      INSERT INTO purchase_order_lines(id,order_id,stock_item_id,quantity,unit,unit_price,description) VALUES('${orderLine}','${order}','${item}',10,'box',120,'Water');`);
  });
  afterAll(async()=>{await db?.close();});
  async function receive(delivered:number,rejected=0,key=crypto.randomUUID(),batch="B-1",location=main,extras={}){
    return (await db.query<{value:any}>("SELECT neo_stores_receive_goods($1,$2,$3::jsonb,$4,null,null,'DN-1',null) value",[order,location,JSON.stringify([{order_line_id:orderLine,quantity_received:delivered,quantity_rejected:rejected,batch_number:batch,expiry_date:"2027-01-01",rejection_reason:rejected?"Damaged":null,...extras}]),key])).rows[0]!.value;
  }
  async function move(quantity:number,cost:number|null,key:string,location=main,unit="unit",type="issue",batch:string|null=null){
    return (await db.query<{value:string}>("SELECT inventory_apply_movement($1,$2,$3,$4,$5,$6,'test',$7,'Test movement',$8,$9,null) value",[item,location,quantity,unit,type,cost,order,key,batch])).rows[0]!.value;
  }
  async function balance(){return (await db.query<{quantity:number}>("SELECT coalesce(sum(quantity_on_hand),0)::float8 quantity FROM stock_levels")).rows[0]!.quantity;}
  async function dispatch(quantity=2){return (await db.query<{value:any}>("SELECT neo_stores_transfer_create($1,$2,$3,$4::jsonb,'Mini-store replenishment',$5) value",[branch,main,mini,JSON.stringify([{stock_item_id:item,quantity,unit:"box"}]),crypto.randomUUID()])).rows[0]!.value;}
  async function finish(transfer:string,action:"receive"|"cancel"){return (await db.query<{value:any}>(`SELECT neo_stores_transfer_${action}($1${action==="cancel"?",'Not required'":""}) value`,[transfer])).rows[0]!.value;}
  it("posts only accepted boxes in base units with matching receipt, batch and movement value",async()=>{
    const result=await receive(5,1);
    expect(result.partial).toBe(true);
    expect(await balance()).toBe(48);
    expect((await db.query("SELECT quantity::float8 quantity,unit_cost::float8 cost,batch_number,expiry_date::text expiry FROM stock_batches")).rows[0]).toEqual({quantity:48,cost:10,batch_number:"B-1",expiry:"2027-01-01"});
    expect((await db.query("SELECT quantity::float8 quantity,unit_cost::float8 cost,value::float8 value,branch_id FROM stock_movements")).rows[0]).toEqual({quantity:48,cost:10,value:480,branch_id:branch});
    expect((await db.query("SELECT total_value::float8 value FROM goods_receipts")).rows[0]).toEqual({value:480});
    expect((await db.query("SELECT received_quantity::float8 delivered,accepted_quantity::float8 accepted,rejected_quantity::float8 rejected FROM purchase_order_lines")).rows[0]).toEqual({delivered:5,accepted:4,rejected:1});
  });
  it("keeps repeated delivery batches separate, finishes the outstanding accepted amount and replays without new stock",async()=>{
    await receive(5,1);
    const key=crypto.randomUUID();
    const second=await receive(6,0,key,"B-2");
    expect(second.partial).toBe(false);
    expect((await receive(6,0,key,"B-2")).receipt_id).toBe(second.receipt_id);
    expect(await balance()).toBe(120);
    expect((await db.query("SELECT batch_number,quantity::float8 quantity FROM stock_batches ORDER BY batch_number")).rows).toEqual([{batch_number:"B-1",quantity:48},{batch_number:"B-2",quantity:72}]);
    expect((await db.query("SELECT count(*)::int n FROM stock_movements")).rows[0]).toEqual({n:2});
    await expect(receive(1,0,crypto.randomUUID(),"EXCESS")).rejects.toThrow(/over_receipt_refused/);
  });
  it("depletes across FEFO batches and records every allocation on one durable movement",async()=>{
    await receive(4,0,crypto.randomUUID(),"EARLY");
    await receive(6,0,crypto.randomUUID(),"LATE",main,{expiry_date:"2027-02-01"});
    const key="consume-60";
    const movement=await move(-60,null,key);
    expect(await move(-60,null,key)).toBe(movement);
    expect(await balance()).toBe(60);
    expect((await db.query("SELECT batch_number,quantity::float8 quantity FROM stock_batches ORDER BY expiry_date")).rows).toEqual([{batch_number:"EARLY",quantity:0},{batch_number:"LATE",quantity:60}]);
    const saved=(await db.query<{batch_id:string|null;batch_allocations:any[]}>("SELECT batch_id,batch_allocations FROM stock_movements WHERE id=$1",[movement])).rows[0]!;
    expect(saved.batch_id).toBeNull();
    expect(saved.batch_allocations.map(a=>a.quantity)).toEqual([-48,-12]);
  });
  it("weights future receipt cost using stock across both stores",async()=>{
    await move(48,10,"main-in",main,"unit","receipt","MAIN");
    await move(72,20,"mini-in",mini,"unit","receipt","MINI");
    expect((await db.query("SELECT average_cost::float8 cost FROM stock_items")).rows[0]).toEqual({cost:16});
    await move(24,30,"main-second",main,"unit","receipt","MAIN-2");
    const cost=(await db.query<{cost:number}>("SELECT average_cost::float8 cost FROM stock_items")).rows[0]!.cost;
    expect(cost).toBeCloseTo((48*10+72*20+24*30)/144,8);
  });
  it("preserves zero-priced accepted goods rather than valuing them at an earlier purchase cost",async()=>{
    await move(12,10,"opening",main,"unit","opening","OPEN");
    await db.exec("UPDATE purchase_order_lines SET unit_price=0");
    await receive(1);
    expect((await db.query("SELECT value::float8 value,unit_cost::float8 cost FROM stock_movements WHERE reference_type='goods_receipt'")).rows[0]).toEqual({value:0,cost:0});
    expect((await db.query("SELECT average_cost::float8 cost FROM stock_items")).rows[0]).toEqual({cost:5});
  });
  it("leaves rejected goods out of stock and batches",async()=>{
    await receive(3,3);
    expect(await balance()).toBe(0);
    expect((await db.query("SELECT count(*)::int n FROM stock_batches")).rows[0]).toEqual({n:0});
    expect((await db.query("SELECT accepted_quantity::float8 accepted,rejected_quantity::float8 rejected FROM purchase_order_lines")).rows[0]).toEqual({accepted:0,rejected:3});
  });
  it("rolls the entire issue back when tracked batch quantities do not cover on-hand stock",async()=>{
    await receive(4);
    await db.exec("UPDATE stock_batches SET quantity=1");
    await expect(move(-12,null,"bad-batches")).rejects.toThrow(/Batch balances do not cover/);
    expect(await balance()).toBe(48);
    expect((await db.query("SELECT quantity::float8 quantity FROM stock_batches")).rows[0]).toEqual({quantity:1});
    expect((await db.query("SELECT count(*)::int n FROM stock_movements")).rows[0]).toEqual({n:1});
  });
  it("refuses changed movement identity, quantity, cost or reference batch",async()=>{
    await move(12,10,"same",main,"unit","receipt","A");
    await expect(move(13,10,"same",main,"unit","receipt","A")).rejects.toThrow(/different work/);
    await expect(move(12,20,"same",main,"unit","receipt","A")).rejects.toThrow(/different work/);
    await expect(move(12,10,"same",main,"unit","receipt","B")).rejects.toThrow(/different work/);
    expect(await balance()).toBe(12);
  });
  it("refuses unknown units and purchase-unit mismatches atomically",async()=>{
    await expect(receive(1,0,crypto.randomUUID(),"X",main,{unit:"unit"})).rejects.toThrow(/unit differs/);
    await expect(move(10,5,"unknown",main,"mystery","receipt")).rejects.toThrow(/No unit conversion/);
    expect(await balance()).toBe(0);
    expect((await db.query("SELECT count(*)::int n FROM goods_receipts")).rows[0]).toEqual({n:0});
  });
  it("uses store property ownership for shared items and rejects cross-property or unauthorised movements",async()=>{
    await db.exec(`UPDATE stock_locations SET branch_id='${id(20)}' WHERE id='${main}'`);
    await expect(move(12,10,"outside",main,"unit","receipt")).rejects.toThrow(/authorized property/);
    await db.exec(`UPDATE stock_locations SET branch_id='${branch}'; SELECT set_config('test.allowed','false',false)`);
    await expect(move(12,10,"denied",main,"unit","receipt")).rejects.toThrow(/Not permitted/);
  });
  it("keeps pending finance separate and does not repost batches on receipt retry",async()=>{
    await db.exec("SELECT set_config('test.finance_failed','true',false)");
    const key=crypto.randomUUID();
    expect((await receive(4,0,key)).posting.status).toBe("pending-finance");
    await receive(4,0,key);
    expect(await balance()).toBe(48);
    expect((await db.query("SELECT count(*)::int n FROM stock_batches")).rows[0]).toEqual({n:1});
  });
  it("reapplies without changing existing business rows or execution grants",async()=>{
    await receive(4);
    const before=await balance(); await db.exec(repair);
    expect(await balance()).toBe(before);
    expect((await db.query("SELECT has_function_privilege('authenticated','inventory_post_receipt(uuid)','EXECUTE') allowed")).rows[0]).toEqual({allowed:true});
    expect((await db.query("SELECT count(*)::int n FROM stock_batches")).rows[0]).toEqual({n:1});
  });
  it("refuses non-finite stock, batch and receipt quantities without further stock movement",async()=>{
    await receive(4);
    await db.exec("UPDATE stock_batches SET quantity='NaN'::numeric");
    await expect(move(-12,null,"nan-batch")).rejects.toThrow(/Batch quantities need reconciliation/);
    expect(await balance()).toBe(48);
    await db.exec("UPDATE stock_batches SET quantity=48; UPDATE stock_levels SET quantity_on_hand='Infinity'::numeric");
    await expect(move(1,10,"bad-balance",main,"unit","receipt")).rejects.toThrow(/Stock balances need reconciliation/);
    await db.exec("UPDATE stock_levels SET quantity_on_hand=48; UPDATE goods_receipts SET status='received'; UPDATE goods_receipt_lines SET quantity_rejected='NaN'::numeric");
    const receiptId=(await db.query<{id:string}>("SELECT id FROM goods_receipts")).rows[0]!.id;
    await expect(db.query("SELECT inventory_post_receipt($1)",[receiptId])).rejects.toThrow(/quantities and cost need reconciliation/);
    expect(await balance()).toBe(48);
  });
  it("refuses cancelled receipts and corrupt accepted quantities",async()=>{
    const result=await receive(4);
    await db.exec("UPDATE goods_receipts SET status='cancelled'");
    await expect(db.query("SELECT inventory_post_receipt($1)",[result.receipt_id])).rejects.toThrow(/not approved/);
    await db.exec("UPDATE goods_receipts SET status='received'; UPDATE goods_receipt_lines SET quantity_accepted=5");
    await expect(db.query("SELECT inventory_post_receipt($1)",[result.receipt_id])).rejects.toThrow(/quantities and cost need reconciliation/);
    expect(await balance()).toBe(48);
  });
  it("refuses an unreviewed installed movement definition before schema or code replacement",async()=>{
    const original=(await db.query<{body:string}>("SELECT pg_get_functiondef('inventory_apply_movement(uuid,uuid,numeric,text,text,numeric,text,uuid,text,text,text,date)'::regprocedure) body")).rows[0]!.body;
    await db.exec(original.replace("v_allocations jsonb := '[]'::jsonb","v_allocations jsonb := '[{}]'::jsonb"));
    await expect(db.exec(repair)).rejects.toThrow(/differs from reviewed source/);
    await db.exec("ROLLBACK"); await db.exec(original);
  });
  it.each(["receive","cancel"] as const)("preserves saved dispatch cost, batch and expiry on %s after another purchase changes current cost",async(action)=>{
    await receive(4);
    const transfer=await dispatch(2);
    await move(72,30,"new-purchase",mini,"unit","receipt","NEW");
    expect((await db.query("SELECT average_cost::float8 cost FROM stock_items")).rows[0]).toEqual({cost:25});
    expect((await finish(transfer.transfer_id,action)).status).toBe(action==="receive"?"completed":"cancelled");
    await finish(transfer.transfer_id,action);
    expect(await balance()).toBe(120);
    const destination=action==="receive"?mini:main;
    expect((await db.query("SELECT quantity::float8 quantity,unit_cost::float8 cost,expiry_date::text expiry FROM stock_batches WHERE location_id=$1 AND batch_number='B-1' AND quantity>0 ORDER BY quantity",[destination])).rows).toEqual(action==="receive"?[{quantity:24,cost:10,expiry:"2027-01-01"}]:[{quantity:24,cost:10,expiry:"2027-01-01"},{quantity:24,cost:10,expiry:"2027-01-01"}]);
    expect((await db.query("SELECT sum(value)::float8 value,sum(quantity)::float8 quantity FROM stock_movements WHERE reference_type='stock_transfer' AND reference_id=$1",[transfer.transfer_id])).rows[0]).toEqual({value:0,quantity:0});
    expect((await db.query("SELECT average_cost::float8 cost FROM stock_items")).rows[0]).toEqual({cost:22});
  });
  it("moves multiple batch identities to the mini-store without collapsing their expiry dates",async()=>{
    await receive(4,0,crypto.randomUUID(),"EARLY");
    await receive(6,0,crypto.randomUUID(),"LATE",main,{expiry_date:"2027-02-01"});
    const transfer=await dispatch(5);
    await finish(transfer.transfer_id,"receive");
    expect((await db.query("SELECT batch_number,expiry_date::text expiry,quantity::float8 quantity FROM stock_batches WHERE location_id=$1 ORDER BY expiry_date",[mini])).rows).toEqual([{batch_number:"EARLY",expiry:"2027-01-01",quantity:48},{batch_number:"LATE",expiry:"2027-02-01",quantity:12}]);
    expect(await balance()).toBe(120);
  });
  it("compares transfer quantity in base units before dispatch and leaves no partial transfer on failure",async()=>{
    await receive(4);
    await expect(dispatch(5)).rejects.toThrow(/source store holds only/);
    expect(await balance()).toBe(48);
    expect((await db.query("SELECT count(*)::int n FROM stock_transfers")).rows[0]).toEqual({n:0});
  });
  it("refuses legacy/corrupt dispatch evidence instead of inventing destination batches or valuation",async()=>{
    await receive(4);
    const transfer=await dispatch(2);
    await db.exec("UPDATE stock_movements SET batch_allocations='[]'::jsonb WHERE movement_type='transfer-out'");
    await expect(finish(transfer.transfer_id,"receive")).rejects.toThrow(/no batch allocations/);
    expect((await db.query("SELECT status FROM stock_transfers")).rows[0]).toEqual({status:"in-transit"});
    expect(await balance()).toBe(24);
  });
  it("reapplies the transfer handoff without issuing receipts or duplicating batch stock",async()=>{
    await receive(4);const transfer=await dispatch(2);
    await db.exec(transferRepair);
    await finish(transfer.transfer_id,"receive");
    expect(await balance()).toBe(48);
    expect((await db.query("SELECT count(*)::int n FROM stock_movements WHERE movement_type='transfer-in'")).rows[0]).toEqual({n:1});
  });
});
