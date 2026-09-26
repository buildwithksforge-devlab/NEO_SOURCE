import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/20260924141500_refund_payment_journal_sign_guard.sql"),
  "utf8",
);

describe("refund journal sign guard", () => {
  it("posts confirmed negative payments as positive contra journal lines", () => {
    expect(sql).toContain("CASE WHEN amount < 0 THEN 'refund' ELSE 'collection' END");
    expect(sql).toContain("amount := abs(amount)");
    expect(sql).toContain("'1060', 'debit', amount");
    expect(sql).toContain("'credit', amount");
    expect(sql).toContain("Refund / contra collection");
  });

  it("never relies on a negative debit/credit in the refund branch", () => {
    const branch = sql.split("ELSIF _source_type = 'folio_payment' THEN")[1]
      ?.split("ELSIF _source_type = 'event_deposit' THEN")[0] ?? "";
    expect(branch).toContain("IF amount > 0 THEN");
    expect(branch).toContain("ELSE");
    expect(branch).toContain("amount := abs(amount)");
  });
});
