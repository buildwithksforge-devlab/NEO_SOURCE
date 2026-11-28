import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {
  beforeAll,beforeEach,afterAll,describe,it,expect
} from "vitest";

const id=(n:number)=>
  `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;

const org=id(1),branch=id(2),txn=id(3),
      payment=id(4),order=id(5),evidence=id(6);

let db:PGlite;

beforeAll(async()=>{

  db=new PGlite();

  await db.exec(`

    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;

    CREATE TABLE mpesa_transactions(
      id uuid PRIMARY KEY,
      organization_id uuid,
      branch_id uuid,
      payment_table text,
      payment_id uuid,
      amount numeric,
      status text,
      applied_at timestamptz
    );

    CREATE TABLE pos_payments(
      id uuid PRIMARY KEY,
      organization_id uuid,
      branch_id uuid,
      order_id uuid,
      amount numeric,
      currency text,
      method text,
      status text,
      external_reference text
    );

    CREATE TABLE pos_orders(
      id uuid PRIMARY KEY,
      organization_id uuid,
      branch_id uuid,
      currency text,
      status text,
      grand_total numeric
    );

    CREATE TABLE neo_payment_settlement_evidence(
      id uuid PRIMARY KEY,
      organization_id uuid,
      branch_id uuid,
      provider text,
      provider_receipt text,
      transaction_id uuid,
      amount numeric,
      currency text
    );

    CREATE TABLE neo_payment_late_receipt_exceptions(
      evidence_id uuid
    );

  `);

  const migration=readFileSync(
    "supabase/migrations/20261126026000_payment_settlement_evidence.sql",
    "utf8"
  );

  const section=migration.split(
    "-- NEO_PAYMENT_FINANCIAL_CLOSURE_V1"
  )[1]?.split("DO $closure$")[0];

  if(!section){
    throw new Error("Financial closure source unavailable");
  }

  await db.exec(section);

},60000);

afterAll(async()=>await db?.close());

beforeEach(async()=>{

  await db.exec(`

    TRUNCATE mpesa_transactions,pos_payments,pos_orders,
      neo_payment_settlement_evidence,
      neo_payment_late_receipt_exceptions;

    INSERT INTO mpesa_transactions VALUES(
      '${txn}','${org}','${branch}',
      'pos_payments','${payment}',5000,'pending',NULL
    );

    INSERT INTO pos_orders VALUES(
      '${order}','${org}','${branch}',
      'KES','awaiting-payment',5000
    );

    INSERT INTO pos_payments VALUES(
      '${payment}','${org}','${branch}',
      '${order}',5000,'KES','mpesa','pending',NULL
    );

    INSERT INTO neo_payment_settlement_evidence VALUES(
      '${evidence}','${org}','${branch}',
      'mpesa','RECEIPT123','${txn}',5000,'KES'
    );

  `);

});

async function verify(){

  return db.query<{result:string}>(`
    SELECT neo_mpesa_require_verified_pos_receipt(
      $1,$2,$3,$4,$5
    ) AS result
  `,[org,branch,payment,5000,"RECEIPT123"]);

}

async function reason(){

  const result=await db.query<{result:string|null}>(`
    SELECT neo_mpesa_pos_late_payment_reason(
      $1,'RECEIPT123'
    ) AS result
  `,[txn]);

  return result.rows[0]?.result;

}

async function alternate(amount:number,status="confirmed"){

  await db.query(`

    INSERT INTO pos_payments VALUES(
      $1,$2,$3,$4,$5,'KES','cash',$6,NULL
    )

  `,[id(20),org,branch,order,amount,status]);

}

describe("consolidated payment financial closure",()=>{

  it("accepts matching verified payment identity",async()=>{
    expect((await verify()).rows[0]?.result).toBe(evidence);
  });

  it("blocks confirmation without verified evidence",async()=>{
    await db.exec("DELETE FROM neo_payment_settlement_evidence");
    await expect(verify()).rejects.toThrow(/verified provider/);
  });

  it("blocks mismatched receipt amounts",async()=>{
    await db.exec("UPDATE neo_payment_settlement_evidence SET amount=4000");
    await expect(verify()).rejects.toThrow(/verified provider/);
  });

  it("blocks evidence from another branch",async()=>{
    await db.exec(`UPDATE neo_payment_settlement_evidence SET branch_id='${id(99)}'`);
    await expect(verify()).rejects.toThrow(/verified provider/);
  });

  it("blocks another payment's receipt",async()=>{
    await db.exec(`UPDATE mpesa_transactions SET payment_id='${id(99)}'`);
    await expect(verify()).rejects.toThrow(/different payment/);
  });

  it("blocks using additional receipts for ordinary settlement",async()=>{
    await db.exec(`INSERT INTO neo_payment_late_receipt_exceptions VALUES('${evidence}')`);
    await expect(verify()).rejects.toThrow(/financial reconciliation/);
  });

  it("preserves ordinary unpaid bill settlement",async()=>{
    expect(await reason()).toBeNull();
  });

  it("detects bills already settled using cash",async()=>{
    await alternate(5000);
    expect(await reason()).toBe("bill-already-settled");
  });

  it("detects a partial alternative collection",async()=>{
    await alternate(1000);
    expect(await reason()).toBe("allocation-exceeds-balance");
  });

  it("does not classify unconfirmed cash as received",async()=>{
    await alternate(5000,"pending");
    expect(await reason()).toBeNull();
  });

  it("detects closed bills",async()=>{
    await db.exec("UPDATE pos_orders SET status='closed'");
    expect(await reason()).toBe("bill-already-settled");
  });

  it("detects a different receipt confirming the same payment",async()=>{
    await db.exec(`
      UPDATE pos_payments
      SET status='confirmed',external_reference='OTHER123'
    `);
    expect(await reason()).toBe("payment-already-confirmed");
  });

  it("does not classify the identical confirmed receipt as additional money",async()=>{
    await db.exec(`
      UPDATE pos_payments
      SET status='confirmed',external_reference='RECEIPT123'
    `);
    expect(await reason()).toBeNull();
  });

  it("detects unavailable payment targets",async()=>{
    await db.exec("DELETE FROM pos_payments");
    expect(await reason()).toBe("payment-target-unavailable");
  });

  it("rejects cross-organization payment targets",async()=>{
    await db.exec(`UPDATE pos_payments SET organization_id='${id(99)}'`);
    await expect(reason()).rejects.toThrow(/identity mismatch/);
  });

  it("rejects invalid source bill amounts",async()=>{
    await db.exec("UPDATE pos_orders SET grand_total='NaN'");
    await expect(reason()).rejects.toThrow(/Invalid source bill total/);
  });

  it("does not reclassify an already applied provider transaction",async()=>{
    await db.exec(`
      UPDATE mpesa_transactions
      SET status='success',applied_at=now()
    `);
    await alternate(5000);
    expect(await reason()).toBeNull();
  });

});