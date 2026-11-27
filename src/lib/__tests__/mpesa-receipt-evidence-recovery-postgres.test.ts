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
const pending="00000000-0000-4000-8000-000000000003";
const applied="00000000-0000-4000-8000-000000000004";
const verified="00000000-0000-4000-8000-000000000005";
const otherBranch="00000000-0000-4000-8000-000000000006";
const otherOrg="00000000-0000-4000-8000-000000000007";

let db:PGlite;

interface MatchResult {
  ok:boolean;
  state:string;
  can_auto_apply:boolean;
  amount?:number;
  currency?:string;
  evidence_id?:string;
  financial_reconciliation_required?:boolean;
}

async function match(
  transaction:string,
  receipt:string,
  organization=org,
  property=branch,
){

  const result=await db.query<{result:MatchResult}>(`

    SELECT public.neo_mpesa_match_receipt_evidence(

      $1::uuid,

      $2::uuid,

      $3::uuid,

      $4::text

    ) AS result

  `,[organization,property,transaction,receipt]);

  const row=result.rows[0];

  if(!row){
    throw new Error("Receipt matching returned no result");
  }

  return row.result;

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

      mpesa_receipt_number text

    );

    INSERT INTO public.mpesa_transactions VALUES

      (
        '${pending}',
        '${org}',
        '${branch}',
        1500,
        'pending',
        NULL,
        NULL
      ),

      (
        '${applied}',
        '${org}',
        '${branch}',
        1500,
        'success',
        now(),
        'APPLIED123'
      ),

      (
        '${verified}',
        '${org}',
        '${branch}',
        2500,
        'pending',
        NULL,
        NULL
      );

  `);

  const migration=readFileSync(

    "supabase/migrations/20261126026000_payment_settlement_evidence.sql",

    "utf8"

  );

  const evidenceSql=migration.split(

    "-- PAYMENT_CANONICAL_EVIDENCE_V1"

  )[0];

  const recoverySql=migration.split(

    "-- PAYMENT_RECEIPT_RECOVERY_V1"

  )[1];

  if(!evidenceSql || !recoverySql){
    throw new Error("Required migration sections unavailable");
  }

  await db.exec(evidenceSql);

  await db.exec(recoverySql.split("-- PAYMENT_TARGET_INTEGRITY_V1")[0]!);

  await db.exec(`

    SELECT public.neo_payment_register_verified_evidence(

      '${org}',

      '${branch}',

      'mpesa',

      'VERIFIED123',

      '${verified}',

      2500,

      'KES',

      '{"synthetic":true}'::jsonb

    );

  `);

},60000);

afterAll(async()=>{

  await db?.close();

});

describe("controlled M-Pesa receipt evidence recovery",()=>{

  it("does not confirm payment using a manually entered receipt",async()=>{

    const result=await match(pending,"UNKNOWN123");

    expect(result.ok).toBe(false);

    expect(result.state).toBe(
      "provider-verification-required"
    );

    expect(result.can_auto_apply).toBe(false);

  });

  it("recognizes an already applied provider receipt",async()=>{

    const result=await match(applied,"APPLIED123");

    expect(result.ok).toBe(true);

    expect(result.state).toBe("already-applied");

    expect(result.can_auto_apply).toBe(false);

    expect(
      result.financial_reconciliation_required
    ).toBe(true);

  });

  it("normalizes receipt case and whitespace",async()=>{

    const result=await match(applied," applied123 ");

    expect(result.state).toBe("already-applied");

  });

  it("rejects assigning an applied receipt to another attempt",async()=>{

    const result=await match(pending,"APPLIED123");

    expect(result.state).toBe(
      "receipt-already-assigned"
    );

    expect(result.can_auto_apply).toBe(false);

  });

  it("rejects conflicting receipt evidence on another attempt",async()=>{

    const result=await match(pending,"VERIFIED123");

    expect(result.state).toBe(
      "receipt-evidence-conflict"
    );

    expect(result.can_auto_apply).toBe(false);

  });

  it("recognizes matching evidence without automatically posting",async()=>{

    const result=await match(verified,"VERIFIED123");

    expect(result.ok).toBe(true);

    expect(result.state).toBe(
      "verified-evidence-review-required"
    );

    expect(result.can_auto_apply).toBe(false);

    expect(Number(result.amount)).toBe(2500);

  });

  it("rejects changing the receipt for an existing verified attempt",async()=>{

    const result=await match(verified,"DIFFERENT123");

    expect(result.state).toBe(
      "different-receipt-registered"
    );

  });

  it("rejects changing an applied receipt",async()=>{

    const result=await match(applied,"DIFFERENT123");

    expect(result.state).toBe(
      "applied-receipt-conflict"
    );

  });

  it("blocks access outside the property scope",async()=>{

    await expect(

      match(pending,"UNKNOWN123",org,otherBranch)

    ).rejects.toThrow(/property scope/);

  });

  it("blocks access outside the organization scope",async()=>{

    await expect(

      match(pending,"UNKNOWN123",otherOrg)

    ).rejects.toThrow(/property scope/);

  });

  it("rejects malformed provider receipts",async()=>{

    await expect(

      match(pending,"invalid receipt!")

    ).rejects.toThrow(/Invalid provider receipt/);

  });

  it("rejects changed transaction amounts against saved evidence",async()=>{

    await db.exec(`

      UPDATE public.mpesa_transactions

      SET amount=3000

      WHERE id='${verified}';

    `);

    try{

      const result=await match(
        verified,"VERIFIED123"
      );

      expect(result.state).toBe(
        "receipt-evidence-conflict"
      );

    }finally{

      await db.exec(`

        UPDATE public.mpesa_transactions

        SET amount=2500

        WHERE id='${verified}';

      `);

    }

  });

  it.each([

    "anon",

    "authenticated",

    "service_role",

  ])("retains restricted helper execution for %s",async role=>{

    const result=await db.query<{allowed:boolean}>(`

      SELECT has_function_privilege(

        '${role}',

        'public.neo_mpesa_match_receipt_evidence(uuid,uuid,uuid,text)',

        'EXECUTE'

      ) AS allowed

    `);

    expect(result.rows[0]?.allowed).toBe(false);

  });

  it("does not mutate pending payment status during receipt matching",async()=>{

    const result=await db.query<{status:string}>(`

      SELECT status

      FROM public.mpesa_transactions

      WHERE id='${pending}'

    `);

    expect(result.rows[0]?.status).toBe("pending");

  });

  it("does not create additional settlement evidence during lookup",async()=>{

    const result=await db.query<{count:number}>(`

      SELECT count(*)::int AS count

      FROM public.neo_payment_settlement_evidence

    `);

    expect(result.rows[0]?.count).toBe(1);

  });

});