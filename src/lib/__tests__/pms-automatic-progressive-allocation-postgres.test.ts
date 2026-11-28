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

const org = "00000000-0000-4000-8000-000000001101";
const branch = "00000000-0000-4000-8000-000000001102";
const booking = "00000000-0000-4000-8000-000000001103";

const migration = readFileSync(
  "supabase/migrations/20261126023000_customer_advance_deposit_transactions.sql",
  "utf8"
);

describe("automatic progressive allocation migration", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();

    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      CREATE SCHEMA auth;

      CREATE FUNCTION auth.uid()
      RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('test.actor',true),'')::uuid
      $$;

      CREATE FUNCTION public.current_org_id()
      RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT current_setting('test.org')::uuid
      $$;

      CREATE FUNCTION public.neo_branch_in_scope(uuid)
      RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT $1='${branch}'::uuid
          AND current_setting('test.scope')='on'
      $$;

      CREATE FUNCTION public.neo_system_posting()
      RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT current_setting('neo.system_posting')='on'
      $$;

      CREATE FUNCTION
      public.neo_progressive_deposit_execution_enabled()
      RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT current_setting('test.enabled')='on'
      $$;

      CREATE FUNCTION public.neo_reservation_deposit_policy(
        uuid,uuid,uuid
      )
      RETURNS text LANGUAGE sql STABLE AS $$
        SELECT current_setting('test.policy')
      $$;

      CREATE FUNCTION
      public.neo_progressive_accounting_property_allowed(
        uuid,uuid,date
      )
      RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT $1='${org}'::uuid
          AND $2='${branch}'::uuid
          AND current_setting('test.job')='on'
      $$;

      CREATE TABLE charges (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        operational_date date UNIQUE,
        amount numeric
      );

      CREATE TABLE packages (
        charge_id uuid PRIMARY KEY
      );

      CREATE TABLE allocations (
        charge_id uuid PRIMARY KEY,
        amount numeric
      );

      CREATE FUNCTION public.pkg_allocate_folio_line(
        _line uuid,_source text
      )
      RETURNS jsonb LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO packages VALUES (_line);
        RETURN jsonb_build_object('allocated',1);
      END;
      $$;

      CREATE FUNCTION public.neo_connect_accommodation_deposit(
        _line uuid
      )
      RETURNS jsonb LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('test.reject')='on' THEN
          RAISE EXCEPTION 'Simulated allocation failure';
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM packages WHERE charge_id=_line
        ) THEN
          RAISE EXCEPTION 'Package allocation missing';
        END IF;

        INSERT INTO allocations VALUES (_line,19000);

        RETURN jsonb_build_object(
          'ok',true,'allocated',19000
        );
      END;
      $$;

      CREATE FUNCTION public.neo_pms_post_accommodation_job(
        _service_org uuid,
        _branch uuid,
        _operational_date date
      )
      RETURNS integer
      LANGUAGE plpgsql
      SECURITY DEFINER
      AS $job$
      DECLARE
        _org uuid := _service_org;
        _r record;
        _line uuid;
        _tax numeric := 0;
        _n integer := 0;
      BEGIN
        FOR _r IN
          SELECT
            '${booking}'::uuid AS reservation_id,
            _branch AS branch_id,
            'inclusive'::text AS tax_treatment
        LOOP

          -- neo_scheduled_progressive_boundary_v1

          IF public.neo_reservation_deposit_policy(
            _org,_r.branch_id,_r.reservation_id
          )='progressive-accommodation' THEN
            RAISE EXCEPTION 'Progressive scheduled accounting unavailable';
          END IF;

          IF _r.tax_treatment = 'exclusive' THEN
            _tax := 0;
          END IF;

          IF EXISTS (
            SELECT 1 FROM charges
            WHERE operational_date=_operational_date
          ) THEN
            CONTINUE;
          END IF;

          INSERT INTO charges(operational_date,amount)
          VALUES (_operational_date,19000)
          RETURNING id INTO _line;

          PERFORM public.pkg_allocate_folio_line(_line, 'night-audit');

          _n := _n+1;
        END LOOP;

        RETURN _n;
      END;
      $job$;

      REVOKE ALL ON FUNCTION
      public.neo_pms_post_accommodation_job(uuid,uuid,date)
      FROM PUBLIC,anon,authenticated,service_role;
    `);

    const patch = migration.match(
      /DO \$automatic_progressive_allocation\$[\s\S]*?\$automatic_progressive_allocation\$;/
    )?.[0];

    if (!patch) {
      throw new Error("Automatic allocation migration missing");
    }

    await db.exec(patch);
  },60000);

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE charges,packages,allocations;

      SELECT
        set_config('test.actor','',false),
        set_config('test.org','${org}',false),
        set_config('test.scope','on',false),
        set_config('test.enabled','on',false),
        set_config('test.job','on',false),
        set_config('test.reject','off',false),
        set_config('test.policy','progressive-accommodation',false),
        set_config('neo.system_posting','on',false);
    `);
  });

  afterAll(async () => {
    await db?.close();
  });

  async function execute() {
    const result = await db.query<{ posted: number }>(
      `SELECT public.neo_pms_post_accommodation_job(
        $1,$2,current_date
      ) AS posted`,
      [org,branch]
    );

    return result.rows[0]!.posted;
  }

  async function counts() {
    const result = await db.query<{
      charges: number;
      packages: number;
      allocations: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM charges) AS charges,
        (SELECT count(*)::int FROM packages) AS packages,
        (SELECT count(*)::int FROM allocations) AS allocations
    `);

    return result.rows[0]!;
  }

  async function configure(key: string,value: string) {
    await db.query(
      "SELECT set_config($1,$2,false)",
      [key,value]
    );
  }

  const empty = {
    charges:0,
    packages:0,
    allocations:0
  };

  it("installs the actual automatic allocation migration", async () => {
    const result = await db.query<{ definition: string }>(`
      SELECT pg_get_functiondef(
        'public.neo_pms_post_accommodation_job(uuid,uuid,date)'
        ::regprocedure
      ) AS definition
    `);

    expect(result.rows[0]!.definition).toContain(
      "neo_automatic_progressive_allocation_v1"
    );

    expect(result.rows[0]!.definition).toContain(
      "public.neo_connect_accommodation_deposit("
    );
  });

  it("connects scheduled accommodation to allocation", async () => {
    expect(await execute()).toBe(1);

    expect(await counts()).toEqual({
      charges:1,
      packages:1,
      allocations:1
    });
  });

  it("prevents duplicate allocation in the fixture", async () => {
    expect(await execute()).toBe(1);
    expect(await execute()).toBe(0);

    expect(await counts()).toEqual({
      charges:1,
      packages:1,
      allocations:1
    });
  });

  it("enforces the activation lock", async () => {
    await configure("test.enabled","off");

    await expect(execute()).rejects.toThrow(
      /execution is disabled/i
    );

    expect(await counts()).toEqual(empty);
  });

  it("rejects employee context", async () => {
    await configure("test.actor",booking);

    await expect(execute()).rejects.toThrow(
      /context unavailable/i
    );

    expect(await counts()).toEqual(empty);
  });

  it("requires system posting context", async () => {
    await configure("neo.system_posting","off");

    await expect(execute()).rejects.toThrow(
      /context unavailable/i
    );

    expect(await counts()).toEqual(empty);
  });

  it("requires a verified scheduled job", async () => {
    await configure("test.job","off");

    await expect(execute()).rejects.toThrow(
      /context unavailable/i
    );

    expect(await counts()).toEqual(empty);
  });

  it("rejects unauthorized property scope", async () => {
    await configure("test.scope","off");

    await expect(execute()).rejects.toThrow(
      /context unavailable/i
    );

    expect(await counts()).toEqual(empty);
  });

  it("rejects mismatched organization context", async () => {
    await configure("test.org",booking);

    await expect(execute()).rejects.toThrow(
      /context unavailable/i
    );

    expect(await counts()).toEqual(empty);
  });

  it("rolls back the charge and package if allocation fails", async () => {
    await configure("test.reject","on");

    await expect(execute()).rejects.toThrow(
      /Simulated allocation failure/i
    );

    expect(await counts()).toEqual(empty);
  });

  it("preserves legacy accommodation accounting", async () => {
    await configure("test.policy","legacy-full-application");
    await configure("test.enabled","off");

    expect(await execute()).toBe(1);

    expect(await counts()).toEqual({
      charges:1,
      packages:1,
      allocations:0
    });
  });

  it("preserves restricted execution privileges", async () => {
    const result = await db.query<{ allowed: boolean }>(`
      SELECT has_function_privilege(
        role_name,
        'public.neo_pms_post_accommodation_job(uuid,uuid,date)',
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
