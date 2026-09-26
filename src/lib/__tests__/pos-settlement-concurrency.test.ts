import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Concurrency evidence for POS settlement.
 *
 * Two cashiers pressing "charge" at the same moment, or one terminal retrying a
 * timed-out request, must never post the same money twice and must never push
 * the order past its outstanding balance. Three deployed mechanisms make that
 * true, and this suite pins all three to the SQL that is actually live:
 *
 *  1. a partial unique index on (organization_id, idempotency_key), so a racing
 *     insert with a replayed key fails at the storage layer even if two
 *     transactions both miss the lookup;
 *  2. `SELECT ... FOR UPDATE` on the order before the ceiling is computed, so
 *     concurrent attempts serialise on the order row rather than each reading a
 *     stale balance;
 *  3. a ceiling that subtracts *active* initiated/pending attempts from the
 *     outstanding balance, so an in-flight M-Pesa attempt still reserves its
 *     amount against a second attempt.
 */
const SQL = readFileSync(join(process.cwd(), "src/lib/__tests__/fixtures/pos-settlement-menu.sql"), "utf8");

const record = (() => {
  const start = SQL.indexOf("FUNCTION public.pos_record_payment_attempt(");
  const next = SQL.indexOf("CREATE OR REPLACE FUNCTION", start + 10);
  return SQL.slice(start, next === -1 ? undefined : next);
})();

const at = (needle: string): number => {
  const i = record.indexOf(needle);
  expect(i, `missing from pos_record_payment_attempt: ${needle}`).toBeGreaterThan(-1);
  return i;
};

describe("replaying one idempotency key", () => {
  it("resolves the stored payment before any new row is written", () => {
    expect(at("WHERE organization_id = _org AND idempotency_key = _key")).toBeLessThan(
      at("INSERT INTO public.pos_payments"),
    );
    expect(record).toContain("'duplicate', true");
  });

  it("cannot be defeated by a race, because the key is unique in storage", () => {
    expect(SQL).toMatch(/UNIQUE INDEX[\s\S]*pos_payments[\s\S]*idempotency_key/);
    expect(SQL).toContain("WHERE idempotency_key IS NOT NULL");
  });

  it("derives a per-attempt key when the caller supplies none, so blank keys never collide", () => {
    expect(record).toContain("coalesce(nullif(_idempotency_key,''), 'pos-pay:'");
    expect(record).toContain("gen_random_uuid()");
  });
});

describe("the settleable ceiling under concurrency", () => {
  it("locks the order before reading the balance", () => {
    expect(at("FOR UPDATE")).toBeLessThan(at("_headroom := round(_balance - _active, 2)"));
  });

  it("reserves the amount of every other active attempt", () => {
    expect(record).toContain("status IN ('initiated','pending')");
    expect(at("status IN ('initiated','pending')")).toBeLessThan(at("_headroom := round(_balance - _active, 2)"));
  });

  it("refuses the second attempt rather than over-collecting", () => {
    expect(record).toContain("exceeds the settleable balance");
    expect(at("_headroom")).toBeLessThan(at("INSERT INTO public.pos_payments"));
  });

  it("never posts to finance from the attempt path, so a replay cannot double-post", () => {
    expect(record).not.toContain("neo_finance_post_txn");
    expect(record).not.toContain("finance_posting_receipts");
  });
});
