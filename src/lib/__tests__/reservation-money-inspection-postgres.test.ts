import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
const sql=readFileSync("supabase/repair/2026-11-18/RESERVATION-MONEY-INSPECTION.sql","utf8");
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const org=id(1),branch=id(2),reservation=id(3),folio=id(4),payment=id(5),deposit=id(6),application=id(7);
describe("read-only reservation reconciliation discovers existing record IDs from the supplied order",()=>{
 let db:PGlite;
 beforeAll(async()=>{
  db=new PGlite();await db.exec(`
   CREATE TABLE pos_orders(id uuid,organization_id uuid,folio_id uuid,order_number text,status text,grand_total numeric,paid_total numeric);
   CREATE TABLE reservations(id uuid,organization_id uuid,branch_id uuid,confirmation_number text,status text,currency text,total_amount numeric,balance numeric,created_at timestamptz);
   CREATE TABLE stays(id uuid,organization_id uuid,branch_id uuid,reservation_id uuid,room_id uuid,status text);
   CREATE TABLE folios(id uuid,organization_id uuid,branch_id uuid,reservation_id uuid,currency text,status text,total_charges numeric,total_payments numeric,balance numeric);
   CREATE TABLE payments(id uuid,organization_id uuid,branch_id uuid,reservation_id uuid,folio_id uuid,amount numeric,currency text,status text);
   CREATE TABLE reservation_deposits(id uuid,organization_id uuid,branch_id uuid,reservation_id uuid,status text,currency text,amount numeric,payment_id uuid,applied_folio_id uuid,applied_folio_line_id uuid);
   CREATE TABLE folio_lines(id uuid,organization_id uuid,folio_id uuid,net_amount numeric,status text,line_type text);
   CREATE TABLE payment_allocations(organization_id uuid,payment_id uuid,folio_id uuid,amount numeric);
  `);
 },30000);
 afterAll(async()=>db?.close());
 beforeEach(async()=>{
  await db.exec(`TRUNCATE pos_orders,reservations,stays,folios,payments,reservation_deposits,folio_lines,payment_allocations;
   INSERT INTO pos_orders VALUES('1b6b23aa-c4d8-4ded-830e-4f432e972175','${org}',NULL,'POS-20261113-CBE0F','partially-ready',7261.50,0);
   INSERT INTO reservations VALUES('${reservation}','${org}','${branch}','EXISTING-1','checked-in','KES',30000,25000,now()),
    ('${id(93)}','${id(91)}','${id(92)}','OTHER-ORG-PRIVATE','confirmed','KES',123456,123456,now());
   INSERT INTO stays VALUES('${id(8)}','${org}','${branch}','${reservation}','${id(9)}','in-house');
   INSERT INTO folios VALUES('${folio}','${org}','${branch}','${reservation}','KES','open',10000,5000,5000);
   INSERT INTO payments VALUES('${payment}','${org}','${branch}','${reservation}','${folio}',5000,'KES','confirmed');
   INSERT INTO reservation_deposits VALUES('${deposit}','${org}','${branch}','${reservation}','applied','KES',5000,'${payment}','${folio}','${application}');
   INSERT INTO folio_lines VALUES('${id(10)}','${org}','${folio}',10000,'posted','charge'),('${application}','${org}','${folio}',5000,'posted','deposit');
  `);
 });
 async function inspect(){
  await db.exec("BEGIN READ ONLY");
  try {return (await db.query<{reservation_money_inspection:any}>(sql)).rows[0]!.reservation_money_inspection;}
  finally {await db.exec("ROLLBACK");}
 }
 it("discovers reservations without a supplied reservation ID, excludes unrelated organizations and never writes",async()=>{
  const result=await inspect();expect(result.seed_found).toBe(true);
  expect(result.coverage).toEqual({reservations:1,folios:1,payments:1,deposits:1});
  expect(result.findings).toEqual([]);expect(result.existing_reservation_cases[0].id).toBe(reservation);
  expect(JSON.stringify(result)).not.toContain("OTHER-ORG-PRIVATE");
  expect((await db.query("SELECT total_payments,balance FROM folios")).rows[0]).toEqual({total_payments:"5000",balance:"5000"});
 });
 it("does not count a deposit and its matching folio receipt twice or deduct pending payments",async()=>{
  await db.exec(`INSERT INTO payments VALUES('${id(11)}','${org}','${branch}','${reservation}','${folio}',2000,'KES','pending')`);
  expect((await inspect()).findings).toEqual([]);
 });
 it("recognizes an applied linked reservation receipt that has no folio and no allocations",async()=>{
  await db.exec("UPDATE payments SET folio_id=NULL");expect((await inspect()).findings).toEqual([]);
 });
 it("returns the exact receipt/deposit IDs when linked money disagrees",async()=>{
  await db.exec("UPDATE payments SET amount=6000");const result=await inspect();
  expect(result.findings).toContainEqual(expect.objectContaining({issue:"deposit_linked_payment_mismatch",reservation_id:reservation,payment_id:payment,deposit_id:deposit}));
  expect(result.findings).toContainEqual(expect.objectContaining({issue:"folio_summary_difference",folio_id:folio}));
 });
 it("identifies duplicated active deposit links to one receipt",async()=>{
  await db.exec(`INSERT INTO reservation_deposits SELECT '${id(12)}',organization_id,branch_id,reservation_id,status,currency,amount,payment_id,applied_folio_id,applied_folio_line_id FROM reservation_deposits`);
  const result=await inspect();expect(result.finding_counts.same_receipt_linked_to_multiple_active_deposits).toBe(2);
  expect(result.findings.filter((f:any)=>f.issue==="same_receipt_linked_to_multiple_active_deposits").map((f:any)=>f.deposit_id).sort()).toEqual([deposit,id(12)].sort());
 });
 it("flags an applied deposit whose application line disappeared",async()=>{
  await db.exec(`DELETE FROM folio_lines WHERE id='${application}'`);
  expect((await inspect()).findings).toContainEqual(expect.objectContaining({issue:"applied_deposit_evidence_mismatch",deposit_id:deposit}));
 });
 it("exposes lifecycle changes inconsistent with the open stay",async()=>{
  await db.exec("UPDATE reservations SET status='cancelled' WHERE confirmation_number='EXISTING-1'");
  expect((await inspect()).findings).toContainEqual(expect.objectContaining({issue:"active_stay_reservation_lifecycle_mismatch",reservation_id:reservation}));
 });
 it("refuses to broaden its organization scope when the supplied order is absent",async()=>{
  await db.exec("DELETE FROM pos_orders");const result=await inspect();expect(result.seed_found).toBe(false);
  expect(result.coverage).toEqual({reservations:0,folios:0,payments:0,deposits:0});expect(result.existing_reservation_cases).toEqual([]);
 });
});
