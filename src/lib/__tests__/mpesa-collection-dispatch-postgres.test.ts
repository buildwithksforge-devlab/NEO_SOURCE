import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const org = "00000000-0000-4000-8000-000000000001";
const otherOrg = "00000000-0000-4000-8000-000000000002";
const branch = "00000000-0000-4000-8000-000000000003";
const customer = "00000000-0000-4000-8000-000000000004";
const legacy = "00000000-0000-4000-8000-000000000005";
const migration = readFileSync(
  "supabase/migrations/20261112150000_mpesa_collection_dispatch_guard.sql",
  "utf8",
);

describe("M-Pesa collection creation and one-time dispatch", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE test_context (permitted boolean, branch_ok boolean, fail_transaction boolean);
      INSERT INTO test_context VALUES (true, true, false);
      CREATE FUNCTION current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${org}'::uuid $$;
      CREATE FUNCTION my_customer_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '${customer}'::uuid $$;
      CREATE FUNCTION neo_mpesa_can_collect(text) RETURNS boolean LANGUAGE sql AS $$ SELECT permitted FROM test_context $$;
      CREATE FUNCTION neo_branch_in_scope(uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT branch_ok FROM test_context $$;
      CREATE TABLE pos_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, branch_id uuid, order_number text, currency text DEFAULT 'KES');
      CREATE TABLE folios (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, branch_id uuid, folio_number text, currency text DEFAULT 'KES', balance numeric DEFAULT 100, customer_id uuid, status text DEFAULT 'open');
      CREATE TABLE reservations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, confirmation_number text, customer_id uuid);
      CREATE TABLE payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, folio_id uuid, amount numeric, status text DEFAULT 'pending',
        branch_id uuid, receipt_number text, customer_id uuid, currency text, method text, paid_at timestamptz,
        received_by uuid, notes text, idempotency_key text, source_module text, source_record_id text);
      CREATE TABLE mpesa_settings (organization_id uuid, environment text, short_code text, enabled boolean);
      INSERT INTO mpesa_settings VALUES ('${org}', 'sandbox', '123456', true);
      CREATE TABLE mpesa_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, branch_id uuid,
        source_module text, source_record_id uuid, payment_id uuid, payment_table text,
        amount numeric, account_reference text, status text DEFAULT 'initiated',
        checkout_request_id text, applied_at timestamptz, created_at timestamptz DEFAULT now(),
        msisdn text, description text, environment text, short_code text, created_by uuid
      );
      INSERT INTO mpesa_transactions (id, organization_id, source_module, status)
        VALUES ('${legacy}', '${org}', 'folio', 'initiated');
      -- Existing payment engines are dependency boundaries. These stubs persist
      -- observable rows so rollback/reuse tests exercise real PostgreSQL writes.
      CREATE FUNCTION pos_record_payment_attempt(_order_id uuid, _amount numeric, _method text, _reference text DEFAULT NULL, _idempotency_key text DEFAULT NULL)
      RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE p uuid; BEGIN
        INSERT INTO payments(organization_id, amount) VALUES ('${org}', _amount) RETURNING id INTO p;
        RETURN jsonb_build_object('payment_id', p);
      END $$;
      CREATE FUNCTION pms_record_payment(_folio uuid, _amount numeric, _method text, _reference text DEFAULT NULL, _notes text DEFAULT '', _intent_key text DEFAULT NULL)
      RETURNS uuid LANGUAGE plpgsql AS $$ DECLARE p uuid; BEGIN
        INSERT INTO payments(organization_id, folio_id, amount) VALUES ('${org}', _folio, _amount) RETURNING id INTO p; RETURN p;
      END $$;
      CREATE FUNCTION neo_mpesa_txn_start(text, uuid, text, uuid, uuid, text, numeric, text, text)
      RETURNS uuid LANGUAGE plpgsql AS $$ DECLARE t uuid; BEGIN
        IF (SELECT fail_transaction FROM test_context) THEN RAISE EXCEPTION 'Synthetic transaction failure'; END IF;
        INSERT INTO mpesa_transactions(organization_id, source_module, source_record_id, payment_table, payment_id, branch_id, amount, account_reference)
        VALUES ('${org}', $1, $2, $3, $4, $5, $7, $8) RETURNING id INTO t; RETURN t;
      END $$;
      CREATE FUNCTION neo_guest_folio_mpesa_start(uuid, uuid, text, numeric)
      RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE p uuid; t uuid; BEGIN
        p := pms_record_payment($2, $4, 'mpesa');
        t := neo_mpesa_txn_start('guest_folio', $2, 'payments', p, '${branch}', $3, $4, 'FOLIO', 'Guest');
        RETURN jsonb_build_object('transaction_id', t, 'amount', $4);
      END $$;
      CREATE FUNCTION neo_guest_deposit_pay(uuid, text, text, numeric)
      RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE r uuid; t uuid; BEGIN
        SELECT id INTO r FROM reservations WHERE organization_id=$1 AND confirmation_number=$2;
        t := neo_mpesa_txn_start('reservation_deposit', r, NULL, NULL, '${branch}', $3, $4, $2, 'Deposit');
        RETURN jsonb_build_object('transaction_id', t, 'amount', $4);
      END $$;
    `);
    await db.exec(migration);
  }, 30000);
  beforeEach(async () => {
    await db.exec("UPDATE test_context SET permitted=true, branch_ok=true, fail_transaction=false");
  });
  afterAll(async () => {
    await db.close();
  });

  async function bill(kind: "pos_order" | "folio" = "folio", currency = "KES", owner = org) {
    const result =
      kind === "pos_order"
        ? await db.query<{ id: string }>(
            "INSERT INTO pos_orders(organization_id, branch_id, order_number, currency) VALUES ($1,$2,'POS-TEST',$3) RETURNING id",
            [owner, branch, currency],
          )
        : await db.query<{ id: string }>(
            "INSERT INTO folios(organization_id, branch_id, folio_number, currency, customer_id) VALUES ($1,$2,'FOLIO-TEST',$3,$4) RETURNING id",
            [owner, branch, currency, customer],
          );
    return result.rows[0]!.id;
  }
  async function start(id: string, source = "folio", amount = 25, phone = "254712345678") {
    const result = await db.query<{
      result: { transaction_id: string; reused: boolean; amount: number; status?: string };
    }>("SELECT neo_mpesa_collection_start($1,$2,$3,$4,NULL,$5) AS result", [
      source,
      id,
      phone,
      amount,
      org,
    ]);
    return result.rows[0]!.result;
  }
  async function claim(id: string, owner = org) {
    return (
      await db.query<{ result: { claimed: boolean } }>(
        "SELECT neo_mpesa_claim_dispatch($1,$2) AS result",
        [id, owner],
      )
    ).rows[0]!.result;
  }

  it("does not dispatch legacy in-flight attempts again", async () => {
    expect((await claim(legacy)).claimed).toBe(false);
  });
  it("reuses a POS attempt even when a repeated click changes amount/phone", async () => {
    const id = await bill("pos_order");
    const first = await start(id, "pos_order");
    const repeat = await start(id, "pos_order", 40, "254711111111");
    expect(repeat).toMatchObject({
      transaction_id: first.transaction_id,
      reused: true,
      amount: 25,
    });
    expect(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int n FROM mpesa_transactions WHERE source_record_id=$1",
          [id],
        )
      ).rows[0]!.n,
    ).toBe(1);
  });
  it("shares the outstanding folio attempt across staff and guest checkout", async () => {
    const id = await bill();
    const first = await start(id);
    expect(await start(id, "guest_folio")).toMatchObject({
      transaction_id: first.transaction_id,
      reused: true,
    });
  });
  it("creates one attempt for repeated guest calls and grants one dispatch claim", async () => {
    const id = await bill();
    const attempts = await Promise.all([start(id, "guest_folio"), start(id, "guest_folio")]);
    expect(attempts[0]!.transaction_id).toBe(attempts[1]!.transaction_id);
    expect(attempts.filter((a) => !a.reused)).toHaveLength(1);
    const claims = await Promise.all(attempts.map((a) => claim(a.transaction_id)));
    expect(claims.filter((c) => c.claimed)).toHaveLength(1);
  });
  it("keeps an ambiguous folio attempt instead of sending a fresh one", async () => {
    const id = await bill();
    const first = await start(id);
    await claim(first.transaction_id);
    await db.query("UPDATE mpesa_transactions SET status='unknown' WHERE id=$1", [
      first.transaction_id,
    ]);
    expect(await start(id)).toMatchObject({
      reused: true,
      status: "unknown",
      transaction_id: first.transaction_id,
    });
    expect((await claim(first.transaction_id)).claimed).toBe(false);
  });
  it("reuses ambiguous reservation deposits", async () => {
    const reservation = (
      await db.query<{ id: string }>(
        "INSERT INTO reservations(organization_id,customer_id,confirmation_number) VALUES ($1,$2,'RES-TEST') RETURNING id",
        [org, customer],
      )
    ).rows[0]!.id;
    const transaction = (
      await db.query<{ id: string }>(
        "INSERT INTO mpesa_transactions(organization_id,source_record_id,source_module,amount,status) VALUES ($1,$2,'reservation_deposit',25,'unknown') RETURNING id",
        [org, reservation],
      )
    ).rows[0]!.id;
    const result = (
      await db.query<{ result: object }>(
        "SELECT neo_mpesa_guest_deposit_start($1,'RES-TEST','254712345678',25) result",
        [org],
      )
    ).rows[0]!.result;
    expect(result).toMatchObject({ transaction_id: transaction, status: "unknown", reused: true });
  });
  it("rolls payment creation back when transaction creation fails", async () => {
    const id = await bill();
    await db.exec("UPDATE test_context SET fail_transaction=true");
    await expect(start(id)).rejects.toThrow("Synthetic transaction failure");
    expect(
      (
        await db.query<{ n: number }>("SELECT count(*)::int n FROM payments WHERE folio_id=$1", [
          id,
        ])
      ).rows[0]!.n,
    ).toBe(0);
  });
  it("enforces tenant, property and collection authority before reusing attempts", async () => {
    const id = await bill();
    const transaction = await start(id);
    await expect(claim(transaction.transaction_id, otherOrg)).rejects.toThrow("not found");
    await expect(start(await bill("folio", "KES", otherOrg))).rejects.toThrow("not found");
    await db.exec("UPDATE test_context SET permitted=false");
    await expect(start(id)).rejects.toThrow("Not permitted");
    await db.exec("UPDATE test_context SET permitted=true, branch_ok=false");
    await expect(start(id)).rejects.toThrow("property access");
  });
  it("rejects foreign currency, fractional amounts and over-collection", async () => {
    await expect(start(await bill("folio", "USD"))).rejects.toThrow("KES bill");
    await expect(start(await bill(), "folio", 25.5)).rejects.toThrow("whole KES");
    await expect(start(await bill(), "guest_folio", 101)).rejects.toThrow("exceeds");
    await expect(start(await bill(), "guest_folio", 25, "2547")).rejects.toThrow(
      "valid Kenyan mobile",
    );
    const closed = await bill();
    await db.query("UPDATE folios SET status='closed' WHERE id=$1", [closed]);
    await expect(start(closed, "guest_folio")).rejects.toThrow("cannot accept");
  });
  it("does not grant browser roles permission to claim dispatch", async () => {
    const result = await db.query<{ authenticated: boolean; anon: boolean; service: boolean }>(
      "SELECT has_function_privilege('authenticated','neo_mpesa_claim_dispatch(uuid,uuid)','EXECUTE') authenticated, has_function_privilege('anon','neo_mpesa_claim_dispatch(uuid,uuid)','EXECUTE') anon, has_function_privilege('service_role','neo_mpesa_claim_dispatch(uuid,uuid)','EXECUTE') service",
    );
    expect(result.rows[0]).toEqual({ authenticated: false, anon: false, service: true });
  });
  it("disables stored-payload callback replay even for privileged callers", async () => {
    await expect(db.query("SELECT neo_mpesa_retry_callback($1)", [legacy])).rejects.toThrow(
      "Direct callback replay is disabled",
    );
    const grants = await db.query<{ allowed: boolean }>(
      "SELECT has_function_privilege('authenticated','neo_mpesa_retry_callback(uuid)','EXECUTE') allowed",
    );
    expect(grants.rows[0]?.allowed).toBe(false);
  });

  it("does not expose or reuse a different guest's folio attempt", async () => {
    const id = await bill();
    await start(id);
    await db.query("UPDATE folios SET customer_id=$1 WHERE id=$2", [otherOrg, id]);
    await expect(start(id, "guest_folio")).rejects.toThrow("Folio not found");
  });

  it("creates a new payment for an equal second installment after the first completes", async () => {
    const id = await bill();
    const first = await start(id, "guest_folio");
    await db.query("UPDATE mpesa_transactions SET status='success', applied_at=now() WHERE id=$1", [
      first.transaction_id,
    ]);
    await db.query("UPDATE payments SET status='confirmed' WHERE folio_id=$1", [id]);
    await db.query("UPDATE folios SET balance=75 WHERE id=$1", [id]);
    const second = await start(id, "guest_folio");
    expect(second.reused).toBe(false);
    expect(second.transaction_id).not.toBe(first.transaction_id);
    expect(
      (
        await db.query<{ n: number }>(
          "SELECT count(DISTINCT payment_id)::int n FROM mpesa_transactions WHERE source_record_id=$1",
          [id],
        )
      ).rows[0]!.n,
    ).toBe(2);
  });

  it("does not grant a new dispatch claim to a terminal or already applied attempt", async () => {
    const id = await bill();
    const attempt = await start(id);
    await db.query("UPDATE mpesa_transactions SET status='success', applied_at=now() WHERE id=$1", [
      attempt.transaction_id,
    ]);
    expect((await claim(attempt.transaction_id)).claimed).toBe(false);
  });
});
