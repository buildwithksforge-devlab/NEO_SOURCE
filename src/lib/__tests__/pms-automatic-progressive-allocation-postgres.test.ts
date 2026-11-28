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

      CREATE TABLE public.folio_lines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        branch_id uuid NOT NULL,
        reservation_id uuid NOT NULL,
        operational_date date NOT NULL,
        category text NOT NULL,
        line_type text NOT NULL,
        status text DEFAULT 'posted'
      );

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
            19000::numeric AS nightly_rate,
            0::numeric AS tax_rate,
            0::numeric AS service_charge_rate,
            'inclusive'::text AS tax_treatment
        LOOP

    IF _r.tax_treatment = 'exclusive' THEN
            _tax := 0;
          END IF;

          IF EXISTS (
            SELECT 1 FROM charges
            WHERE operational_date=_operational_date
          ) THEN
            CONTINUE;
          END IF;

          BEGIN
          INSERT INTO charges(operational_date,amount)
          VALUES (_operational_date,19000)
          RETURNING id INTO _line;

          PERFORM public.pkg_allocate_folio_line(_line, 'night-audit');

          INSERT INTO public.folio_lines (
            id,
            organization_id,
            branch_id,
            reservation_id,
            operational_date,
            category,
            line_type,
            status
          )
          VALUES (
            _line,
            _org,
            _r.branch_id,
            _r.reservation_id,
            _operational_date,
            'accommodation',
            'charge',
            'posted'
          );

          _n := _n + 1;
    EXCEPTION WHEN unique_violation THEN
      NULL;
          END;
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


    // AUTOMATIC_FIXTURE_INTEGRITY_V3

    const actualRollout = readFileSync(
      "supabase/migrations/20261126023000_customer_advance_deposit_transactions.sql",
      "utf8"
    );

    function actualMigrationBlock(name: string) {
      const tag = "$" + name + "$";

      const start = actualRollout.indexOf(
        "DO " + tag
      );

      const end = actualRollout.indexOf(
        tag + ";",
        start + ("DO " + tag).length
      );

      if (start < 0 || end < 0) {
        throw new Error(
          "Missing migration: " + name
        );
      }

      return actualRollout.slice(
        start,
        end + tag.length + 1
      );
    }

    const scopedSQL = Buffer.from(
      "Q1JFQVRFIE9SIFJFUExBQ0UgRlVOQ1RJT04gcHVibGljLnBtc19wb3N0X2FjY29tbW9kYXRpb25fc2NvcGVkKF9icmFuY2ggdXVpZCwgX29wZXJhdGlvbmFsX2RhdGUgZGF0ZSBERUZBVUxUIENVUlJFTlRfREFURSkKIFJFVFVSTlMgaW50ZWdlcgogTEFOR1VBR0UgcGxwZ3NxbAogU0VDVVJJVFkgREVGSU5FUgogU0VUIHNlYXJjaF9wYXRoIFRPICdwdWJsaWMnCkFTICRmdW5jdGlvbiQKREVDTEFSRSBfb3JnIHV1aWQgOj0gcHVibGljLmN1cnJlbnRfb3JnX2lkKCk7IF9yIHJlY29yZDsgX24gaW50ZWdlciA6PSAwOyBfdGF4IG51bWVyaWM7IF9zdmMgbnVtZXJpYzsgX2xpbmUgdXVpZDsKQkVHSU4KICAKICBJRiBhdXRoLnVpZCgpIElTIE5VTEwgT1IgX29yZyBJUyBOVUxMIFRIRU4KICAgIFJBSVNFIEVYQ0VQVElPTiAnQXV0aGVudGljYXRlZCB3b3Jrc3BhY2UgcmVxdWlyZWQnCiAgICAgIFVTSU5HIEVSUkNPREU9JzQyNTAxJzsKICBFTkQgSUY7CgogIElGIF9icmFuY2ggSVMgTlVMTCBPUiBfb3BlcmF0aW9uYWxfZGF0ZSBJUyBOVUxMIFRIRU4KICAgIFJBSVNFIEVYQ0VQVElPTiAnUHJvcGVydHkgYW5kIG9wZXJhdGlvbmFsIGRhdGUgYXJlIHJlcXVpcmVkJzsKICBFTkQgSUY7CgogIElGIHB1YmxpYy5oYXNfcGVybWlzc2lvbigKICAgICAgJ3BtcycsJ2ZvbGlvcy5wb3N0X2NoYXJnZScKICApIElTIE5PVCBUUlVFIFRIRU4KICAgIFJBSVNFIEVYQ0VQVElPTiAnTm90IHBlcm1pdHRlZCB0byBwb3N0IGFjY29tbW9kYXRpb24nCiAgICAgIFVTSU5HIEVSUkNPREU9JzQyNTAxJzsKICBFTkQgSUY7CgogIElGIE5PVCBFWElTVFMgKAogICAgU0VMRUNUIDEKICAgIEZST00gcHVibGljLmJyYW5jaGVzIGIKICAgIFdIRVJFIGIuaWQ9X2JyYW5jaAogICAgICBBTkQgYi5vcmdhbml6YXRpb25faWQ9X29yZwogICkgVEhFTgogICAgUkFJU0UgRVhDRVBUSU9OICdVbmtub3duIHByb3BlcnR5JwogICAgICBVU0lORyBFUlJDT0RFPSc0MjUwMSc7CiAgRU5EIElGOwoKICBJRiBwdWJsaWMubmVvX2JyYW5jaF9pbl9zY29wZShfYnJhbmNoKSBJUyBOT1QgVFJVRQogICAgIEFORCBwdWJsaWMuaXNfb3JnX2FkbWluKCkgSVMgTk9UIFRSVUUgVEhFTgogICAgUkFJU0UgRVhDRVBUSU9OICdQcm9wZXJ0eSBvdXRzaWRlIHBlcm1pdHRlZCBzY29wZScKICAgICAgVVNJTkcgRVJSQ09ERT0nNDI1MDEnOwogIEVORCBJRjsKCiAgLS0gS2VueWEtbG9jYWwgY2FsZW5kYXIgZ3VhcmQuIFZlcmlmeSBwcm9wZXJ0eSB0aW1lem9uZSBwb2xpY3kKICAtLSBiZWZvcmUgZW5hYmxpbmcgdGhpcyBvcGVyYXRpb24gZm9yIG90aGVyIHRpbWV6b25lcy4KICBJRiBfb3BlcmF0aW9uYWxfZGF0ZSA+CiAgICAgKG5vdygpIEFUIFRJTUUgWk9ORSAnQWZyaWNhL05haXJvYmknKTo6ZGF0ZSBUSEVOCiAgICBSQUlTRSBFWENFUFRJT04gJ0Z1dHVyZSBhY2NvbW1vZGF0aW9uIHBvc3RpbmcgaXMgcHJvaGliaXRlZCc7CiAgRU5EIElGOwoKICAtLSBUaGUgcmVxdWVzdGVkIGRhdGUgbXVzdCBiZSB0aGUgcHJvcGVydHkncyBvcGVuIGJ1c2luZXNzIGRheS4KICBJRiBOT1QgRVhJU1RTICgKICAgIFNFTEVDVCAxCiAgICBGUk9NIHB1YmxpYy5idXNpbmVzc19kYXlzIGJkCiAgICBXSEVSRSBiZC5vcmdhbml6YXRpb25faWQ9X29yZwogICAgICBBTkQgYmQuYnJhbmNoX2lkPV9icmFuY2gKICAgICAgQU5EIGJkLmJ1c2luZXNzX2RhdGU9X29wZXJhdGlvbmFsX2RhdGUKICAgICAgQU5EIGJkLnN0YXR1cz0nb3BlbicKICApIFRIRU4KICAgIFJBSVNFIEVYQ0VQVElPTgogICAgICAnQWNjb21tb2RhdGlvbiBwb3N0aW5nIHJlcXVpcmVzIHRoZSBvcGVuIHByb3BlcnR5IGJ1c2luZXNzIGRheSc7CiAgRU5EIElGOwoKICAtLSBDb29yZGluYXRlIHdpdGggbmVvX2Nsb3NlX2J1c2luZXNzX2RheSBhbmQgbmVvX29wZW5fYnVzaW5lc3NfZGF5LgogIC0tIEFjcXVpcmUgdGhlIHNoYXJlZCBidXNpbmVzcy1kYXkgbG9jayBiZWZvcmUgdGhlIGFjY29tbW9kYXRpb24gbG9jay4KICBQRVJGT1JNIHBnX2Fkdmlzb3J5X3hhY3RfbG9jaygKICAgIGhhc2h0ZXh0ZXh0ZW5kZWQoCiAgICAgICdidXNpbmVzcy1kYXk6JyB8fCBfb3JnOjp0ZXh0IHx8ICc6JyB8fCBfYnJhbmNoOjp0ZXh0LAogICAgICAwCiAgICApCiAgKTsKCiAgLS0gU2VyaWFsaXplIGFsbCByZXF1ZXN0cyBmb3IgdGhlIHNhbWUgcHJvcGVydHkgYW5kIG5pZ2h0LgogIFBFUkZPUk0gcGdfYWR2aXNvcnlfeGFjdF9sb2NrKAogICAgaGFzaHRleHRleHRlbmRlZCgKICAgICAgX29yZzo6dGV4dCB8fCAnOmFjY29tbW9kYXRpb246JyB8fAogICAgICBfYnJhbmNoOjp0ZXh0IHx8ICc6JyB8fAogICAgICBfb3BlcmF0aW9uYWxfZGF0ZTo6dGV4dCwKICAgICAgMAogICAgKQogICk7CgogIC0tIFJlY2hlY2sgdW5kZXIgc2VyaWFsaXphdGlvbi4KICBJRiBOT1QgRVhJU1RTICgKICAgIFNFTEVDVCAxCiAgICBGUk9NIHB1YmxpYy5idXNpbmVzc19kYXlzIGJkCiAgICBXSEVSRSBiZC5vcmdhbml6YXRpb25faWQ9X29yZwogICAgICBBTkQgYmQuYnJhbmNoX2lkPV9icmFuY2gKICAgICAgQU5EIGJkLmJ1c2luZXNzX2RhdGU9X29wZXJhdGlvbmFsX2RhdGUKICAgICAgQU5EIGJkLnN0YXR1cz0nb3BlbicKICAgIEZPUiBVUERBVEUKICApIFRIRU4KICAgIFJBSVNFIEVYQ0VQVElPTiAnQnVzaW5lc3MgZGF5IGNoYW5nZWQgZHVyaW5nIHBvc3RpbmcnOwogIEVORCBJRjsKCiAgSUYgTk9UIHB1YmxpYy5oYXNfcGVybWlzc2lvbigncG1zJywnZm9saW9zLnBvc3RfY2hhcmdlJykgVEhFTiBSQUlTRSBFWENFUFRJT04gJ05vdCBwZXJtaXR0ZWQgdG8gcG9zdCBjaGFyZ2VzJzsgRU5EIElGOwogIEZPUiBfciBJTgogICAgU0VMRUNUIHMuaWQgQVMgc3RheV9pZCwgcy5yZXNlcnZhdGlvbl9pZCwgZi5pZCBBUyBmb2xpb19pZCwgZi5icmFuY2hfaWQsIHJlcy5uaWdodGx5X3JhdGUsCiAgICAgICAgICAgQ09BTEVTQ0UocnAudGF4X3JhdGUsMCkgQVMgdGF4X3JhdGUsCiAgICAgICAgICAgIENPQUxFU0NFKHJwLnNlcnZpY2VfY2hhcmdlX3JhdGUsMCkgQVMgc2VydmljZV9jaGFyZ2VfcmF0ZSwKICAgICAgICAgICAgQ09BTEVTQ0UocnAudGF4X3RyZWF0bWVudCwnZXhjbHVzaXZlJykgQVMgdGF4X3RyZWF0bWVudCwKICAgICAgICAgICAgcm0ucm9vbV9udW1iZXIKICAgIEZST00gcHVibGljLnN0YXlzIHMKICAgIEpPSU4gcHVibGljLnJlc2VydmF0aW9ucyByZXMKICAgICAgICBPTiByZXMuaWQgPSBzLnJlc2VydmF0aW9uX2lkCiAgICAgICBBTkQgcmVzLm9yZ2FuaXphdGlvbl9pZCA9IHMub3JnYW5pemF0aW9uX2lkCiAgICAgICBBTkQgcmVzLmJyYW5jaF9pZCA9IHMuYnJhbmNoX2lkCiAgICBKT0lOIHB1YmxpYy5mb2xpb3MgZgogICAgICAgIE9OIGYuc3RheV9pZCA9IHMuaWQKICAgICAgIEFORCBmLm9yZ2FuaXphdGlvbl9pZCA9IHMub3JnYW5pemF0aW9uX2lkCiAgICAgICBBTkQgZi5icmFuY2hfaWQgPSBzLmJyYW5jaF9pZAogICAgICAgQU5EIGYucmVzZXJ2YXRpb25faWQgPSByZXMuaWQKICAgICAgIEFORCBmLmZvbGlvX3R5cGU9J2d1ZXN0JwogICAgICAgQU5EIGYuc3RhdHVzPSdvcGVuJwogICAgTEVGVCBKT0lOIHB1YmxpYy5yYXRlX3BsYW5zIHJwCiAgICAgICAgT04gcnAuaWQgPSByZXMucmF0ZV9wbGFuX2lkCiAgICAgICBBTkQgcnAub3JnYW5pemF0aW9uX2lkID0gcy5vcmdhbml6YXRpb25faWQKICAgICAgIEFORCAocnAuYnJhbmNoX2lkIElTIE5VTEwgT1IgcnAuYnJhbmNoX2lkID0gcy5icmFuY2hfaWQpCiAgICBKT0lOIHB1YmxpYy5yb29tcyBybQogICAgICAgIE9OIHJtLmlkID0gcy5yb29tX2lkCiAgICAgICBBTkQgcm0ub3JnYW5pemF0aW9uX2lkID0gcy5vcmdhbml6YXRpb25faWQKICAgICAgIEFORCBybS5icmFuY2hfaWQgPSBzLmJyYW5jaF9pZAogICAgV0hFUkUgcy5vcmdhbml6YXRpb25faWQ9X29yZyBBTkQgcy5icmFuY2hfaWQ9X2JyYW5jaAogICAgICAgIEFORCBzLnN0YXR1cz0naW4taG91c2UnCiAgICAgICAgQU5EIChyZXMucmF0ZV9wbGFuX2lkIElTIE5VTEwgT1IgcnAuaWQgSVMgTk9UIE5VTEwpCiAgICAgIEFORCBfb3BlcmF0aW9uYWxfZGF0ZSA+PSByZXMuYXJyaXZhbF9kYXRlIEFORCBfb3BlcmF0aW9uYWxfZGF0ZSA8IHJlcy5kZXBhcnR1cmVfZGF0ZQogIExPT1AKICAgIElGIF9yLnRheF90cmVhdG1lbnQgPSAnZXhjbHVzaXZlJyBUSEVOCiAgICAgIF9zdmMgOj0gcm91bmQoX3IubmlnaHRseV9yYXRlICogX3Iuc2VydmljZV9jaGFyZ2VfcmF0ZSAvIDEwMC4wLCAyKTsKICAgICAgX3RheCA6PSByb3VuZCgoX3IubmlnaHRseV9yYXRlICsgX3N2YykgKiBfci50YXhfcmF0ZSAvIDEwMC4wLCAyKTsKICAgIEVMU0UKICAgICAgX3N2YyA6PSAwOwogICAgICBfdGF4IDo9IDA7CiAgICBFTkQgSUY7CiAgICBCRUdJTgogICAgICBJTlNFUlQgSU5UTyBwdWJsaWMuZm9saW9fbGluZXMgKG9yZ2FuaXphdGlvbl9pZCwgYnJhbmNoX2lkLCBmb2xpb19pZCwgcmVzZXJ2YXRpb25faWQsIGxpbmVfdHlwZSwKICAgICAgICBjYXRlZ29yeSwgc291cmNlX21vZHVsZSwgZGVzY3JpcHRpb24sIG9wZXJhdGlvbmFsX2RhdGUsIHF1YW50aXR5LCB1bml0X3ByaWNlLAogICAgICAgIGdyb3NzX2Ftb3VudCwgdGF4X2Ftb3VudCwgc2VydmljZV9jaGFyZ2VfYW1vdW50LCBuZXRfYW1vdW50LCBwb3N0ZWRfYnkpCiAgICAgIFZBTFVFUyAoX29yZywgX3IuYnJhbmNoX2lkLCBfci5mb2xpb19pZCwgX3IucmVzZXJ2YXRpb25faWQsICdjaGFyZ2UnLCAnYWNjb21tb2RhdGlvbicsICdwbXMnLAogICAgICAgICdBY2NvbW1vZGF0aW9uIOKAlCByb29tICcgfHwgQ09BTEVTQ0UoX3Iucm9vbV9udW1iZXIsJycpIHx8ICcgwrcgJyB8fCBfb3BlcmF0aW9uYWxfZGF0ZTo6dGV4dCwKICAgICAgICBfb3BlcmF0aW9uYWxfZGF0ZSwgMSwgX3IubmlnaHRseV9yYXRlLCBfci5uaWdodGx5X3JhdGUsIF90YXgsIF9zdmMsCiAgICAgICAgX3IubmlnaHRseV9yYXRlICsgX3RheCArIF9zdmMsIGF1dGgudWlkKCkpCiAgICAgIFJFVFVSTklORyBpZCBJTlRPIF9saW5lOwogICAgICBVUERBVEUgcHVibGljLmZvbGlvcyBTRVQgdG90YWxfY2hhcmdlcyA9IHRvdGFsX2NoYXJnZXMgKyBfci5uaWdodGx5X3JhdGUsCiAgICAgICAgdG90YWxfdGF4ZXMgPSB0b3RhbF90YXhlcyArIF90YXgsCiAgICAgICAgYmFsYW5jZSA9IGJhbGFuY2UgKyBfci5uaWdodGx5X3JhdGUgKyBfdGF4ICsgX3N2YywKICAgICAgICB1cGRhdGVkX2F0PW5vdygpCiAgICAgIFdIRVJFIGlkPV9yLmZvbGlvX2lkOwogICAgICBQRVJGT1JNIHB1YmxpYy5wa2dfYWxsb2NhdGVfZm9saW9fbGluZShfbGluZSwgJ25pZ2h0LWF1ZGl0Jyk7CiAgICAgIF9uIDo9IF9uICsgMTsKICAgIEVYQ0VQVElPTiBXSEVOIHVuaXF1ZV92aW9sYXRpb24gVEhFTgogICAgICBOVUxMOwogICAgRU5EOwogIEVORCBMT09QOwogIFJFVFVSTiBfbjsKRU5EOyAkZnVuY3Rpb24kOwo=",
      "base64"
    ).toString("utf8");

    await db.exec(scopedSQL);

    // Install inside a rollback-protected transaction
    // to verify rejection when integrity is absent.

    await db.exec("BEGIN");

    try {

      await db.exec(
        actualMigrationBlock(
          "scheduled_progressive_boundary"
        )
      );

      await expect(
        db.exec(patch)
      ).rejects.toThrow(
        /requires preserved accommodation execution integrity/i
      );

    } finally {

      await db.exec("ROLLBACK");

    }

    // Now install the actual migrations in their
    // intended production order.

    await db.exec(
      actualMigrationBlock(
        "accommodation_integrity"
      )
    );

    await db.exec(
      actualMigrationBlock(
        "scheduled_progressive_boundary"
      )
    );

    await db.exec(patch);

  },60000);

  beforeEach(async () => {
    await db.exec(`
      TRUNCATE charges,packages,allocations,public.folio_lines;

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
