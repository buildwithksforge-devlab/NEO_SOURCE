import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20261112140000_provider_payment_dispatch_safety.sql",
  "utf8",
);
const org = "00000000-0000-4000-8000-000000000001";
const actor = "00000000-0000-4000-8000-000000000002";
const legacyAttempt = "00000000-0000-4000-8000-000000000003";
const currentAttempt = "00000000-0000-4000-8000-000000000004";

describe("provider payment dispatch safety", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE SCHEMA extensions;
      CREATE FUNCTION auth.uid() RETURNS uuid
        LANGUAGE sql STABLE AS $$ SELECT '${actor}'::uuid $$;
      CREATE FUNCTION public.current_org_id() RETURNS uuid
        LANGUAGE sql STABLE AS $$ SELECT '${org}'::uuid $$;
      CREATE FUNCTION public.has_permission(text, text) RETURNS boolean
        LANGUAGE sql STABLE AS $$ SELECT true $$;
      CREATE FUNCTION public.has_permission(text, text, text) RETURNS boolean
        LANGUAGE sql STABLE AS $$ SELECT true $$;
      CREATE FUNCTION public.neo_branch_in_scope(uuid) RETURNS boolean
        LANGUAGE sql STABLE AS $$ SELECT true $$;
      CREATE FUNCTION extensions.digest(bytea, text) RETURNS bytea
        LANGUAGE sql IMMUTABLE AS $$
          SELECT decode(md5(encode($1, 'hex')), 'hex')
        $$;
      CREATE TABLE public.integration_connections (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        provider_code text NOT NULL,
        branch_id uuid,
        enabled boolean NOT NULL DEFAULT false,
        status text NOT NULL DEFAULT 'not_configured',
        environment text
      );
      CREATE TABLE public.payment_attempts (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid,
        source_module text NOT NULL DEFAULT 'pos',
        source_record_id uuid,
        payment_table text NOT NULL DEFAULT 'payment_intents',
        payment_id uuid NOT NULL,
        method text NOT NULL DEFAULT 'qr',
        provider_code text,
        environment text,
        amount numeric NOT NULL DEFAULT 1,
        currency text,
        tendered numeric,
        change_due numeric,
        reference text,
        state text NOT NULL DEFAULT 'requested',
        state_detail text,
        manual_tender boolean NOT NULL DEFAULT false,
        verified_by uuid,
        verified_at timestamptz,
        verification_note text,
        posted_journal_id uuid,
        requested_at timestamptz NOT NULL DEFAULT now(),
        confirmed_at timestamptz,
        created_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        provider_reference text,
        callback_token text,
        provider_payload jsonb,
        linked_table text,
        linked_id uuid,
        dispatch_started_at timestamptz
      );
      INSERT INTO public.payment_attempts
        (id, organization_id, payment_id, state, callback_token)
      VALUES
        ('${legacyAttempt}', '${org}', '${legacyAttempt}', 'cancelled', 'legacy-callback-token');
    `);
    await db.exec(migration);
    await db.query(
      `INSERT INTO public.payment_attempts
        (id, organization_id, payment_id, state)
       VALUES ($1, $2, $1, 'requested')`,
      [currentAttempt, org],
    );
  }, 30_000);

  afterAll(async () => {
    await db.close();
  });

  it("hashes legacy callback tokens and keeps them usable by their original callback", async () => {
    const stored = await db.query<{ callback_token: string }>(
      `SELECT callback_token FROM public.payment_attempts WHERE id = $1`,
      [legacyAttempt],
    );
    expect(stored.rows[0]?.callback_token).not.toBe("legacy-callback-token");
    const applied = await db.query<{ result: Record<string, unknown> }>(
      `SELECT public.neo_payment_intent_apply(
        'legacy-callback-token', 'cancelled', NULL, NULL, NULL
      ) AS result`,
    );
    expect(applied.rows[0]?.result).toMatchObject({
      ok: true,
      reason: "already_applied",
      state: "cancelled",
    });
  });

  it("claims a provider intent only once and stores a hash instead of the bearer token", async () => {
    const token = "synthetic-callback-token-with-enough-entropy";
    const first = await db.query<{ result: Record<string, unknown> }>(
      `SELECT public.neo_payment_intent_claim_dispatch($1, $2) AS result`,
      [currentAttempt, token],
    );
    expect(first.rows[0]?.result).toMatchObject({ ok: true, claimed: true, state: "requested" });

    const stored = await db.query<{ callback_token: string; dispatch_started_at: string }>(
      `SELECT callback_token, dispatch_started_at
         FROM public.payment_attempts WHERE id = $1`,
      [currentAttempt],
    );
    expect(stored.rows[0]?.callback_token).not.toBe(token);
    expect(stored.rows[0]?.dispatch_started_at).toBeTruthy();

    const second = await db.query<{ result: Record<string, unknown> }>(
      `SELECT public.neo_payment_intent_claim_dispatch($1, $2) AS result`,
      [currentAttempt, "another-synthetic-callback-token"],
    );
    expect(second.rows[0]?.result).toMatchObject({ ok: true, claimed: false, state: "requested" });
    expect(second.rows[0]?.result).not.toHaveProperty("token");
  });
});
