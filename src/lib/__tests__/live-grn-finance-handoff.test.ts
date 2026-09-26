/**
 * Live contract: goods receipt → Finance handoff.
 *
 * A receipt that Stores has accepted must, in one atomic and idempotent step,
 * produce: an accrual journal that balances, exactly one immutable posting
 * receipt linked to that journal, one live canonical state row, and the three
 * durable handoff events (accepted → inventory recognised → finance posted).
 *
 * This is a read-only assertion against the connected project database. It
 * reads no secret and mutates nothing.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const HAS_SQL = Boolean(process.env["PGHOST"]);

function sql(query: string): string[][] {
  const out = execFileSync("psql", ["-At", "-F", "\u0001", "-c", query], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.split("\u0001"));
}

const ACCEPTED = "('received','accepted','completed','closed','posted')";

describe.skipIf(!HAS_SQL)("live goods receipt → Finance handoff", () => {
  it("every accepted receipt carries a posting receipt linked to a journal", () => {
    const rows = sql(`
      SELECT gr.grn_number
        FROM public.goods_receipts gr
       WHERE gr.reversed_at IS NULL
         AND gr.status IN ${ACCEPTED}
         AND COALESCE(gr.total_value, 0) > 0
         AND NOT EXISTS (
           SELECT 1 FROM public.finance_posting_receipts fr
            WHERE fr.source_id = gr.id AND fr.status = 'posted' AND fr.journal_id IS NOT NULL)`);
    expect(rows.flat()).toEqual([]);
  });

  it("each accrual journal balances against the recognised value", () => {
    const rows = sql(`
      SELECT gr.grn_number
        FROM public.goods_receipts gr
        JOIN public.journal_entries je ON je.id = gr.accrual_journal_id
       WHERE gr.reversed_at IS NULL
         AND (je.status <> 'posted'
              OR round(COALESCE(je.total_debit,0),2) <> round(COALESCE(je.total_credit,0),2)
              OR round(COALESCE(je.total_debit,0),2) <> round(COALESCE(gr.accrued_value,0),2))`);
    expect(rows.flat()).toEqual([]);
  });

  it("recognition is idempotent — one posting receipt and one live state per receipt", () => {
    const rows = sql(`
      SELECT gr.grn_number
        FROM public.goods_receipts gr
       WHERE gr.reversed_at IS NULL
         AND gr.status IN ${ACCEPTED}
         AND COALESCE(gr.total_value, 0) > 0
         AND ((SELECT count(*) FROM public.finance_posting_receipts fr
                WHERE fr.source_id = gr.id AND fr.status = 'posted') <> 1
           OR (SELECT count(*) FROM public.canonical_transaction_states c
                WHERE c.source_id = gr.id AND c.operational_state <> 'superseded') <> 1)`);
    expect(rows.flat()).toEqual([]);
  });

  it("the three durable handoff events exist exactly once each", () => {
    const rows = sql(`
      SELECT gr.grn_number, t.event_type
        FROM public.goods_receipts gr
        CROSS JOIN (VALUES ('grn.accepted'),('inventory.recognised'),('finance.posted')) AS t(event_type)
       WHERE gr.reversed_at IS NULL
         AND gr.status IN ${ACCEPTED}
         AND COALESCE(gr.total_value, 0) > 0
         AND (SELECT count(*) FROM public.domain_events de
               WHERE de.source_record_id = gr.id AND de.event_type = t.event_type) <> 1`);
    expect(rows.flat()).toEqual([]);
  });

  it("the canonical state names Finance as owner with the matching next action", () => {
    const rows = sql(`
      SELECT gr.grn_number
        FROM public.goods_receipts gr
        JOIN public.canonical_transaction_states c
          ON c.source_id = gr.id AND c.operational_state <> 'superseded'
       WHERE gr.reversed_at IS NULL
         AND gr.status IN ${ACCEPTED}
         AND COALESCE(gr.total_value, 0) > 0
         AND (c.financial_state <> 'posted'
              OR c.current_owner IS DISTINCT FROM 'Finance'
              OR c.next_action IS DISTINCT FROM 'Match against the supplier invoice'
              OR c.journal_id IS NULL OR c.receipt_id IS NULL)`);
    expect(rows.flat()).toEqual([]);
  });
});
