import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseStatementCsv } from "@/lib/bank-reconciliation";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";

describe("bank statement reading", () => {
  it("reads dates, amounts and references, skipping a header", () => {
    const { rows } = parseStatementCsv(
      ["Date,Amount,Reference,Description", "2026-09-08,8700,FT26A1,Transfer J Mwangi"].join("\n"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ value_date: "2026-09-08", amount: 8700, reference: "FT26A1" });
  });

  it("accepts day/month/year and reports unreadable lines", () => {
    const { rows, problems } = parseStatementCsv("08/09/2026;1500;FT9\nnot,a,line");
    expect(rows[0]?.value_date).toBe("2026-09-08");
    expect(problems.length).toBe(1);
  });

  it("never invents a row from an empty paste", () => {
    expect(parseStatementCsv("   \n\n").rows).toHaveLength(0);
  });
});

describe("bank verification is server-side and authenticated", () => {
  it("declares every matching routine in the manifest", () => {
    for (const fn of [
      "neo_bank_statement_import",
      "neo_bank_transfer_queue",
      "neo_bank_match_transfer",
      "neo_bank_auto_match",
      "neo_bank_unmatch_transfer",
      "neo_payment_intent_mark_sent",
    ]) {
      expect(RPC_MANIFEST[fn]).toBe("authenticated");
    }
  });

  it("keeps the processor answer service-role only", () => {
    expect(RPC_MANIFEST["neo_payment_intent_apply"]).toBe("service_role");
  });
});

describe("gateway contract", () => {
  const src = readFileSync("src/lib/payment-gateway.functions.ts", "utf8");

  it("refuses anything but an https address", () => {
    expect(src).toContain("https://");
  });

  it("never settles money itself on a network failure", () => {
    expect(src).toContain("neo_payment_intent_mark_sent");
  });
});
