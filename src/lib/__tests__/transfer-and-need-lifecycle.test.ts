import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";

const migrations = (() => {
  const dir = resolve(process.cwd(), "supabase/migrations");
  return readdirSync(dir)
    .map((f) => readFileSync(resolve(dir, f), "utf8"))
    .join("\n");
})();

const transfers = readFileSync(resolve(process.cwd(), "src/lib/stock-transfers.ts"), "utf8");
const needs = readFileSync(resolve(process.cwd(), "src/lib/stock-need-lifecycle.ts"), "utf8");

describe("store transfer is its own transaction type", () => {
  it("dispatches and receives through dedicated canonical routines", () => {
    expect(transfers).toContain("neo_stores_transfer_create");
    expect(transfers).toContain("neo_stores_transfer_receive");
    expect(transfers).toContain("neo_stores_transfer_cancel");
  });

  it("never records a transfer as a usage or waste movement", () => {
    expect(transfers).not.toContain("inventory_apply_movement");
    expect(transfers).not.toMatch(/"(usage|wastage|waste)"/i);
  });

  it("carries one attempt key per submission so a retry cannot double-post", () => {
    expect(transfers).toContain("newTransferAttemptKey");
    expect(transfers).toContain("_attempt: input.attemptKey");
  });

  it("posts the source out and the destination in as separate ledger effects", () => {
    expect(migrations).toContain("'transfer-out'");
    expect(migrations).toContain("'transfer-in'");
  });
});

describe("stock need lifecycle", () => {
  it("can be issued in full or in part, or routed to procurement", () => {
    expect(needs).toContain("neo_stock_need_fulfil");
    expect(needs).toContain("neo_stock_need_to_procurement");
    expect(needs).toContain("neo_stock_need_link_item");
  });

  it("keeps the lineage from need to purchase request", () => {
    expect(needs).toContain("purchase_request_id");
    expect(needs).toContain("purchase_requests(request_number, status)");
  });

  it("reports a reused procurement request instead of raising a second one", () => {
    expect(needs).toContain('data["duplicate"] === true');
  });
});

describe("callable surface", () => {
  it("declares every new routine as staff-only", () => {
    for (const name of [
      "neo_stores_transfer_create",
      "neo_stores_transfer_receive",
      "neo_stores_transfer_cancel",
      "neo_stock_need_link_item",
      "neo_stock_need_fulfil",
      "neo_stock_need_to_procurement",
    ]) {
      expect(RPC_MANIFEST[name]).toBe("authenticated");
    }
  });
});
