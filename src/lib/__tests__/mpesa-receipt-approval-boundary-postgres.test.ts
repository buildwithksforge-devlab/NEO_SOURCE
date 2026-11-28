import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {
  describe,it,expect,beforeAll,beforeEach,afterAll,
} from "vitest";

const id=(n:number)=>
  `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;

const org=id(1);
const branch=id(2);
const requester=id(3);
const reviewer=id(4);
const request=id(5);
const payment=id(6);

let db:PGlite;

async function setting(key:string,value:string){

  await db.query(
    "SELECT set_config($1,$2,false)",
    [key,value],
  );

}

async function guard(action="approved"){

  return db.query(
    "SELECT public.neo_mpesa_receipt_decision_guard($1,$2)",
    [request,action],
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
    RETURNS uuid LANGUAGE sql AS $$

      SELECT nullif(
        current_setting('test.actor',true),''
      )::uuid

    $$;

    CREATE FUNCTION public.current_org_id()
    RETURNS uuid LANGUAGE sql AS $$

      SELECT nullif(
        current_setting('test.organization',true),''
      )::uuid

    $$;

    CREATE FUNCTION public.current_access_scope()
    RETURNS text LANGUAGE sql AS $$

      SELECT nullif(
        current_setting('test.scope',true),''
      )

    $$;

    CREATE FUNCTION public.neo_mpesa_receipt_can_approve(
      uuid,uuid
    )
    RETURNS boolean LANGUAGE sql AS $$

      SELECT $1=public.current_org_id()

        AND $2='${branch}'::uuid

        AND current_setting(
          'test.approve',true
        )='true'

    $$;

    CREATE TABLE public.approval_requests(

      id uuid PRIMARY KEY,

      organization_id uuid,

      branch_id uuid,

      approval_type text,

      source_module text,

      source_record_id uuid,

      requester_id uuid,

      status text,

      execution_status text,

      amount numeric

    );

  `);

  const migration=readFileSync(

    "supabase/migrations/20261126026000_payment_settlement_evidence.sql",

    "utf8",

  );

  const section=migration.split(

    "-- PAYMENT_RECEIPT_APPROVAL_AUTHORITY_V1"

  )[1]?.split("DO $install$")[0];

  if(!section){

    throw new Error("Receipt authority source unavailable");

  }

  await db.exec(section);

  await db.exec(`

    ALTER TABLE public.approval_requests

      ADD COLUMN approver_id uuid,

      ADD COLUMN self_approved boolean DEFAULT false,

      ADD COLUMN emergency_override boolean DEFAULT false,

      ADD COLUMN notes text;


    CREATE TABLE public.approval_steps(

      request_id uuid,

      organization_id uuid,

      status text,

      decided_by uuid

    );


    CREATE TABLE public.approval_actions(

      request_id uuid,

      organization_id uuid,

      actor_id uuid,

      action text,

      comment text

    );

  `);

  const executionSection=migration.split(

    "-- PAYMENT_RECEIPT_EXECUTION_AUTHORITY_V1"

  )[1]?.split("DO $install$")[0];

  if(!executionSection){

    throw new Error("Financial execution guard unavailable");

  }

  await db.exec(executionSection);

},60000);

afterAll(async()=>{

  await db?.close();

});

beforeEach(async()=>{

  await db.exec(`

    TRUNCATE public.approval_requests;

    INSERT INTO public.approval_requests(
      id,organization_id,branch_id,
      approval_type,source_module,source_record_id,
      requester_id,status,execution_status,amount
    ) VALUES(

      '${request}',

      '${org}',

      '${branch}',

      'mpesa-receipt-review',

      'pos',

      '${payment}',

      '${requester}',

      'pending_approval',

      'pending',

      5000

    );

  `);

  await setting("test.actor",reviewer);
  await setting("test.organization",org);
  await setting("test.scope","operational");
  await setting("test.approve","true");

});

describe("receipt decision authority",()=>{

  it("allows an independent authorized reviewer",async()=>{

    await expect(guard()).resolves.toBeDefined();

  });

  it("rejects self-approval",async()=>{

    await setting("test.actor",requester);

    await expect(guard()).rejects.toThrow(

      /independent approval/

    );

  });

  it("rejects technical financial approval",async()=>{

    await setting("test.scope","technical");

    await expect(guard()).rejects.toThrow(

      /Operational financial access/

    );

  });

  it("rejects missing operational scope",async()=>{

    await setting("test.scope","");

    await expect(guard()).rejects.toThrow(

      /Operational financial access/

    );

  });

  it("rejects unauthenticated decisions",async()=>{

    await setting("test.actor","");

    await expect(guard()).rejects.toThrow(

      /Authentication required/

    );

  });

  it("rejects cross-organization decisions",async()=>{

    await setting("test.organization",id(99));

    await expect(guard()).rejects.toThrow(

      /authorized property scope/

    );

  });

  it("rejects cross-property decisions",async()=>{

    await db.exec(`

      UPDATE public.approval_requests

      SET branch_id='${id(99)}'

    `);

    await expect(guard()).rejects.toThrow(

      /authorized property scope/

    );

  });

  it("rejects missing approval permissions",async()=>{

    await setting("test.approve","false");

    await expect(guard()).rejects.toThrow(

      /authorized property scope/

    );

  });

  it("rejects missing receipt submission actor",async()=>{

    await db.exec(`

      UPDATE public.approval_requests

      SET requester_id=NULL

    `);

    await expect(guard()).rejects.toThrow(

      /submission actor/

    );

  });

  it.each(["0","-1","NaN","Infinity","1.123","100000001"])(

    "rejects invalid approval amount %s",

    async amount=>{

      await db.query(

        "UPDATE public.approval_requests SET amount=$1::numeric",

        [amount],

      );

      await expect(guard()).rejects.toThrow(

        /amount is invalid/

      );

    }

  );

  it("preserves authorized rejection",async()=>{

    await expect(

      guard("rejected")

    ).resolves.toBeDefined();

  });

  it("preserves return for correction",async()=>{

    await expect(

      guard("returned")

    ).resolves.toBeDefined();

  });

  it("rejects invalid decision actions",async()=>{

    await expect(

      guard("confirm-payment")

    ).rejects.toThrow(/Invalid receipt decision/);

  });

  it("does not retrospectively invalidate completed approval records",async()=>{

    await db.exec(`

      UPDATE public.approval_requests

      SET status='completed',

          execution_status='succeeded'

    `);

    await setting("test.actor",requester);

    await expect(guard()).resolves.toBeDefined();

  });

  it("does not mutate receipt approval status",async()=>{

    await guard();

    const result=await db.query<{status:string}>(`

      SELECT status

      FROM public.approval_requests

      WHERE id='${request}'

    `);

    expect(result.rows[0]?.status).toBe(

      "pending_approval"

    );

  });

  it.each(["anon","authenticated","service_role"])(

    "restricts direct execution for %s",

    async role=>{

      const result=await db.query<{allowed:boolean}>(`

        SELECT has_function_privilege(

          '${role}',

          'public.neo_mpesa_receipt_decision_guard(uuid,text)',

          'EXECUTE'

        ) AS allowed

      `);

      expect(result.rows[0]?.allowed).toBe(false);

    }

  );

});

describe("receipt financial execution authority",()=>{

  const decision="Verified funds received independently";

  async function execution(){

    return db.query(

      "SELECT public.neo_mpesa_receipt_execution_guard($1)",

      [request]

    );

  }

  beforeEach(async()=>{

    await db.exec(`

      TRUNCATE public.approval_steps,

               public.approval_actions;

    `);

    await db.query(`

      UPDATE public.approval_requests

      SET status='approved_pending_execution',

          approver_id=$1,

          notes=$2,

          self_approved=false,

          emergency_override=false

      WHERE id=$3

    `,[reviewer,decision,request]);

    await db.query(`

      INSERT INTO public.approval_steps

      VALUES($1,$2,'approved',$3)

    `,[request,org,reviewer]);

    await db.query(`

      INSERT INTO public.approval_actions

      VALUES($1,$2,$3,'approved',$4)

    `,[request,org,reviewer,decision]);

  });

  it("allows matching independent recorded approval",async()=>{

    await expect(execution()).resolves.toBeDefined();

  });

  it("blocks execution by a different authorized reviewer",async()=>{

    await setting("test.actor",id(90));

    await expect(execution()).rejects.toThrow(

      /Independent recorded approval/

    );

  });

  it("blocks execution by the receipt submitter",async()=>{

    await setting("test.actor",requester);

    await expect(execution()).rejects.toThrow(

      /independent approval/

    );

  });

  it("blocks a self-approved execution record",async()=>{

    await db.exec(`

      UPDATE public.approval_requests

      SET self_approved=true

    `);

    await expect(execution()).rejects.toThrow(

      /Independent recorded approval/

    );

  });

  it("blocks emergency override execution",async()=>{

    await db.exec(`

      UPDATE public.approval_requests

      SET emergency_override=true

    `);

    await expect(execution()).rejects.toThrow(

      /Independent recorded approval/

    );

  });

  it("blocks execution without an approved step",async()=>{

    await db.exec(`

      DELETE FROM public.approval_steps

    `);

    await expect(execution()).rejects.toThrow(

      /approval step required/

    );

  });

  it("blocks execution without matching action evidence",async()=>{

    await db.exec(`

      DELETE FROM public.approval_actions

    `);

    await expect(execution()).rejects.toThrow(

      /approval action evidence required/

    );

  });

  it("blocks approval actions belonging to another organization",async()=>{

    await db.exec(`

      UPDATE public.approval_actions

      SET organization_id='${id(99)}'

    `);

    await expect(execution()).rejects.toThrow(

      /approval action evidence required/

    );

  });

  it("blocks mismatched written approval evidence",async()=>{

    await db.exec(`

      UPDATE public.approval_actions

      SET comment='Different decision evidence'

    `);

    await expect(execution()).rejects.toThrow(

      /approval action evidence required/

    );

  });

  it("blocks execution without a sufficient written decision",async()=>{

    await db.exec(`

      UPDATE public.approval_requests

      SET notes='short'

    `);

    await expect(execution()).rejects.toThrow(

      /written receipt approval decision/

    );

  });

  it("blocks premature financial execution",async()=>{

    await db.exec(`

      UPDATE public.approval_requests

      SET status='pending_approval'

    `);

    await expect(execution()).rejects.toThrow(

      /not awaiting financial execution/

    );

  });

  it("permits authorized recovery of failed execution",async()=>{

    await db.exec(`

      UPDATE public.approval_requests

      SET status='execution_failed'

    `);

    await expect(execution()).resolves.toBeDefined();

  });

  it("blocks technical access at financial execution",async()=>{

    await setting("test.scope","technical");

    await expect(execution()).rejects.toThrow(

      /Operational financial access/

    );

  });

  it("does not expose direct execution guard authority",async()=>{

    const result=await db.query<{allowed:boolean}>(`

      SELECT has_function_privilege(

        'authenticated',

        'public.neo_mpesa_receipt_execution_guard(uuid)',

        'EXECUTE'

      ) AS allowed

    `);

    expect(result.rows[0]?.allowed).toBe(false);

  });

});