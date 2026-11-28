import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";

import {PGlite} from "@electric-sql/pglite";

import {readFileSync} from "node:fs";

const org="00000000-0000-4000-8000-000000000001";
const branch="00000000-0000-4000-8000-000000000002";
const txn1="00000000-0000-4000-8000-000000000003";
const txn2="00000000-0000-4000-8000-000000000004";
const payment="00000000-0000-4000-8000-000000000005";
const evidence1="00000000-0000-4000-8000-000000000006";
const evidence2="00000000-0000-4000-8000-000000000007";

let db:PGlite;

interface ExceptionResult {
  ok:boolean;
  replayed:boolean;
  exception_id:string;
  state:string;
  amount:number;
  currency:string;
  financially_posted:boolean;
}

async function preserve(
  transaction=txn1,
  evidence=evidence1,
  reason="bill-already-settled",
){

  const result=await db.query<{
    result:ExceptionResult;
  }>(`

    SELECT public.neo_mpesa_preserve_late_receipt(

      $1::uuid,

      $2::uuid,

      $3::text

    ) AS result

  `,[transaction,evidence,reason]);

  const row=result.rows[0];

  if(!row){
    throw new Error("Missing late-payment result");
  }

  return row.result;

}

async function countExceptions(){

  const result=await db.query<{count:number}>(`

    SELECT count(*)::int AS count

    FROM public.neo_payment_late_receipt_exceptions

  `);

  return result.rows[0]?.count;

}

beforeAll(async()=>{

  db=new PGlite();

  await db.exec(`

    CREATE ROLE anon;

    CREATE ROLE authenticated;

    CREATE ROLE service_role;


    CREATE TABLE public.mpesa_transactions(

      id uuid PRIMARY KEY,

      organization_id uuid NOT NULL,

      branch_id uuid,

      amount numeric NOT NULL,

      status text NOT NULL,

      applied_at timestamptz,

      payment_table text,

      payment_id uuid

    );


    INSERT INTO public.mpesa_transactions VALUES

    (

      '${txn1}',

      '${org}',

      '${branch}',

      5000,

      'pending',

      NULL,

      'pos_payments',

      '${payment}'

    ),

    (

      '${txn2}',

      '${org}',

      '${branch}',

      5000,

      'success',

      now(),

      'pos_payments',

      '${payment}'

    );

  `);


  const migration=readFileSync(

    "supabase/migrations/20261126026000_payment_settlement_evidence.sql",

    "utf8"

  );


  const evidenceSql=migration.split(

    "-- PAYMENT_CANONICAL_EVIDENCE_V1"

  )[0];


  const lateSql=migration.split(

    "-- PAYMENT_LATE_RECEIPT_EXCEPTION_V1"

  )[1];


  if(!evidenceSql || !lateSql){

    throw new Error("Migration section unavailable");

  }


  await db.exec(evidenceSql);

  await db.exec(lateSql.split("-- PAYMENT_OVERPAYMENT_ACCOUNTING_V1")[0]!);


  await db.exec(`

    INSERT INTO public.neo_payment_settlement_evidence(

      id,

      organization_id,

      branch_id,

      provider,

      provider_receipt,

      transaction_id,

      amount,

      currency,

      evidence

    ) VALUES

    (

      '${evidence1}',

      '${org}',

      '${branch}',

      'mpesa',

      'LATETEST123',

      '${txn1}',

      5000,

      'KES',

      '{"synthetic":true}'::jsonb

    ),

    (

      '${evidence2}',

      '${org}',

      '${branch}',

      'mpesa',

      'APPLIED123',

      '${txn2}',

      5000,

      'KES',

      '{"synthetic":true}'::jsonb

    );

  `);

},60000);

afterAll(async()=>{

  await db?.close();

});

describe("late verified payment preservation",()=>{

  it("preserves additional received money separately from sales",async()=>{

    const result=await preserve();

    expect(result.ok).toBe(true);

    expect(result.replayed).toBe(false);

    expect(result.state).toBe("awaiting-accounting");

    expect(Number(result.amount)).toBe(5000);

    expect(result.financially_posted).toBe(false);

    expect(await countExceptions()).toBe(1);

  });

  it("replays an existing exception without duplication",async()=>{

    const first=await preserve();

    const second=await preserve();

    expect(second.replayed).toBe(true);

    expect(second.exception_id).toBe(first.exception_id);

    expect(await countExceptions()).toBe(1);

  });

  it("rejects assigning evidence from a different transaction",async()=>{

    await expect(

      preserve(txn1,evidence2)

    ).rejects.toThrow(/does not match/);

  });

  it("rejects reclassifying an already applied payment",async()=>{

    await expect(

      preserve(txn2,evidence2)

    ).rejects.toThrow(/Already applied payment/);

  });

  it("rejects a conflicting exception reason on replay",async()=>{

    await expect(

      preserve(txn1,evidence1,"duplicate-payment-target")

    ).rejects.toThrow(/conflicts/);

  });

  it("rejects an unsupported exception reason",async()=>{

    await expect(

      preserve(txn1,evidence1,"unsupported")

    ).rejects.toThrow(/Invalid late-payment exception reason/);

  });

  it("rejects missing evidence",async()=>{

    await expect(

      preserve(

        txn1,

        "00000000-0000-4000-8000-000000000099"

      )

    ).rejects.toThrow(/does not match/);

  });

  it("rejects changed transaction amounts",async()=>{

    await db.exec(`

      UPDATE public.mpesa_transactions

      SET amount=6000

      WHERE id='${txn1}'

    `);

    try{

      await expect(

        preserve()

      ).rejects.toThrow(/does not match/);

    }finally{

      await db.exec(`

        UPDATE public.mpesa_transactions

        SET amount=5000

        WHERE id='${txn1}'

      `);

    }

  });

  it("rejects changed property scope",async()=>{

    await db.exec(`

      UPDATE public.mpesa_transactions

      SET branch_id='00000000-0000-4000-8000-000000000088'

      WHERE id='${txn1}'

    `);

    try{

      await expect(

        preserve()

      ).rejects.toThrow(/does not match/);

    }finally{

      await db.exec(`

        UPDATE public.mpesa_transactions

        SET branch_id='${branch}'

        WHERE id='${txn1}'

      `);

    }

  });

  it("protects the exception amount against modification",async()=>{

    await expect(

      db.exec(`

        UPDATE public.neo_payment_late_receipt_exceptions

        SET amount=1

      `)

    ).rejects.toThrow(/immutable/);

  });

  it("prevents deletion of preserved additional money",async()=>{

    await expect(

      db.exec(`

        DELETE FROM public.neo_payment_late_receipt_exceptions

      `)

    ).rejects.toThrow(/immutable/);

  });

  it.each([

    "anon",

    "authenticated",

    "service_role",

  ])("blocks direct exception table privileges for %s",async role=>{

    const result=await db.query<{allowed:boolean}>(`

      SELECT EXISTS(

        SELECT 1

        FROM unnest(ARRAY[

          'SELECT',

          'INSERT',

          'UPDATE',

          'DELETE',

          'TRUNCATE',

          'REFERENCES',

          'TRIGGER'

        ]) AS privilege

        WHERE has_table_privilege(

          '${role}',

          'public.neo_payment_late_receipt_exceptions',

          privilege

        )

      ) AS allowed

    `);

    expect(result.rows[0]?.allowed).toBe(false);

  });

  it.each([

    "anon",

    "authenticated",

    "service_role",

  ])("restricts direct late-payment registration for %s",async role=>{

    const result=await db.query<{allowed:boolean}>(`

      SELECT has_function_privilege(

        '${role}',

        'public.neo_mpesa_preserve_late_receipt(uuid,uuid,text)',

        'EXECUTE'

      ) AS allowed

    `);

    expect(result.rows[0]?.allowed).toBe(false);

  });

  it("does not falsely mark the original payment as settled",async()=>{

    const result=await db.query<{

      status:string;

      applied_at:string|null;

    }>(`

      SELECT status,applied_at

      FROM public.mpesa_transactions

      WHERE id='${txn1}'

    `);

    expect(result.rows[0]?.status).toBe("pending");

    expect(result.rows[0]?.applied_at).toBeNull();

  });

  it("retains exactly KES 5000 of unresolved additional money",async()=>{

    const result=await db.query<{total:string}>(`

      SELECT sum(amount)::text AS total

      FROM public.neo_payment_late_receipt_exceptions

    `);

    expect(Number(result.rows[0]?.total)).toBe(5000);

    expect(await countExceptions()).toBe(1);

  });

});