import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20261112130000_guest_mpesa_deposit_idempotency.sql",
  "utf8",
);
const org = "00000000-0000-4000-8000-000000000001";
const otherOrg = "00000000-0000-4000-8000-000000000007";
const branch = "00000000-0000-4000-8000-000000000002";
const customer = "00000000-0000-4000-8000-000000000003";
const reservation = "00000000-0000-4000-8000-000000000004";
const toppedReservation = "00000000-0000-4000-8000-000000000005";
const paidReservation = "00000000-0000-4000-8000-000000000006";

describe("guest M-Pesa deposit idempotency and excess handling", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '${customer}'::uuid $$;
      CREATE FUNCTION public.current_org_id() RETURNS uuid
        LANGUAGE sql STABLE AS $$ SELECT '${org}'::uuid $$;
      CREATE FUNCTION public.neo_mpesa_admin() RETURNS boolean
        LANGUAGE sql STABLE AS $$ SELECT true $$;
      CREATE FUNCTION public.gen_random_bytes(integer) RETURNS bytea
        LANGUAGE sql IMMUTABLE AS $$ SELECT decode(repeat('00', $1), 'hex') $$;
      CREATE TABLE public.organizations (id uuid PRIMARY KEY);
      CREATE TABLE public.reservations (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        branch_id uuid,
        confirmation_number text NOT NULL,
        customer_id uuid,
        deposit_required numeric NOT NULL DEFAULT 0
      );
      CREATE TABLE public.mpesa_settings (
        organization_id uuid PRIMARY KEY,
        environment text,
        short_code text,
        party_b text,
        account_reference text,
        transaction_type text,
        consumer_key text,
        consumer_secret text,
        passkey text,
        callback_token text NOT NULL DEFAULT 'synthetic-callback-token',
        callback_base_url text,
        enabled boolean,
        updated_by uuid,
        updated_at timestamptz,
        last_check_at timestamptz,
        last_check_status text,
        last_check_detail text
      );
      CREATE TABLE public.audit_logs (
        organization_id uuid,
        user_id uuid,
        action text,
        module text,
        record_id text,
        new_value jsonb
      );
      CREATE TABLE public.mpesa_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        branch_id uuid,
        source_module text NOT NULL,
        source_record_id uuid,
        payment_table text,
        payment_id uuid,
        msisdn text NOT NULL,
        amount numeric(14,2) NOT NULL,
        account_reference text,
        description text,
        environment text NOT NULL DEFAULT 'sandbox',
        short_code text,
        status text NOT NULL DEFAULT 'initiated',
        raw_request jsonb,
        created_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        applied_at timestamptz,
        mpesa_receipt_number text
      );
      CREATE TABLE public.reservation_deposits (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        branch_id uuid,
        reservation_id uuid NOT NULL,
        customer_id uuid,
        amount numeric(14,2) NOT NULL,
        currency text,
        method text,
        reference text,
        status text NOT NULL,
        idempotency_key text,
        notes text
      );
      CREATE FUNCTION public.my_customer_id() RETURNS uuid
        LANGUAGE sql STABLE AS $$ SELECT '${customer}'::uuid $$;
      CREATE FUNCTION public.neo_guest_reservation_position(uuid, text) RETURNS jsonb
        LANGUAGE sql STABLE AS $$
          SELECT jsonb_build_object(
            'outstanding',
            GREATEST(
              r.deposit_required - COALESCE((
                SELECT sum(d.amount) FROM public.reservation_deposits d
                 WHERE d.reservation_id = r.id AND d.status IN ('held', 'applied')
              ), 0),
              0
            )
          )
          FROM public.reservations r
          WHERE r.organization_id = $1 AND r.confirmation_number = $2
        $$;
      INSERT INTO public.organizations VALUES ('${org}'), ('${otherOrg}');
      INSERT INTO public.mpesa_settings
        (organization_id, environment, short_code, party_b, transaction_type,
         consumer_key, consumer_secret, passkey, enabled)
      VALUES ('${org}', 'sandbox', '123456', '123456', 'CustomerPayBillOnline',
        'synthetic-sandbox-key', 'synthetic-sandbox-secret', 'synthetic-sandbox-passkey', true);
      INSERT INTO public.reservations
        (id, organization_id, branch_id, confirmation_number, customer_id, deposit_required)
      VALUES
        ('${reservation}', '${org}', '${branch}', 'RES-TEST-1', '${customer}', 100),
        ('${toppedReservation}', '${org}', '${branch}', 'RES-TEST-2', '${customer}', 50),
        ('${paidReservation}', '${org}', '${branch}', 'RES-TEST-3', '${customer}', 40);
      INSERT INTO public.reservation_deposits
        (organization_id, branch_id, reservation_id, customer_id, amount, method, status)
      VALUES
        ('${org}', '${branch}', '${toppedReservation}', '${customer}', 40, 'cash', 'held'),
        ('${org}', '${branch}', '${paidReservation}', '${customer}', 40, 'cash', 'held');
      INSERT INTO public.mpesa_transactions
        (organization_id, branch_id, source_module, source_record_id, msisdn, amount, status, raw_request)
      VALUES ('${org}', '${branch}', 'pos_order', '${reservation}', '254700000000', 1, 'pending',
        '{"CallBackURL":"https://example.invalid/callback/synthetic-token","Password":"[redacted]"}');
    `);
    await db.exec(migration);
  }, 30_000);

  afterAll(async () => {
    await db.close();
  });

  it("redacts stored callback bearer URLs from historical provider requests", async () => {
    const result = await db.query<{ raw_request: Record<string, string> }>(
      `SELECT raw_request FROM public.mpesa_transactions
        WHERE source_module = 'pos_order' AND source_record_id = $1`,
      [reservation],
    );
    expect(result.rows[0]?.raw_request).toEqual({
      CallBackURL: "[redacted]",
      Password: "[redacted]",
    });
  });

  it("reuses one active prompt and only opens another after a terminal result", async () => {
    const first = await db.query<{ result: Record<string, unknown> }>(
      `SELECT public.neo_guest_deposit_pay($1, $2, $3, NULL) AS result`,
      [org, "RES-TEST-1", "0712345678"],
    );
    const firstResult = first.rows[0]?.result;
    expect(firstResult).toMatchObject({ ok: true, reused: false, amount: 100, status: "initiated" });

    const second = await db.query<{ result: Record<string, unknown> }>(
      `SELECT public.neo_guest_deposit_pay($1, $2, $3, NULL) AS result`,
      [org, "RES-TEST-1", "0712345678"],
    );
    expect(second.rows[0]?.result).toMatchObject({
      ok: true,
      reused: true,
      amount: 100,
      transaction_id: firstResult?.["transaction_id"],
      status: "initiated",
    });

    const count = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.mpesa_transactions
        WHERE source_module = 'reservation_deposit' AND source_record_id = $1`,
      [reservation],
    );
    expect(count.rows[0]?.count).toBe(1);

    await db.query(
      `UPDATE public.mpesa_transactions SET status = 'cancelled', applied_at = now()
        WHERE id = $1`,
      [firstResult?.["transaction_id"]],
    );
    const retry = await db.query<{ result: Record<string, unknown> }>(
      `SELECT public.neo_guest_deposit_pay($1, $2, $3, NULL) AS result`,
      [org, "RES-TEST-1", "0712345678"],
    );
    expect(retry.rows[0]?.result).toMatchObject({ ok: true, reused: false, amount: 100 });
  });

  it("does not allow a guest to substitute another organization for a reservation", async () => {
    await expect(
      db.query(
        `SELECT public.neo_guest_deposit_pay($1, $2, $3, NULL)`,
        [otherOrg, "RES-TEST-1", "0712345678"],
      ),
    ).rejects.toThrow("Reservation not found");
  });

  it("applies only the remaining deposit and records the excess for refund review", async () => {
    const created = await db.query<{ id: string }>(
      `INSERT INTO public.mpesa_transactions
        (organization_id, branch_id, source_module, source_record_id, msisdn, amount, status)
       VALUES ($1, $2, 'reservation_deposit', $3, '254712345678', 20, 'pending')
       RETURNING id`,
      [org, branch, toppedReservation],
    );
    const transactionId = created.rows[0]!.id;

    await db.query(
      `UPDATE public.mpesa_transactions
          SET status = 'success', applied_at = now(), mpesa_receipt_number = 'TEST-RECEIPT'
        WHERE id = $1`,
      [transactionId],
    );
    await db.query(
      `INSERT INTO public.reservation_deposits
        (organization_id, branch_id, reservation_id, customer_id, amount, currency, method,
         reference, status, idempotency_key, notes)
       VALUES ($1, $2, $3, $4, 20, 'KES', 'mpesa', 'TEST-RECEIPT', 'held',
         'mpesa-deposit:' || $5, 'Guest app booking deposit')`,
      [org, branch, toppedReservation, customer, transactionId],
    );

    const posting = await db.query<{ amount: string }>(
      `SELECT amount FROM public.reservation_deposits WHERE idempotency_key = $1`,
      [`mpesa-deposit:${transactionId}`],
    );
    expect(Number(posting.rows[0]?.amount)).toBe(10);

    const exception = await db.query<{
      amount_received: string;
      amount_applied: string;
      excess_amount: string;
      status: string;
    }>(
      `SELECT amount_received, amount_applied, excess_amount, status
         FROM public.mpesa_deposit_exceptions WHERE transaction_id = $1`,
      [transactionId],
    );
    expect({
      amount_received: Number(exception.rows[0]?.amount_received),
      amount_applied: Number(exception.rows[0]?.amount_applied),
      excess_amount: Number(exception.rows[0]?.excess_amount),
      status: exception.rows[0]?.status,
    }).toEqual({
      amount_received: 20,
      amount_applied: 10,
      excess_amount: 10,
      status: "refund_required",
    });
  });

  it("quarantines the full payment if the deposit was already satisfied", async () => {
    const created = await db.query<{ id: string }>(
      `INSERT INTO public.mpesa_transactions
        (organization_id, branch_id, source_module, source_record_id, msisdn, amount, status)
       VALUES ($1, $2, 'reservation_deposit', $3, '254712345678', 15, 'pending')
       RETURNING id`,
      [org, branch, paidReservation],
    );
    const transactionId = created.rows[0]!.id;

    await db.query(
      `UPDATE public.mpesa_transactions SET status = 'success', applied_at = now() WHERE id = $1`,
      [transactionId],
    );
    const inserted = await db.query<{ id: string | null }>(
      `INSERT INTO public.reservation_deposits
        (organization_id, branch_id, reservation_id, customer_id, amount, currency, method,
         reference, status, idempotency_key, notes)
       VALUES ($1, $2, $3, $4, 15, 'KES', 'mpesa', $5, 'held',
         'mpesa-deposit:' || $6, 'Guest app booking deposit')
       RETURNING id`,
      [org, branch, paidReservation, customer, transactionId, transactionId],
    );
    expect(inserted.rows).toHaveLength(0);

    const exception = await db.query<{ amount_applied: string; excess_amount: string }>(
      `SELECT amount_applied, excess_amount
         FROM public.mpesa_deposit_exceptions WHERE transaction_id = $1`,
      [transactionId],
    );
    expect({
      amount_applied: Number(exception.rows[0]?.amount_applied),
      excess_amount: Number(exception.rows[0]?.excess_amount),
    }).toEqual({ amount_applied: 0, excess_amount: 15 });
  });

  it("does not reuse credentials when the environment changes", async () => {
    const activeChange = await db.query<{ result: Record<string, unknown> }>(
      `SELECT public.neo_mpesa_settings_save(
        'production', '123456', '123456', NULL, 'CustomerPayBillOnline',
        NULL, NULL, NULL, NULL, false, false, false
      ) AS result`,
    );
    expect(activeChange.rows[0]?.result).toMatchObject({
      authorised: true,
      saved: false,
    });

    await db.query(
      `UPDATE public.mpesa_transactions SET status = 'failed', applied_at = now()
        WHERE organization_id = $1 AND applied_at IS NULL`,
      [org],
    );

    const missingCredentials = await db.query<{ result: Record<string, unknown> }>(
      `SELECT public.neo_mpesa_settings_save(
        'production', '123456', '123456', NULL, 'CustomerPayBillOnline',
        NULL, NULL, NULL, NULL, false, false, false
      ) AS result`,
    );
    expect(missingCredentials.rows[0]?.result).toMatchObject({
      authorised: true,
      saved: false,
    });

    const unchanged = await db.query<{ environment: string; consumer_key: string }>(
      `SELECT environment, consumer_key FROM public.mpesa_settings WHERE organization_id = $1`,
      [org],
    );
    expect(unchanged.rows[0]).toEqual({
      environment: "sandbox",
      consumer_key: "synthetic-sandbox-key",
    });

    const switched = await db.query<{ result: Record<string, unknown> }>(
      `SELECT public.neo_mpesa_settings_save(
        'production', '123456', '123456', NULL, 'CustomerPayBillOnline',
        'synthetic-production-key', 'synthetic-production-secret', 'synthetic-production-passkey',
        NULL, false, false, false
      ) AS result`,
    );
    expect(switched.rows[0]?.result).toMatchObject({ authorised: true, saved: true });

    const newCredentials = await db.query<{
      environment: string;
      consumer_key: string;
      consumer_secret: string;
      passkey: string;
    }>(
      `SELECT environment, consumer_key, consumer_secret, passkey
         FROM public.mpesa_settings WHERE organization_id = $1`,
      [org],
    );
    expect(newCredentials.rows[0]).toEqual({
      environment: "production",
      consumer_key: "synthetic-production-key",
      consumer_secret: "synthetic-production-secret",
      passkey: "synthetic-production-passkey",
    });
  });
});
