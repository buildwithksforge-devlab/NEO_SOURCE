import { describe, expect, it } from "vitest";
import { EXPORT_COLUMNS, rangeFor, reconciliationCsv, type ExportRow } from "@/lib/finance-posting";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";
import { capabilityForPath } from "@/lib/capabilities";

const row: ExportRow = {
  property: "Zawadi Springs",
  currency: "KES",
  stream: "POS, food & beverage",
  operational_eligible: 1200,
  posted: 1200,
  reversals: 0,
  net_recognised: 1200,
  collected: 900,
  outstanding_receivable: 300,
  unmatched_records: 0,
  period_from: "2026-01-01",
  period_to: "2026-01-31",
};

describe("reconciliation export", () => {
  it("emits the full operational → outstanding column set", () => {
    const csv = reconciliationCsv([row]);
    expect(csv.split("\n")[0]).toBe(EXPORT_COLUMNS.join(","));
    const line = csv.split("\n")[1] ?? "";
    let quoted = false;
    let cells = 1;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === "," && !quoted) cells += 1;
    }
    expect(cells).toBe(EXPORT_COLUMNS.length);
  });

  it("quotes values containing separators so streams never split a column", () => {
    expect(reconciliationCsv([row])).toContain('"POS, food & beverage"');
  });

  it("returns only the header when there is nothing to reconcile", () => {
    expect(reconciliationCsv([])).toBe(EXPORT_COLUMNS.join(","));
  });
});

describe("reporting ranges", () => {
  it("returns a single day for today", () => {
    const r = rangeFor("today");
    expect(r.from).toBe(r.to);
  });

  it("starts the week on Monday and never runs into the future", () => {
    const r = rangeFor("week");
    expect(new Date(r.from).getTime()).toBeLessThanOrEqual(new Date(r.to).getTime());
    expect(new Date(r.from).getUTCDay()).toBe(1);
  });

  it("starts the month on the first", () => {
    expect(rangeFor("month").from.slice(8)).toBe("01");
  });

  it("honours a custom range and falls back to the month when it is incomplete", () => {
    expect(rangeFor("custom", { from: "2026-02-01", to: "2026-02-10" })).toEqual({
      from: "2026-02-01",
      to: "2026-02-10",
    });
    expect(rangeFor("custom", { from: "", to: "" }).from.slice(8)).toBe("01");
  });
});

describe("posting surface contract", () => {
  it("declares every posting routine in the callable manifest", () => {
    for (const fn of [
      "neo_finance_posting_queue",
      "neo_finance_post_family",
      "neo_finance_post_eligible",
      "neo_posting_receipts",
      "neo_eligibility_drilldown",
      "neo_reconciliation_export",
    ]) {
      expect(RPC_MANIFEST[fn]).toBe("authenticated");
    }
  });

  it("gates the posting workflow behind a finance edit capability", () => {
    const cap = capabilityForPath("/finance/posting");
    expect(cap).toBeTruthy();
    expect(cap?.module).toBe("finance");
    expect(cap?.action).toBe("edit");
  });
});
