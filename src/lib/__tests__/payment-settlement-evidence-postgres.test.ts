import {describe,it,expect,beforeAll,afterAll} from "vitest";

import {PGlite} from "@electric-sql/pglite";

import {readFileSync} from "node:fs";

const org="00000000-0000-4000-8000-000000000001";

const otherOrg="00000000-0000-4000-8000-000000000002";

const branch="00000000-0000-4000-8000-000000000003";

const otherBranch="00000000-0000-4000-8000-000000000004";

const txn="00000000-0000-4000-8000-000000000005";

const otherTxn="00000000-0000-4000-8000-000000000006";

let db:PGlite;

async function register(

  receipt="TESTABC123",

  transaction=txn,

  amount="1500.00",

  organization=org,

  property=branch,

  provider="mpesa",

  currency="KES",

  evidence=JSON.stringify({synthetic:true}),

){

  const result=await db.query<{result:{
    ok:boolean;
    replayed:boolean;
    financially_posted:boolean;
    evidence_id:string;
  } }>(

    `SELECT public.neo_payment_register_verified_evidence(

      $1::uuid,

      $2::uuid,

      $3::text,

      $4::text,

      $5::uuid,

      $6::numeric,

      $7::text,

      $8::jsonb

    ) AS result`,

    [

      organization,

      property,

      provider,

      receipt,

      transaction,

      amount,

      currency,

      evidence,

    ],

  );

  const row = result.rows[0];

  if (!row) {
    throw new Error("Settlement evidence registration returned no result");
  }

  return row.result;

}

beforeAll(async()=>{

  db=new PGlite();

  await db.exec(`

    CREATE ROLE anon;

    CREATE ROLE authenticated;

    CREATE ROLE service_role;

  `);

  await db.exec(

    readFileSync(

      "supabase/migrations/20261126026000_payment_settlement_evidence.sql",

      "utf8"

    ).split("-- PAYMENT_CANONICAL_EVIDENCE_V1")[0]!

  );

},60000);

afterAll(async()=>{

  await db?.close();

});

describe("persistent payment settlement evidence",()=>{

  it("records verified evidence without claiming financial posting",async()=>{

    const result=await register();

    expect(result.ok).toBe(true);

    expect(result.replayed).toBe(false);

    expect(result.financially_posted).toBe(false);

    expect(typeof result.evidence_id).toBe("string");

  });

  it("replays the same receipt and transaction idempotently",async()=>{

    const first=await register();

    const second=await register();

    expect(second.replayed).toBe(true);

    expect(second.evidence_id).toBe(first.evidence_id);

  });

  it("normalizes receipt case and surrounding whitespace",async()=>{

    const result=await register(" testabc123 ");

    expect(result.replayed).toBe(true);

  });

  it("rejects receipt reuse for another transaction",async()=>{

    await expect(

      register("TESTABC123",otherTxn)

    ).rejects.toThrow(/conflicts/);

  });

  it("rejects changed amount on replay",async()=>{

    await expect(

      register("TESTABC123",txn,"1600")

    ).rejects.toThrow(/conflicts/);

  });

  it("rejects receipt reassignment to another property",async()=>{

    await expect(

      register("TESTABC123",txn,"1500",org,otherBranch)

    ).rejects.toThrow(/conflicts/);

  });

  it("rejects a second receipt for the same transaction",async()=>{

    await expect(

      register("TESTDEF456")

    ).rejects.toThrow(/different verified receipt/);

  });

  it("isolates receipt namespaces by organization",async()=>{

    const result=await register(

      "TESTABC123",

      txn,

      "1500",

      otherOrg

    );

    expect(result.replayed).toBe(false);

  });

  it("rejects invalid receipt syntax",async()=>{

    await expect(

      register("bad receipt")

    ).rejects.toThrow(/Invalid provider receipt/);

  });

  it.each([

    "0",

    "-1",

    "NaN",

    "Infinity",

    "-Infinity",

    "0.001",

    "100000001",

  ])("rejects invalid payment amount %s",async amount=>{

    await expect(

      register("TESTNEW789",otherTxn,amount)

    ).rejects.toThrow(/Invalid verified payment amount/);

  });

  it("rejects unsupported currency",async()=>{

    await expect(

      register(

        "TESTNEW789",

        otherTxn,

        "1500",

        org,

        branch,

        "mpesa",

        "USD"

      )

    ).rejects.toThrow(/Unsupported/);

  });

  it("rejects unsupported provider",async()=>{

    await expect(

      register(

        "TESTNEW789",

        otherTxn,

        "1500",

        org,

        branch,

        "unknown"

      )

    ).rejects.toThrow(/Unsupported/);

  });

  it("rejects non-object evidence",async()=>{

    await expect(

      register(

        "TESTNEW789",

        otherTxn,

        "1500",

        org,

        branch,

        "mpesa",

        "KES",

        "[]"

      )

    ).rejects.toThrow(/Invalid payment evidence/);

  });

  it("rejects oversized evidence",async()=>{

    await expect(

      register(

        "TESTNEW789",

        otherTxn,

        "1500",

        org,

        branch,

        "mpesa",

        "KES",

        JSON.stringify({value:"x".repeat(66000)})

      )

    ).rejects.toThrow(/Invalid payment evidence/);

  });

  it("prevents historical evidence modification",async()=>{

    await expect(

      db.exec(`

        UPDATE public.neo_payment_settlement_evidence

        SET amount=9000

      `)

    ).rejects.toThrow(/immutable/);

  });

  it("prevents historical evidence deletion",async()=>{

    await expect(

      db.exec(`

        DELETE FROM public.neo_payment_settlement_evidence

      `)

    ).rejects.toThrow(/immutable/);

  });

  it.each([

    "anon",

    "authenticated",

    "service_role",

  ])("blocks direct evidence access for %s",async role=>{

    const result=await db.query<{allowed:boolean}>(`

      SELECT EXISTS (

        SELECT 1

        FROM unnest(
          ARRAY[
            'SELECT',
            'INSERT',
            'UPDATE',
            'DELETE',
            'TRUNCATE',
            'REFERENCES',
            'TRIGGER'
          ]
        ) AS privilege

        WHERE has_table_privilege(

          '${role}',

          'public.neo_payment_settlement_evidence',

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

  ])("blocks direct evidence registration for %s",async role=>{

    const result=await db.query<{allowed:boolean}>(`

      SELECT has_function_privilege(

        '${role}',

        'public.neo_payment_register_verified_evidence(uuid,uuid,text,text,uuid,numeric,text,jsonb)',

        'EXECUTE'

      ) AS allowed

    `);

    expect(result.rows[0]?.allowed).toBe(false);

  });

  it("retains exactly the two independently scoped records",async()=>{

    const result=await db.query<{count:number}>(`

      SELECT count(*)::int AS count

      FROM public.neo_payment_settlement_evidence

    `);

    expect(result.rows[0]?.count).toBe(2);

  });

});
