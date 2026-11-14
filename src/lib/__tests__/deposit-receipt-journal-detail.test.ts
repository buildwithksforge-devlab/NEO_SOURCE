import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20261112110000_deposit_receipt_journal_detail.sql",
  "utf8",
);
const org = "00000000-0000-4000-8000-000000000001";
const branch = "00000000-0000-4000-8000-000000000002";
const actor = "00000000-0000-4000-8000-000000000003";
const oldDeposit = "00000000-0000-4000-8000-000000000004";
const newDeposit = "00000000-0000-4000-8000-000000000005";
const reservation = "00000000-0000-4000-8000-000000000006";
const oldJournal = "00000000-0000-4000-8000-000000000007";
const newJournal = "00000000-0000-4000-8000-000000000008";

describe("deposit posting receipt journal reference", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${actor}'::uuid $$;
      CREATE FUNCTION public.is_org_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
      CREATE FUNCTION public.has_permission(text, text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
      CREATE FUNCTION public.neo_fact_currency(uuid, uuid) RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'KES' $$;
      CREATE FUNCTION public.neo_gl_cash_code(uuid, text, uuid) RETURNS text LANGUAGE sql STABLE AS $$ SELECT '1010' $$;
      CREATE FUNCTION public.neo_gl_cash_name(text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'Cash' $$;
      CREATE FUNCTION public.neo_finance_ensure_account(uuid, text, text, text, text) RETURNS void
        LANGUAGE sql AS $$ SELECT $$;

      CREATE TABLE public.reservation_deposits (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid,
        currency text,
        received_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        reservation_id uuid NOT NULL,
        method text,
        destination_account_id uuid,
        customer_id uuid,
        amount numeric NOT NULL,
        status text NOT NULL
      );
      CREATE TABLE public.reservations (
        id uuid PRIMARY KEY,
        confirmation_number text
      );
      CREATE TABLE public.finance_posting_receipts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        branch_id uuid,
        source_module text NOT NULL,
        source_id uuid NOT NULL,
        source_reference text,
        idempotency_key text NOT NULL,
        status text NOT NULL,
        amount numeric NOT NULL,
        currency text NOT NULL,
        folio_line_id uuid,
        detail text,
        last_error text,
        occurred_on date,
        attempts integer NOT NULL,
        requested_by uuid,
        posted_at timestamptz,
        UNIQUE (organization_id, idempotency_key)
      );
      CREATE TABLE public.financial_states (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        branch_id uuid,
        source_module text NOT NULL,
        source_id uuid NOT NULL,
        source_reference text,
        operational_status text,
        financial_status text NOT NULL,
        reason text,
        amount numeric NOT NULL,
        currency text NOT NULL,
        accounting_date date,
        journal_id uuid,
        receipt_id uuid,
        last_error text,
        actor_id uuid,
        detail jsonb NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE (source_module, source_id)
      );
      CREATE TABLE public.journal_posts (id uuid PRIMARY KEY);

      CREATE FUNCTION public.neo_gl_post(
        uuid, uuid, text, text, uuid, text, date, text, text, jsonb, uuid
      ) RETURNS jsonb LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO public.journal_posts VALUES ('${newJournal}'::uuid);
        RETURN jsonb_build_object('journal_id', '${newJournal}'::uuid);
      END
      $$;

      CREATE FUNCTION public.neo_record_posting_receipt(
        uuid, uuid, text, uuid, text, text, numeric, text, uuid, text, text, date
      ) RETURNS uuid LANGUAGE plpgsql AS $$
      DECLARE receipt_id uuid;
      BEGIN
        INSERT INTO public.finance_posting_receipts
          (organization_id, branch_id, source_module, source_id, source_reference, idempotency_key,
           status, amount, currency, folio_line_id, detail, last_error, occurred_on, attempts,
           requested_by, posted_at)
        VALUES ($1,$2,$3,$4,$5,$3 || ':' || $4::text,$6,$7,$8,$9,$10,$11,$12,1,auth.uid(),
                CASE WHEN $6 = 'posted' THEN now() END)
        ON CONFLICT (organization_id, idempotency_key) DO UPDATE
          SET status = CASE WHEN finance_posting_receipts.status = 'posted' THEN 'posted' ELSE EXCLUDED.status END,
              detail = EXCLUDED.detail,
              attempts = finance_posting_receipts.attempts + 1
        RETURNING id INTO receipt_id;
        RETURN receipt_id;
      END
      $$;

      CREATE FUNCTION public.neo_financial_state_set(
        uuid, uuid, text, uuid, text, text, text, text, numeric, text, date,
        uuid, uuid, text, uuid, jsonb
      ) RETURNS uuid LANGUAGE plpgsql AS $$
      DECLARE state_id uuid;
      BEGIN
        INSERT INTO public.financial_states
          (organization_id, branch_id, source_module, source_id, source_reference,
           operational_status, financial_status, reason, amount, currency, accounting_date,
           journal_id, receipt_id, last_error, actor_id, detail)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,coalesce($16,'{}'::jsonb))
        ON CONFLICT (source_module, source_id) DO UPDATE
          SET financial_status = EXCLUDED.financial_status,
              journal_id = coalesce(EXCLUDED.journal_id, financial_states.journal_id)
        RETURNING id INTO state_id;
        RETURN state_id;
      END
      $$;

      INSERT INTO public.finance_posting_receipts
        (id, organization_id, branch_id, source_module, source_id, source_reference,
         idempotency_key, status, amount, currency, detail, occurred_on, attempts)
      VALUES ('00000000-0000-4000-8000-000000000009', '${org}', '${branch}', 'deposit',
        '${oldDeposit}', 'OLD-RES', 'deposit:${oldDeposit}', 'posted', 25, 'KES', NULL, CURRENT_DATE, 1);
      INSERT INTO public.financial_states
        (organization_id, branch_id, source_module, source_id, source_reference,
         financial_status, amount, currency, journal_id)
      VALUES ('${org}', '${branch}', 'deposit', '${oldDeposit}', 'OLD-RES',
        'posted', 25, 'KES', '${oldJournal}');
      INSERT INTO public.reservations (id, confirmation_number)
      VALUES ('${reservation}', 'NEW-RES');
      INSERT INTO public.reservation_deposits
        (id, organization_id, branch_id, reservation_id, method, amount, status)
      VALUES ('${newDeposit}', '${org}', '${branch}', '${reservation}', 'cash', 100, 'received');
    `);
    await db.exec(migration);
  }, 30_000);

  afterAll(async () => {
    await db.close();
  });

  it("backfills only a blank detail for a posted deposit with a posted journal", async () => {
    const result = await db.query<{ detail: string }>(
      `SELECT detail FROM public.finance_posting_receipts
        WHERE source_id = $1 AND source_module = 'deposit'`,
      [oldDeposit],
    );
    expect(result.rows[0]?.detail).toBe(`Posted to journal ${oldJournal}`);
  });

  it("records the generated journal reference and does not repost on retry", async () => {
    const posted = await db.query<{
      result: { module: string; source_id: string; journal_id: string };
    }>(
      "SELECT public.neo_deposit_post($1, false) AS result",
      [newDeposit],
    );
    expect(posted.rows[0]?.result).toEqual({
      module: "deposit",
      source_id: newDeposit,
      journal_id: newJournal,
    });

    const receipt = await db.query<{ status: string; detail: string; attempts: number }>(
      `SELECT status, detail, attempts FROM public.finance_posting_receipts
        WHERE source_id = $1 AND source_module = 'deposit'`,
      [newDeposit],
    );
    expect(receipt.rows[0]).toEqual({
      status: "posted",
      detail: `Posted to journal ${newJournal}`,
      attempts: 1,
    });

    const retry = await db.query<{ result: { reason: string } }>(
      "SELECT public.neo_deposit_post($1, false) AS result",
      [newDeposit],
    );
    expect(retry.rows[0]?.result.reason).toBe("already_posted");

    const posts = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM public.journal_posts");
    expect(posts.rows[0]?.count).toBe(1);
  });
});
