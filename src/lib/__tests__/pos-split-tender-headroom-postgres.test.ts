import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("reserves one balance across cash, card and repeated mobile payments", async () => {
  const db = new PGlite();
  const id = (n: number) => `23100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const [org, branch, order, till, cashier, firstRequest, secondRequest] = [1, 2, 3, 4, 5, 6, 7].map(id);
  const legacyOrder = id(8);
  const legacyFirst = id(9);
  const legacySecond = id(10);
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE TABLE pos_orders(id uuid PRIMARY KEY, organization_id uuid, branch_id uuid, currency text, grand_total numeric);
      CREATE TABLE cash_payment_requests(id uuid PRIMARY KEY, organization_id uuid, branch_id uuid, currency text,
        source_module text, source_record_id uuid, status text, amount numeric, method text,
        assigned_shift_id uuid, assigned_cashier_id uuid);
      CREATE TABLE pos_payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, branch_id uuid, currency text,
        order_id uuid, status text, amount numeric, method text, shift_id uuid, cashier_id uuid, idempotency_key text);
      INSERT INTO pos_orders VALUES ('${order}','${org}','${branch}','KES',10000),
        ('${legacyOrder}','${org}','${branch}','KES',10000);
      INSERT INTO cash_payment_requests VALUES
        ('${legacyFirst}','${org}','${branch}','KES','pos','${legacyOrder}','pending',6000,'cash','${till}',NULL),
        ('${legacySecond}','${org}','${branch}','KES','pos','${legacyOrder}','pending',6000,'cash','${till}','${cashier}');
    `);
    await db.exec(readFileSync("supabase/migrations/20261123101500_pos_split_tender_shared_headroom.sql", "utf8"));
    const queueCash = (requestId: string, amount: number) => db.query(
      "INSERT INTO cash_payment_requests VALUES ($1,$2,$3,'KES','pos',$4,'pending',$5,'cash',$6,$7)",
      [requestId, org, branch, order, amount, till, cashier],
    );
    const pay = (method: string, amount: number, key: string, status = "confirmed", orderId = order) => db.query(
      "INSERT INTO pos_payments (organization_id,branch_id,currency,order_id,status,amount,method,shift_id,cashier_id,idempotency_key) VALUES ($1,$2,'KES',$3,$4,$5,$6,$7,$8,$9)",
      [org, branch, orderId, status, amount, method, till, cashier, key],
    );

    await queueCash(firstRequest!, 5000);
    await expect(queueCash(secondRequest!, 5000.01)).rejects.toMatchObject({ code: "23514" });
    await expect(pay("mpesa", 6000, "mobile-overbook", "pending")).rejects.toMatchObject({ code: "23514" });
    await pay("mpesa", 1250, "mobile-a", "pending");
    await db.exec("UPDATE pos_payments SET status='confirmed' WHERE idempotency_key='mobile-a'");
    await pay("mpesa", 1250, "mobile-b", "pending");
    await pay("card", 2500, "card-a");
    await expect(pay("cash", 5000, "other-cash")).rejects.toMatchObject({ code: "23514" });
    await db.exec("BEGIN");
    await pay("cash", 5000, `cash-request:${firstRequest}`);
    await db.query("UPDATE cash_payment_requests SET status='confirmed' WHERE id=$1", [firstRequest]);
    await db.exec("COMMIT");
    await db.exec("UPDATE pos_payments SET status='confirmed' WHERE idempotency_key='mobile-b'");
    expect((await db.query("SELECT count(*)::int AS count, sum(amount)::int AS total FROM pos_payments WHERE status='confirmed'")).rows)
      .toEqual([{ count: 4, total: 10000 }]);
    await expect(queueCash(secondRequest!, 0.01)).rejects.toMatchObject({ code: "23514" });

    await db.exec("BEGIN");
    await pay("cash", 6000, `cash-request:${legacyFirst}`, "confirmed", legacyOrder);
    await db.query("UPDATE cash_payment_requests SET status='confirmed' WHERE id=$1", [legacyFirst]);
    await db.exec("COMMIT");
    await expect(pay("cash", 6000, `cash-request:${legacySecond}`, "confirmed", legacyOrder))
      .rejects.toMatchObject({ code: "23514" });
  } finally {
    await db.close();
  }
}, 30_000);
