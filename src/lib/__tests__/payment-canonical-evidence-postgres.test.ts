import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";

import { PGlite } from "@electric-sql/pglite";

import { readFileSync } from "node:fs";

const org="00000000-0000-4000-8000-000000000001";

const branch="00000000-0000-4000-8000-000000000002";

const txn1="00000000-0000-4000-8000-000000000003";

const txn2="00000000-0000-4000-8000-000000000004";

const txn3="00000000-0000-4000-8000-000000000005";

let db:PGlite;

async function apply(
  transaction:string,
  receipt:string,
  source="callback",
  resultCode=0,
){

  const result=await db.query<{
    result:{
      applied:boolean;
      duplicate?:boolean;
      status:string;
    }
  }>(`

    SELECT public.neo_mpesa_apply_result(
      $1::uuid,
      $2::integer,
      'Synthetic provider result',
      $3::text,
      '20261127110000',
      '{"synthetic":true}'::jsonb,
      $4::text
    ) AS result

  `,[transaction,resultCode,receipt,source]);

  const row=result.rows[0];

  if(!row){
    throw new Error("Missing settlement result");
  }

  return row.result;

}

async function countEvidence(){

  const result=await db.query<{count:number}>(`

    SELECT count(*)::int AS count
    FROM public.neo_payment_settlement_evidence

  `);

  return result.rows[0]?.count;

}

async function countPosting(){

  const result=await db.query<{count:number}>(`

    SELECT count(*)::int AS count
    FROM public.synthetic_payment_postings

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

      status text NOT NULL DEFAULT 'pending',

      applied_at timestamptz,

      mpesa_receipt_number text,

      checkout_request_id text,

      merchant_request_id text

    );

    CREATE TABLE public.synthetic_payment_postings(

      transaction_id uuid PRIMARY KEY,

      amount numeric NOT NULL

    );

    INSERT INTO public.mpesa_transactions(

      id,
      organization_id,
      branch_id,
      amount,
      checkout_request_id,
      merchant_request_id

    ) VALUES

      ('${txn1}','${org}','${branch}',1500,'checkout-1','merchant-1'),

      ('${txn2}','${org}','${branch}',1500,'checkout-2','merchant-2'),

      ('${txn3}','${org}','${branch}',2000,'checkout-3','merchant-3');

    -- Isolated canonical contract fixture.
    -- Financial postings are synthetic in this test.

    CREATE FUNCTION public.neo_mpesa_apply_result(

      _transaction uuid,
      _result_code integer,
      _result_desc text,
      _receipt text,
      _transaction_date text,
      _payload jsonb,
      _source text DEFAULT 'callback'

    )

    RETURNS jsonb

    LANGUAGE plpgsql

    SECURITY DEFINER

    SET search_path = public,pg_temp

    AS $function$

    DECLARE

      _t public.mpesa_transactions;

    BEGIN

      SELECT * INTO _t

      FROM public.mpesa_transactions

      WHERE id=_transaction

      FOR UPDATE;

      IF _t.id IS NULL THEN

        RAISE EXCEPTION 'Transaction not found';

      END IF;

  -- A late verified successful callback may supersede an earlier non-success.

      IF _t.applied_at IS NOT NULL THEN

        RETURN jsonb_build_object(

          'applied',false,

          'duplicate',true,

          'status',_t.status

        );

      END IF;

      IF _result_code<>0 THEN

        RETURN jsonb_build_object(

          'applied',true,

          'status','failed'

        );

      END IF;

      IF _receipt='FAILPOST123' THEN

        RAISE EXCEPTION 'Synthetic financial posting failure';

      END IF;

      INSERT INTO public.synthetic_payment_postings(

        transaction_id,

        amount

      ) VALUES (

        _t.id,

        _t.amount

      );

      UPDATE public.mpesa_transactions

      SET status='success',

          applied_at=now(),

          mpesa_receipt_number=_receipt

      WHERE id=_t.id;

      RETURN jsonb_build_object(

        'applied',true,

        'status','success'

      );

    END;

    $function$;

    REVOKE ALL ON FUNCTION

      public.neo_mpesa_apply_result(

        uuid,integer,text,text,text,jsonb,text

      )

    FROM PUBLIC,anon,authenticated;

    GRANT EXECUTE ON FUNCTION

      public.neo_mpesa_apply_result(

        uuid,integer,text,text,text,jsonb,text

      )

    TO service_role;

  `);

  const migration=readFileSync(

    "supabase/migrations/20261126026000_payment_settlement_evidence.sql",

    "utf8"

  );

  await db.exec(migration.split("-- PAYMENT_RECEIPT_RECOVERY_V1")[0]!);

},60000);

afterAll(async()=>{

  await db?.close();

});

describe("canonical M-Pesa settlement evidence integration",()=>{

  it("registers evidence and posts in the same transaction",async()=>{

    const result=await apply(txn1,"SYNTHETIC123");

    expect(result.applied).toBe(true);

    expect(result.status).toBe("success");

    expect(await countEvidence()).toBe(1);

    expect(await countPosting()).toBe(1);

  });

  it("does not duplicate evidence or postings during replay",async()=>{

    const result=await apply(txn1,"SYNTHETIC123");

    expect(result.duplicate).toBe(true);

    expect(await countEvidence()).toBe(1);

    expect(await countPosting()).toBe(1);

  });

  it("rejects receipt reassignment to a different transaction",async()=>{

    await expect(

      apply(txn2,"SYNTHETIC123")

    ).rejects.toThrow(/conflicts/);

    expect(await countEvidence()).toBe(1);

    expect(await countPosting()).toBe(1);

  });

  it("rejects changing an already applied receipt",async()=>{

    await expect(

      apply(txn1,"DIFFERENT123")

    ).rejects.toThrow(/conflicts/);

    expect(await countPosting()).toBe(1);

  });

  it("rolls back registered evidence if financial posting fails",async()=>{

    await expect(

      apply(txn2,"FAILPOST123")

    ).rejects.toThrow(/Synthetic financial posting failure/);

    expect(await countEvidence()).toBe(1);

    expect(await countPosting()).toBe(1);

  });

  it("allows recovery after an atomic posting failure",async()=>{

    const result=await apply(txn2,"RECOVERY123");

    expect(result.applied).toBe(true);

    expect(await countEvidence()).toBe(2);

    expect(await countPosting()).toBe(2);

  });

  it("rejects unsupported success result sources",async()=>{

    await expect(

      apply(txn3,"UNTRUSTED123","manual")

    ).rejects.toThrow(/Verified payment result source required/);

    expect(await countEvidence()).toBe(2);

    expect(await countPosting()).toBe(2);

  });

  it("does not register successful receipt evidence for failed results",async()=>{

    const result=await apply(

      txn3,

      "FAILED123",

      "callback",

      1032

    );

    expect(result.status).toBe("failed");

    expect(await countEvidence()).toBe(2);

    expect(await countPosting()).toBe(2);

  });

  it("accepts an independently verified status-query result",async()=>{

    const result=await apply(

      txn3,

      "VERIFIED123",

      "status-query"

    );

    expect(result.applied).toBe(true);

    expect(await countEvidence()).toBe(3);

    expect(await countPosting()).toBe(3);

  });

  it("preserves exact financial amounts",async()=>{

    const result=await db.query<{total:string}>(`

      SELECT sum(amount)::text AS total

      FROM public.synthetic_payment_postings

    `);

    expect(Number(result.rows[0]?.total)).toBe(5000);

  });

  it("retains revoked direct evidence registration",async()=>{

    const result=await db.query<{allowed:boolean}>(`

      SELECT has_function_privilege(

        'service_role',

        'public.neo_payment_register_verified_evidence(uuid,uuid,text,text,uuid,numeric,text,jsonb)',

        'EXECUTE'

      ) AS allowed

    `);

    expect(result.rows[0]?.allowed).toBe(false);

  });

  it("preserves trusted canonical execution authority",async()=>{

    const result=await db.query<{allowed:boolean}>(`

      SELECT has_function_privilege(

        'service_role',

        'public.neo_mpesa_apply_result(uuid,integer,text,text,text,jsonb,text)',

        'EXECUTE'

      ) AS allowed

    `);

    expect(result.rows[0]?.allowed).toBe(true);

  });

  it("does not grant anonymous canonical execution",async()=>{

    const result=await db.query<{allowed:boolean}>(`

      SELECT has_function_privilege(

        'anon',

        'public.neo_mpesa_apply_result(uuid,integer,text,text,text,jsonb,text)',

        'EXECUTE'

      ) AS allowed

    `);

    expect(result.rows[0]?.allowed).toBe(false);

  });

  it("does not grant authenticated users direct settlement execution",async()=>{

    const result=await db.query<{allowed:boolean}>(`

      SELECT has_function_privilege(

        'authenticated',

        'public.neo_mpesa_apply_result(uuid,integer,text,text,text,jsonb,text)',

        'EXECUTE'

      ) AS allowed

    `);

    expect(result.rows[0]?.allowed).toBe(false);

  });

});