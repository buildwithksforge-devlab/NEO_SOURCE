import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("preserves customer ownership, payment amount and grants when adding receipt property evidence", async () => {
  const db = new PGlite();
  const migration = readFileSync("supabase/migrations/20261122150000_guest_receipt_property_evidence.sql", "utf8");
  const verify = readFileSync("supabase/repair/2026-11-22/guest-receipt-property-verification.sql", "utf8");
  try {
    await db.exec(`
      CREATE ROLE authenticated;
      CREATE ROLE anon;
      CREATE TABLE payments (id uuid, customer_id uuid, branch_id uuid, status text,
        receipt_number text, amount numeric);
      CREATE FUNCTION neo_guest_folio_projection(_org uuid) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER AS $body$
      DECLARE _cust uuid := current_setting('neo.customer')::uuid;
      BEGIN
        RETURN jsonb_build_object('payments', (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id', p.id,
               'receipt_number', p.receipt_number,
               'amount', p.amount)), '[]'::jsonb)
          FROM payments p WHERE p.customer_id = _cust));
      END $body$;
      REVOKE EXECUTE ON FUNCTION neo_guest_folio_projection(uuid) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION neo_guest_folio_projection(uuid) TO authenticated;
      SET neo.customer = '10000000-0000-4000-8000-000000000001';
      INSERT INTO payments VALUES
        ('10000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000001',
         '10000000-0000-4000-8000-000000000020', 'confirmed', 'PAY-1', 250),
        ('10000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000002',
         '10000000-0000-4000-8000-000000000020', 'confirmed', 'FOREIGN', 990);
    `);
    expect((await db.query(verify)).rows[0]).toMatchObject({ projects_property: false });
    await db.exec(migration);
    await db.exec(migration);
    expect((await db.query(verify)).rows[0]).toMatchObject({
      projects_property: true, projects_status: true,
      authenticated_can_execute: true, anonymous_can_execute: false,
    });
    const result = (await db.query<{ payload: { receipt_number: string; amount: number; branch_id: string; status: string }[] }>(
      "SELECT neo_guest_folio_projection(NULL)->'payments' AS payload",
    )).rows[0];
    expect(result?.payload).toEqual([expect.objectContaining({
      receipt_number: "PAY-1", amount: 250, branch_id: "10000000-0000-4000-8000-000000000020", status: "confirmed",
    })]);
  } finally {
    await db.close();
  }
}, 15_000);
