import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it
} from "vitest";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;

const org = id(901);
const branch = id(902);
const otherOrg = id(903);
const otherBranch = id(904);
const actor = id(905);
const run = id(906);

const migration = readFileSync(
  "supabase/migrations/20261126023000_customer_advance_deposit_transactions.sql",
  "utf8"
);

function functionSource(name: string) {
  const pattern = new RegExp(
    `CREATE OR REPLACE FUNCTION\\s+public\\.${name}\\([\\s\\S]*?\\$function\\$;`
  );

  const source = migration.match(pattern)?.[0];

  if (!source) {
    throw new Error(`Missing SQL function: ${name}`);
  }

  return source;
}

describe("actual scheduled accommodation accounting context", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();

    await db.exec(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN;

      CREATE SCHEMA auth;

      CREATE FUNCTION auth.uid()
      RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(
          current_setting('test.actor',true),''
        )::uuid
      $$;

      CREATE FUNCTION public.neo_ctx_tag()
      RETURNS text LANGUAGE sql STABLE AS $$
        SELECT coalesce(auth.uid()::text,'anon')
          || ':' ||
          coalesce(
            nullif(current_setting('neo.system_org',true),''),
            '-'
          )
          || ':' ||
          coalesce(
            nullif(current_setting('neo.ctx.gen',true),''),
            '0'
          )
      $$;

      CREATE FUNCTION public.neo_ctx_read(_key text)
      RETURNS text LANGUAGE plpgsql STABLE AS $$
      DECLARE
        raw text;
        tag text;
      BEGIN
        raw := current_setting('neo.ctx.'||_key,true);

        IF raw IS NULL OR raw='' THEN
          RETURN NULL;
        END IF;

        tag := public.neo_ctx_tag();

        IF left(raw,length(tag)+1)<>tag||'|' THEN
          RETURN NULL;
        END IF;

        RETURN substr(raw,length(tag)+2);
      END;
      $$;

      CREATE FUNCTION public.neo_ctx_write(
        _key text,
        _payload text
      )
      RETURNS void LANGUAGE plpgsql STABLE AS $$
      BEGIN
        PERFORM set_config(
          'neo.ctx.'||_key,
          public.neo_ctx_tag()||'|'||_payload,
          true
        );
      END;
      $$;

      CREATE FUNCTION public.current_org_id()
      RETURNS uuid LANGUAGE plpgsql STABLE AS $$
      DECLARE
        c text;
        v uuid;
      BEGIN
        c := public.neo_ctx_read('org');

        IF c IS NOT NULL THEN
          RETURN CASE
            WHEN c='n' THEN NULL
            ELSE substr(c,2)::uuid
          END;
        END IF;

        v := CASE
          WHEN auth.uid() IS NOT NULL
            THEN '${org}'::uuid
          ELSE nullif(
            current_setting('neo.system_org',true),''
          )::uuid
        END;

        PERFORM public.neo_ctx_write(
          'org',
          CASE WHEN v IS NULL THEN 'n'
            ELSE 'v'||v::text END
        );

        RETURN v;
      END;
      $$;

      CREATE FUNCTION public.current_access_scope()
      RETURNS text LANGUAGE plpgsql STABLE AS $$
      DECLARE
        c text;
        v text;
      BEGIN
        c := public.neo_ctx_read('scope');

        IF c IS NOT NULL THEN
          RETURN substr(c,2);
        END IF;

        v := CASE
          WHEN auth.uid() IS NOT NULL THEN 'branch'
          ELSE 'self'
        END;

        PERFORM public.neo_ctx_write(
          'scope','v'||v
        );

        RETURN v;
      END;
      $$;

      CREATE FUNCTION public.current_branch_ids()
      RETURNS uuid[] LANGUAGE plpgsql STABLE AS $$
      DECLARE
        c text;
        v uuid[];
      BEGIN
        c := public.neo_ctx_read('branches');

        IF c IS NOT NULL THEN
          RETURN substr(c,2)::uuid[];
        END IF;

        v := CASE
          WHEN auth.uid() IS NOT NULL
            THEN ARRAY['${branch}'::uuid]
          ELSE '{}'::uuid[]
        END;

        PERFORM public.neo_ctx_write(
          'branches','v'||v::text
        );

        RETURN v;
      END;
      $$;

      CREATE FUNCTION public.neo_branch_in_scope(uuid)
      RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT CASE
          WHEN public.current_access_scope()
            IN ('organisation','technical')
          THEN true
          ELSE $1 IS NULL
            OR $1=ANY(public.current_branch_ids())
        END
      $$;

      CREATE TABLE public.branches (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL
      );

      CREATE TABLE public.business_days (
        organization_id uuid,
        branch_id uuid,
        business_date date,
        status text
      );

      CREATE TABLE public.neo_pms_accommodation_job_runs (
        id uuid PRIMARY KEY,
        organization_id uuid,
        branch_id uuid,
        business_date date,
        status text
      );

      CREATE TABLE
      public.neo_pms_accommodation_automation_settings (
        organization_id uuid,
        branch_id uuid,
        enabled boolean,
        activation_date date
      );

      CREATE TABLE public.test_execution_evidence (
        organization_id uuid,
        branch_id uuid,
        business_date date,
        actor_id uuid,
        system_posting text,
        resolved_org uuid,
        permitted boolean
      );

      CREATE TABLE public.test_controls (
        reject_posting boolean
      );

      CREATE TABLE public.test_finance_scope_evidence (
        organization_id uuid,
        branch_id uuid,
        scope text,
        authorized_branches uuid[],
        own_property_allowed boolean,
        other_property_allowed boolean
      );

      INSERT INTO public.test_controls VALUES(false);

      CREATE FUNCTION public.neo_pms_post_accommodation_job(
        _org uuid,
        _branch uuid,
        _date date
      )
      RETURNS integer LANGUAGE plpgsql AS $$
      BEGIN

        INSERT INTO public.test_finance_scope_evidence
        VALUES (
          public.current_org_id(),
          _branch,
          public.current_access_scope(),
          public.current_branch_ids(),
          public.neo_branch_in_scope(_branch),
          public.neo_branch_in_scope(
            '${otherBranch}'::uuid
          )
        );

        IF public.current_org_id()
           IS DISTINCT FROM _org

           OR public.neo_branch_in_scope(_branch)
              IS NOT TRUE
        THEN
          RAISE EXCEPTION
            'Simulated Finance property authorization failed';
        END IF;

        INSERT INTO public.test_execution_evidence
        VALUES (
          _org,
          _branch,
          _date,
          auth.uid(),
          current_setting('neo.system_posting',true),
          public.current_org_id(),
          public.neo_progressive_accounting_property_allowed(
            _org,_branch,_date
          )
        );

        IF (
          SELECT reject_posting
          FROM public.test_controls
        ) THEN
          RAISE EXCEPTION 'Simulated posting failure';
        END IF;

        RETURN 1;
      END;
      $$;
    `);

    await db.exec(functionSource(
      "neo_progressive_accounting_property_allowed"
    ));

    await db.exec(functionSource(
      "neo_run_accommodation_accounting_context"
    ));

    const start = migration.indexOf(
      "-- NEO_PROGRESSIVE_SCHEDULED_ACCOUNTING_V1"
    );

    if (start < 0) {
      throw new Error("Scheduled migration section missing");
    }

    const sql = migration.slice(start);

    const revocations = sql.match(
      /REVOKE ALL ON FUNCTION\s+public\.neo_(?:progressive_accounting_property_allowed|run_accommodation_accounting_context)\([^;]+;/g
    );

    if (revocations?.length !== 2) {
      throw new Error("Scheduled context privilege guards missing");
    }

    for (const statement of revocations) {
      await db.exec(statement);
    }

    // Install a controlled scheduler entry point so the
    // actual migration connection can be executed.

    await db.exec(`
      CREATE FUNCTION
      public.neo_pms_post_accommodation_scheduled(
        _execute boolean DEFAULT false
      )
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY DEFINER
      AS $scheduler$
      DECLARE
        job record;
        posted integer;
      BEGIN

        IF _execute IS NOT TRUE THEN
          RETURN jsonb_build_object(
            'status','dry_run',
            'posted',0
          );
        END IF;

        SELECT *
        INTO job
        FROM public.neo_pms_accommodation_job_runs
        WHERE id=nullif(
          current_setting(
            'neo.pms_accommodation_job_run_id',
            true
          ),''
        )::uuid;

        IF job.id IS NULL THEN
          RAISE EXCEPTION 'Missing scheduler job';
        END IF;

        posted :=
          public.neo_pms_post_accommodation_job(
            job.organization_id,
            job.branch_id,
            job.business_date
          );

        RETURN jsonb_build_object(
          'status','completed',
          'posted',posted
        );

      END;
      $scheduler$;

      REVOKE ALL ON FUNCTION
      public.neo_pms_post_accommodation_scheduled(boolean)
      FROM PUBLIC,anon,authenticated,service_role;
    `);

    const schedulerConnection = migration.match(
      /DO \$scheduled_accounting_context\$[\s\S]*?\$scheduled_accounting_context\$;/
    )?.[0];

    if (!schedulerConnection) {
      throw new Error(
        "Actual scheduler connection migration missing"
      );
    }

    await db.exec(schedulerConnection);
  },60000);

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE
        public.test_finance_scope_evidence,
        public.test_execution_evidence,
        public.neo_pms_accommodation_job_runs,
        public.neo_pms_accommodation_automation_settings,
        public.business_days,
        public.branches;

      UPDATE public.test_controls
      SET reject_posting=false;

      SELECT
        set_config('test.actor','',false),
        set_config('neo.system_org','',false),
        set_config('neo.system_posting','off',false),
        set_config('neo.ctx.gen','baseline',false),
        set_config('neo.ctx.org','',false),
        set_config('neo.ctx.scope','',false),
        set_config('neo.ctx.branches','',false),
        set_config(
          'neo.pms_accommodation_job_run_id',
          '${run}',
          false
        );

      INSERT INTO public.branches VALUES
        ('${branch}','${org}'),
        ('${otherBranch}','${otherOrg}');

      INSERT INTO public.business_days VALUES
        (
          '${org}','${branch}',
          (now() AT TIME ZONE 'Africa/Nairobi')::date,
          'open'
        ),
        (
          '${otherOrg}','${otherBranch}',
          (now() AT TIME ZONE 'Africa/Nairobi')::date,
          'open'
        );

      INSERT INTO
      public.neo_pms_accommodation_automation_settings
      VALUES
        (
          '${org}','${branch}',true,
          (now() AT TIME ZONE 'Africa/Nairobi')::date-1
        ),
        (
          '${otherOrg}','${otherBranch}',true,
          (now() AT TIME ZONE 'Africa/Nairobi')::date-1
        );

      INSERT INTO public.neo_pms_accommodation_job_runs
      VALUES (
        '${run}','${org}','${branch}',
        (now() AT TIME ZONE 'Africa/Nairobi')::date,
        'running'
      );
    `);
  });

  afterAll(async () => {
    await db?.close();
  });

  async function execute(
    organization = org,
    property = branch
  ) {
    const result = await db.query<{ posted: number }>(
      `SELECT public.neo_run_accommodation_accounting_context(
        $1,$2,
        (now() AT TIME ZONE 'Africa/Nairobi')::date
      ) AS posted`,
      [organization,property]
    );

    return result.rows[0]!.posted;
  }

  async function evidenceCount() {
    const result = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM public.test_execution_evidence`
    );

    return result.rows[0]!.n;
  }

  it("executes an authorized property job without an employee", async () => {
    expect(await execute()).toBe(1);

    const result = await db.query<{
      organization_id: string;
      branch_id: string;
      actor_id: string | null;
      system_posting: string;
      resolved_org: string;
      permitted: boolean;
    }>(`
      SELECT * FROM public.test_execution_evidence
    `);

    expect(result.rows[0]).toMatchObject({
      organization_id:org,
      branch_id:branch,
      actor_id:null,
      system_posting:"on",
      resolved_org:org,
      permitted:true
    });
  });

  it("rejects execution against another organization's property", async () => {
    await expect(
      execute(otherOrg,otherBranch)
    ).rejects.toThrow(/could not be verified/i);

    expect(await evidenceCount()).toBe(0);
  });

  it("rejects mismatched organization and property", async () => {
    await expect(
      execute(org,otherBranch)
    ).rejects.toThrow(/could not be verified/i);

    expect(await evidenceCount()).toBe(0);
  });

  it("rejects execution without an active job identifier", async () => {
    await db.exec(`
      SELECT set_config(
        'neo.pms_accommodation_job_run_id','',false
      )
    `);

    await expect(execute()).rejects.toThrow(
      /could not be verified/i
    );
  });

  it("rejects malformed job identifiers", async () => {
    await db.exec(`
      SELECT set_config(
        'neo.pms_accommodation_job_run_id',
        'invalid-run',
        false
      )
    `);

    await expect(execute()).rejects.toThrow(
      /could not be verified/i
    );
  });

  it("rejects completed job identifiers", async () => {
    await db.exec(`
      UPDATE public.neo_pms_accommodation_job_runs
      SET status='completed'
    `);

    await expect(execute()).rejects.toThrow(
      /could not be verified/i
    );
  });

  it("rejects properties with disabled automation", async () => {
    await db.exec(`
      UPDATE
        public.neo_pms_accommodation_automation_settings
      SET enabled=false
    `);

    await expect(execute()).rejects.toThrow(
      /could not be verified/i
    );
  });

  it("rejects closed business days", async () => {
    await db.exec(`
      UPDATE public.business_days
      SET status='closed'
    `);

    await expect(execute()).rejects.toThrow(
      /could not be verified/i
    );
  });

  it("rejects service execution from employee context", async () => {
    await db.query(
      `SELECT set_config('test.actor',$1,false)`,
      [actor]
    );

    await expect(execute()).rejects.toThrow(
      /service execution context/i
    );
  });

  it("preserves normal authenticated property scope", async () => {
    await db.query(
      `SELECT set_config('test.actor',$1,false)`,
      [actor]
    );

    const result = await db.query<{
      allowed: boolean;
      denied: boolean;
    }>(
      `SELECT
        public.neo_progressive_accounting_property_allowed(
          $1,$2,current_date
        ) AS allowed,
        public.neo_progressive_accounting_property_allowed(
          $1,$3,current_date
        ) AS denied`,
      [org,branch,otherBranch]
    );

    expect(result.rows[0]).toEqual({
      allowed:true,
      denied:false
    });
  });

  it("restores context inside the same transaction after success", async () => {
    await db.exec("BEGIN");

    try {
      await db.exec(`
        SELECT
          set_config('neo.system_org','${otherOrg}',true),
          set_config('neo.ctx.gen','original-generation',true),
          set_config('neo.system_posting','off',true),
          set_config('neo.ctx.scope','saved-scope',true),
          set_config('neo.ctx.branches','saved-branches',true);

        SELECT public.current_org_id();
      `);

      expect(await execute()).toBe(1);

      const state = await db.query<{
        organization: string;
        resolved: string;
        generation: string;
        posting: string;
        scope: string;
        branches: string;
      }>(`
        SELECT
          current_setting('neo.system_org') AS organization,
          public.current_org_id() AS resolved,
          current_setting('neo.ctx.gen') AS generation,
          current_setting('neo.system_posting') AS posting,
          current_setting('neo.ctx.scope') AS scope,
          current_setting('neo.ctx.branches') AS branches
      `);

      expect(state.rows[0]).toEqual({
        organization:otherOrg,
        resolved:otherOrg,
        generation:"original-generation",
        posting:"off",
        scope:"saved-scope",
        branches:"saved-branches"
      });
    } finally {
      await db.exec("ROLLBACK");
    }
  });

  it("rolls back partial execution and restores context on failure", async () => {
    await db.exec(`
      UPDATE public.test_controls
      SET reject_posting=true;
    `);

    await db.exec("BEGIN");

    try {
      await db.exec(`
        SELECT
          set_config('neo.system_org','${otherOrg}',true),
          set_config('neo.ctx.gen','before-failure',true),
          set_config('neo.system_posting','off',true);

        DO $test$
        BEGIN
          BEGIN
            PERFORM public.neo_run_accommodation_accounting_context(
              '${org}',
              '${branch}',
              (now() AT TIME ZONE 'Africa/Nairobi')::date
            );

            RAISE EXCEPTION 'Expected failure did not occur';

          EXCEPTION WHEN OTHERS THEN
            IF SQLERRM <> 'Simulated posting failure' THEN
              RAISE;
            END IF;
          END;
        END;
        $test$;
      `);

      expect(await evidenceCount()).toBe(0);

      const state = await db.query<{
        organization: string;
        generation: string;
        posting: string;
      }>(`
        SELECT
          current_setting('neo.system_org') AS organization,
          current_setting('neo.ctx.gen') AS generation,
          current_setting('neo.system_posting') AS posting
      `);

      expect(state.rows[0]).toEqual({
        organization:otherOrg,
        generation:"before-failure",
        posting:"off"
      });
    } finally {
      await db.exec("ROLLBACK");
    }
  });

  it("authorizes Finance only within the active scheduled property", async () => {
    expect(await execute()).toBe(1);

    const result = await db.query<{
      organization_id: string;
      branch_id: string;
      scope: string;
      authorized_branches: string[];
      own_property_allowed: boolean;
      other_property_allowed: boolean;
    }>(`
      SELECT *
      FROM public.test_finance_scope_evidence
    `);

    expect(result.rows[0]).toEqual({
      organization_id:org,
      branch_id:branch,
      scope:"branch",
      authorized_branches:[branch],
      own_property_allowed:true,
      other_property_allowed:false
    });
  });

  it("does not retain scheduled property authorization after execution", async () => {
    await db.exec("BEGIN");

    try {
      expect(await execute()).toBe(1);

      const result = await db.query<{
        scope: string;
        branches: string[];
        authorized: boolean;
      }>(`
        SELECT
          public.current_access_scope() AS scope,
          public.current_branch_ids() AS branches,
          public.neo_branch_in_scope(
            '${branch}'::uuid
          ) AS authorized
      `);

      expect(result.rows[0]).toEqual({
        scope:"self",
        branches:[],
        authorized:false
      });
    } finally {
      await db.exec("ROLLBACK");
    }
  });

  it("does not retain temporary Finance authorization after failure", async () => {
    await db.exec(`
      UPDATE public.test_controls
      SET reject_posting=true
    `);

    await db.exec("BEGIN");

    try {
      await db.exec(`
        DO $test$
        BEGIN
          BEGIN
            PERFORM public.neo_run_accommodation_accounting_context(
              '${org}',
              '${branch}',
              (now() AT TIME ZONE 'Africa/Nairobi')::date
            );

            RAISE EXCEPTION 'Expected posting failure';

          EXCEPTION WHEN OTHERS THEN
            IF SQLERRM <> 'Simulated posting failure' THEN
              RAISE;
            END IF;
          END;
        END;
        $test$;
      `);

      const result = await db.query<{
        scope: string;
        branches: string[];
        authorized: boolean;
        evidence: number;
      }>(`
        SELECT
          public.current_access_scope() AS scope,
          public.current_branch_ids() AS branches,
          public.neo_branch_in_scope(
            '${branch}'::uuid
          ) AS authorized,
          (
            SELECT count(*)::integer
            FROM public.test_finance_scope_evidence
          ) AS evidence
      `);

      expect(result.rows[0]).toEqual({
        scope:"self",
        branches:[],
        authorized:false,
        evidence:0
      });
    } finally {
      await db.exec("ROLLBACK");
    }
  });

  async function actualSchedulerConnection(
    executeJob = true
  ) {
    const result = await db.query<{
      result: {
        status: string;
        posted: number;
      };
    }>(
      `SELECT
        public.neo_pms_post_accommodation_scheduled($1)
        AS result`,
      [executeJob]
    );

    return result.rows[0]!.result;
  }

  it("installs the actual scheduler context connection", async () => {
    const result = await db.query<{
      definition: string;
    }>(`
      SELECT pg_get_functiondef(
        'public.neo_pms_post_accommodation_scheduled(boolean)'
        ::regprocedure
      ) AS definition
    `);

    expect(
      result.rows[0]!.definition
    ).toContain(
      "public.neo_run_accommodation_accounting_context("
    );

    expect(
      result.rows[0]!.definition
    ).not.toContain(
      "public.neo_pms_post_accommodation_job("
    );
  });

  it("executes through the connected scheduler entry point", async () => {
    expect(
      await actualSchedulerConnection()
    ).toEqual({
      status:"completed",
      posted:1
    });

    expect(await evidenceCount()).toBe(1);
  });

  it("preserves the scheduler dry-run boundary", async () => {
    expect(
      await actualSchedulerConnection(false)
    ).toEqual({
      status:"dry_run",
      posted:0
    });

    expect(await evidenceCount()).toBe(0);
  });

  it("rejects employee execution through the connected scheduler", async () => {
    await db.query(
      `SELECT set_config('test.actor',$1,false)`,
      [actor]
    );

    await expect(
      actualSchedulerConnection()
    ).rejects.toThrow(
      /service execution context/i
    );

    expect(await evidenceCount()).toBe(0);
  });

  it("does not execute a closed property business day through the scheduler", async () => {
    await db.exec(`
      UPDATE public.business_days
      SET status='closed'
    `);

    await expect(
      actualSchedulerConnection()
    ).rejects.toThrow(
      /could not be verified/i
    );

    expect(await evidenceCount()).toBe(0);
  });

  it("rolls back a failed connected scheduler transaction", async () => {
    await db.exec(`
      UPDATE public.test_controls
      SET reject_posting=true
    `);

    await expect(
      actualSchedulerConnection()
    ).rejects.toThrow(
      /Simulated posting failure/i
    );

    expect(await evidenceCount()).toBe(0);

    const result = await db.query<{
      count: number;
    }>(`
      SELECT count(*)::integer AS count
      FROM public.test_finance_scope_evidence
    `);

    expect(result.rows[0]!.count).toBe(0);
  });

  it("retains scheduler execution privilege restrictions after migration", async () => {
    const result = await db.query<{
      allowed: boolean;
    }>(`
      SELECT has_function_privilege(
        role_name,
        'public.neo_pms_post_accommodation_scheduled(boolean)',
        'EXECUTE'
      ) AS allowed
      FROM unnest(
        ARRAY['anon','authenticated','service_role']
      ) AS roles(role_name)
    `);

    expect(result.rows).toHaveLength(3);

    expect(
      result.rows.every(row => row.allowed===false)
    ).toBe(true);
  });

  it("does not grant execution to employee or API service roles", async () => {
    const result = await db.query<{
      role_name: string;
      allowed: boolean;
    }>(`
      SELECT role_name,
        has_function_privilege(
          role_name,
          'public.neo_run_accommodation_accounting_context(uuid,uuid,date)',
          'EXECUTE'
        ) AS allowed
      FROM unnest(
        ARRAY['anon','authenticated','service_role']
      ) AS roles(role_name)
    `);

    expect(result.rows).toHaveLength(3);

    expect(
      result.rows.every(row => row.allowed===false)
    ).toBe(true);
  });
});
