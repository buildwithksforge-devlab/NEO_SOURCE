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
const actor="00000000-0000-4000-8000-000000000003";

const txn1="00000000-0000-4000-8000-000000000004";
const txn2="00000000-0000-4000-8000-000000000005";
const txn3="00000000-0000-4000-8000-000000000006";

const payment1="00000000-0000-4000-8000-000000000007";
const payment2="00000000-0000-4000-8000-000000000008";

const otherOrg="00000000-0000-4000-8000-000000000009";

let db:PGlite;

async function guard(transaction:string){

  await db.query(

    `SELECT public.neo_mpesa_payment_target_guard($1::uuid)`,

    [transaction],

  );

}

async function review(
  transaction:string,
  receipt:string,
){

  const result=await db.query<{
    result:{
      ok:boolean;
      state:string;
      can_auto_apply:boolean;
    }
  }>(`

    SELECT public.neo_mpesa_review_receipt_match(

      $1::uuid,

      $2::text

    ) AS result

  `,[transaction,receipt]);

  if(!result.rows[0]){
    throw new Error("Missing receipt review result");
  }

  return result.rows[0].result;

}

async function setting(name:string,value:string){

  await db.query(

    "SELECT set_config($1,$2,false)",

    [name,value],

  );

}

beforeAll(async()=>{

  db=new PGlite();

  await db.exec(`

    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;

    CREATE SCHEMA auth;

    CREATE FUNCTION auth.uid()

    RETURNS uuid

    LANGUAGE sql

    AS $$

      SELECT nullif(

        current_setting('test.actor',true),

        ''

      )::uuid

    $$;

    CREATE FUNCTION public.current_org_id()

    RETURNS uuid

    LANGUAGE sql

    AS $$

      SELECT nullif(

        current_setting('test.organization',true),

        ''

      )::uuid

    $$;

    CREATE FUNCTION public.current_access_scope()

    RETURNS text

    LANGUAGE sql

    AS $$

      SELECT nullif(

        current_setting('test.scope',true),

        ''

      )

    $$;

    CREATE FUNCTION public.neo_mpesa_receipt_can_approve(

      uuid,uuid

    )

    RETURNS boolean

    LANGUAGE sql

    AS $$

      SELECT $1=public.current_org_id()

        AND $2='${branch}'::uuid

        AND current_setting(

          'test.can_approve',true

        )='true'

    $$;


    CREATE TABLE public.mpesa_transactions(

      id uuid PRIMARY KEY,

      organization_id uuid NOT NULL,

      branch_id uuid,

      amount numeric NOT NULL,

      status text NOT NULL,

      applied_at timestamptz,

      mpesa_receipt_number text,

      checkout_request_id text,

      merchant_request_id text,

      payment_table text,

      payment_id uuid,

      source_module text,

      source_record_id uuid

    );


    INSERT INTO public.mpesa_transactions(

      id,

      organization_id,

      branch_id,

      amount,

      status,

      applied_at,

      mpesa_receipt_number,

      payment_table,

      payment_id

    ) VALUES

      (

        '${txn1}',

        '${org}',

        '${branch}',

        1500,

        'success',

        now(),

        'APPLIED123',

        'pos_payments',

        '${payment1}'

      ),

      (

        '${txn2}',

        '${org}',

        '${branch}',

        1500,

        'pending',

        NULL,

        NULL,

        'pos_payments',

        '${payment1}'

      ),

      (

        '${txn3}',

        '${org}',

        '${branch}',

        2000,

        'pending',

        NULL,

        NULL,

        'pos_payments',

        '${payment2}'

      );


    -- Canonical installation contract fixture.
    -- No production financial posting is performed.

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

    AS $function$

    DECLARE

      _t public.mpesa_transactions;

    BEGIN

      SELECT * INTO _t

      FROM public.mpesa_transactions

      WHERE id=_transaction

      FOR UPDATE;

  -- A late verified successful callback may supersede an earlier non-success.

      RETURN jsonb_build_object(

        'applied',false,

        'status',_t.status

      );

    END;

    $function$;

  `);

  await db.exec(

    readFileSync(

      "supabase/migrations/20261126026000_payment_settlement_evidence.sql",

      "utf8"

    ).split("-- PAYMENT_OVERPAYMENT_ACCOUNTING_V1")[0]!

  );

  await setting("test.actor",actor);

  await setting("test.organization",org);

  await setting("test.scope","operational");

  await setting("test.can_approve","true");

},60000);

afterAll(async()=>{

  await db?.close();

});

describe("payment target and receipt review authority",()=>{

  it("allows replay against the original payment attempt",async()=>{

    await expect(guard(txn1)).resolves.toBeUndefined();

  });

  it("blocks a second provider attempt settling the same payment",async()=>{

    await expect(guard(txn2)).rejects.toThrow(

      /already settled by another provider attempt/

    );

  });

  it("allows independently identified payment records",async()=>{

    await expect(guard(txn3)).resolves.toBeUndefined();

  });

  it("blocks unsupported payment targets",async()=>{

    await db.exec(`

      UPDATE public.mpesa_transactions

      SET payment_table='unsupported'

      WHERE id='${txn3}'

    `);

    try{

      await expect(guard(txn3)).rejects.toThrow(

        /Unsupported payment settlement target/

      );

    }finally{

      await db.exec(`

        UPDATE public.mpesa_transactions

        SET payment_table='pos_payments'

        WHERE id='${txn3}'

      `);

    }

  });

  it("does not conflate POS and folio payment identifiers",async()=>{

    await db.exec(`

      UPDATE public.mpesa_transactions

      SET payment_table='payments'

      WHERE id='${txn2}'

    `);

    try{

      await expect(guard(txn2)).resolves.toBeUndefined();

    }finally{

      await db.exec(`

        UPDATE public.mpesa_transactions

        SET payment_table='pos_payments'

        WHERE id='${txn2}'

      `);

    }

  });

  it("allows authorized receipt reviewers to inspect existing evidence",async()=>{

    const result=await review(txn1,"APPLIED123");

    expect(result.state).toBe("already-applied");

    expect(result.can_auto_apply).toBe(false);

  });

  it("does not confirm a manually supplied unknown receipt",async()=>{

    const result=await review(txn3,"UNKNOWN123");

    expect(result.state).toBe(

      "provider-verification-required"

    );

    expect(result.can_auto_apply).toBe(false);

  });

  it("blocks unauthorized reviewers",async()=>{

    await setting("test.can_approve","false");

    try{

      await expect(

        review(txn1,"APPLIED123")

      ).rejects.toThrow(/permission required/);

    }finally{

      await setting("test.can_approve","true");

    }

  });

  it("blocks technical access from receipt verification",async()=>{

    await setting("test.scope","technical");

    try{

      await expect(

        review(txn1,"APPLIED123")

      ).rejects.toThrow(/Technical access/);

    }finally{

      await setting("test.scope","operational");

    }

  });

  it("blocks missing access scope",async()=>{

    await setting("test.scope","");

    try{

      await expect(

        review(txn1,"APPLIED123")

      ).rejects.toThrow(/permission required/);

    }finally{

      await setting("test.scope","operational");

    }

  });

  it("blocks receipt inspection across organizations",async()=>{

    await setting("test.organization",otherOrg);

    try{

      await expect(

        review(txn1,"APPLIED123")

      ).rejects.toThrow(/authorized property scope/);

    }finally{

      await setting("test.organization",org);

    }

  });

  it("blocks unauthenticated receipt review",async()=>{

    await setting("test.actor","");

    try{

      await expect(

        review(txn1,"APPLIED123")

      ).rejects.toThrow(/Authentication required/);

    }finally{

      await setting("test.actor",actor);

    }

  });

  it("keeps direct payment target guard execution restricted",async()=>{

    const result=await db.query<{allowed:boolean}>(`

      SELECT has_function_privilege(

        'authenticated',

        'public.neo_mpesa_payment_target_guard(uuid)',

        'EXECUTE'

      ) AS allowed

    `);

    expect(result.rows[0]?.allowed).toBe(false);

  });

  it("exposes only the permission-controlled review function",async()=>{

    const result=await db.query<{
      authenticated:boolean;
      anonymous:boolean;
    }>(`

      SELECT

        has_function_privilege(

          'authenticated',

          'public.neo_mpesa_review_receipt_match(uuid,text)',

          'EXECUTE'

        ) AS authenticated,

        has_function_privilege(

          'anon',

          'public.neo_mpesa_review_receipt_match(uuid,text)',

          'EXECUTE'

        ) AS anonymous

    `);

    expect(result.rows[0]?.authenticated).toBe(true);

    expect(result.rows[0]?.anonymous).toBe(false);

  });

  it("enforces payment target protection inside canonical execution",async()=>{

    await expect(

      db.query(`

        SELECT public.neo_mpesa_apply_result(

          '${txn2}',

          0,

          'Synthetic result',

          'ANOTHER123',

          '20261127120000',

          '{}'::jsonb,

          'callback'

        )

      `)

    ).rejects.toThrow(

      /already settled by another provider attempt/

    );

  });

  it("does not create financial evidence through receipt inspection",async()=>{

    const result=await db.query<{count:number}>(`

      SELECT count(*)::int AS count

      FROM public.neo_payment_settlement_evidence

    `);

    expect(result.rows[0]?.count).toBe(0);

  });

});