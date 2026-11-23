import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("assigns cash deposits to the clerk's till, reports the journal and counts the collection once", async () => {
  const db = new PGlite();
  const shift = "10000000-0000-0000-0000-000000000001";
  try {
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $$;
      CREATE FUNCTION public.current_org_id() RETURNS uuid LANGUAGE sql AS $$ SELECT auth.uid() $$;
      CREATE TABLE pos_shifts (
        id uuid PRIMARY KEY, organization_id uuid, branch_id uuid, cashier_id uuid,
        status text, opened_at timestamptz, opening_float numeric, total_drops numeric, total_paid_outs numeric
      );
      CREATE TABLE payments (id uuid, shift_id uuid, amount numeric, method text, status text);
      CREATE TABLE pos_payments (shift_id uuid, amount numeric, method text, status text);
      CREATE TABLE cash_movements (shift_id uuid, amount numeric, movement_type text);
      CREATE TABLE reservation_deposits (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, branch_id uuid,
        amount numeric, method text, status text, payment_id uuid, reference text, received_at timestamptz DEFAULT now()
      );
      CREATE TABLE financial_states (organization_id uuid, branch_id uuid, source_module text, source_id uuid,
        journal_id uuid, financial_status text);
      CREATE TABLE journal_entries (id uuid, organization_id uuid, journal_number text);
      CREATE FUNCTION public.neo_cash_shift_reconciliation(_shift uuid)
      RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE _s pos_shifts; _receipts jsonb := '[]';
      BEGIN
        SELECT * INTO _s FROM pos_shifts WHERE id = _shift;
        RETURN jsonb_build_object('folio_receipts',_receipts);
      END $$;
      INSERT INTO pos_shifts VALUES ('${shift}', auth.uid(), auth.uid(), auth.uid(), 'open', now(), 100, 0, 0);
      INSERT INTO reservation_deposits (organization_id, branch_id, amount, method, status)
      VALUES (auth.uid(), auth.uid(), 99, 'cash', 'held');
    `);
    await db.exec(readFileSync("supabase/migrations/20261123120000_reservation_cash_deposit_till.sql", "utf8"));
    await db.exec(`
      INSERT INTO reservation_deposits (organization_id, branch_id, amount, method, status, reference)
      VALUES (auth.uid(), auth.uid(), 58500, 'cash', 'held', 'receipt-test'),
             (auth.uid(), NULL, 900, 'card', 'held', 'card-test');
      INSERT INTO journal_entries VALUES (auth.uid(), auth.uid(), 'JV-test');
      INSERT INTO financial_states
      SELECT organization_id, branch_id, 'deposit', id, auth.uid(), 'posted'
      FROM reservation_deposits WHERE reference = 'receipt-test';
      UPDATE reservation_deposits SET status = 'applied' WHERE reference = 'receipt-test';
    `);
    const result = await db.query(`
      SELECT cash_shift_expected($1)::int AS expected, neo_cash_shift_reconciliation($1) AS reconciled
    `, [shift]);
    expect(result.rows).toMatchObject([{
      expected: 58600,
      reconciled: { deposit_receipts: [{ reference: "receipt-test", amount: 58500, journal_number: "JV-test" }] },
    }]);
    await db.exec(`
      INSERT INTO payments VALUES (auth.uid(), '${shift}', 58500, 'cash', 'confirmed');
      UPDATE reservation_deposits SET payment_id = auth.uid() WHERE reference = 'receipt-test';
      UPDATE pos_shifts SET status = 'closed';
    `);
    expect((await db.query("SELECT cash_shift_expected($1)::int AS expected", [shift])).rows)
      .toEqual([{ expected: 58600 }]);
    await expect(db.exec(`
      INSERT INTO reservation_deposits (organization_id, branch_id, amount, method)
      VALUES (auth.uid(), auth.uid(), 100, 'cash')
    `)).rejects.toThrow("Open your cashier till");
  } finally {
    await db.close();
  }
});
