import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";
import { canonicalPermission } from "@/lib/permissions";

/**
 * Evidence for the POS settlement contract. The fixture is the SQL that was
 * deployed, so these assertions fail the moment the deployed rules drift.
 */
const SQL = readFileSync(
  join(process.cwd(), "src/lib/__tests__/fixtures/pos-settlement-menu.sql"),
  "utf8",
);

const fn = (name: string) => {
  const start = SQL.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} missing from fixture`).toBeGreaterThan(-1);
  const next = SQL.indexOf("CREATE OR REPLACE FUNCTION", start + 10);
  return SQL.slice(start, next === -1 ? undefined : next);
};

const record = fn("pos_record_payment_attempt");
const manual = fn("pos_confirm_manual_payment");
const reconcile = fn("pos_reconcile_order_settlement");
const engine = fn("pos_reconcile_settlement_internal");
const itemTrigger = fn("tg_pos_item_terminal_settlement");

describe("settlement authorization", () => {
  it("uses the canonical three-part manual-confirm capability, not a dotted legacy action", () => {
    expect(record).toContain("has_permission('pos','payments','manual-confirm')");
    expect(manual).toContain("has_permission('pos','payments','manual-confirm')");
    // The dotted spelling only survives in the one-off rename of the legacy row.
    expect(record).not.toContain("'payments.manual-confirm'");
    expect(manual).not.toContain("'payments.manual-confirm'");
    expect(SQL).toContain("action = 'manual-confirm'");
  });

  it("keeps the UI resolver compatible with the dotted spelling", () => {
    expect(canonicalPermission("pos", "payments.manual-confirm")).toEqual(
      canonicalPermission("pos", "payments", "manual-confirm"),
    );
  });

  it("requires payment authority before any attempt is written", () => {
    expect(record.indexOf("has_permission('pos','payments','process')")).toBeLessThan(
      record.indexOf("INSERT INTO public.pos_payments"),
    );
    expect(reconcile).toContain("has_permission('pos','payments','process')");
  });

  it("denies a same-organisation user acting outside their allowed properties", () => {
    for (const f of [record, manual, reconcile]) {
      expect(f).toContain("neo_branch_in_scope");
      expect(f).toContain("property outside your access");
    }
    // Organisation scope is still enforced alongside property scope.
    expect(record).toContain("organization_id = _org");
    expect(manual).toContain("organization_id = _org");
  });

  it("owner organisation-wide scope stays valid and technical scope mutates nothing", () => {
    const scope = fn("neo_branch_in_scope");
    expect(scope).toContain("WHEN 'organisation' THEN true");
    expect(scope).toContain("WHEN 'technical' THEN false");
  });

  it("never exposes the internal engine to signed-in users", () => {
    expect(SQL).toContain(
      "REVOKE ALL ON FUNCTION public.pos_reconcile_settlement_internal(uuid) FROM PUBLIC, anon, authenticated;",
    );
    expect(SQL).toContain(
      "GRANT EXECUTE ON FUNCTION public.pos_reconcile_settlement_internal(uuid) TO service_role;",
    );
  });

  it("registers every settlement entry point in the RPC manifest", () => {
    for (const name of [
      "pos_record_payment_attempt",
      "pos_confirm_manual_payment",
      "pos_reconcile_order_settlement",
    ]) {
      expect(RPC_MANIFEST[name]).toBe("authenticated");
    }
  });
});

describe("settlement correctness", () => {
  it("counts active initiated/pending attempts against the settleable ceiling", () => {
    expect(record).toContain("status IN ('initiated','pending')");
    expect(record).toContain("_headroom := round(_balance - _active, 2)");
    expect(record).toContain("exceeds the settleable balance");
  });

  it("returns the original payment for a repeated idempotency key without charging again", () => {
    expect(record.indexOf("WHERE organization_id = _org AND idempotency_key = _key")).toBeLessThan(
      record.indexOf("INSERT INTO public.pos_payments"),
    );
    expect(record).toContain("'duplicate', true");
  });

  it("requires a provider reference for every external method, including M-Pesa", () => {
    expect(record).toContain("_external := _method IN ('mpesa'");
    expect(record).toContain("A provider or external reference is required");
  });

  it("requires both a reference and a verification note to confirm manually", () => {
    expect(record).toContain("A verification note is required for a manually confirmed payment");
    expect(manual).toContain("A verification note is required for a manually confirmed payment");
    expect(manual).toContain("no provider reference, so it cannot be confirmed manually");
  });

  it("leaves unconfigured external attempts pending and never reinterprets them as paid", () => {
    expect(record).toContain("CASE WHEN _external THEN 'pending' ELSE 'confirmed' END");
    expect(manual).toContain("IF _p.status NOT IN ('initiated','pending')");
    expect(manual).toContain("would exceed the outstanding balance");
  });

  it("closes a fully paid bill only once every production item is terminal", () => {
    expect(engine).toContain("status NOT IN ('served','cancelled','voided')");
    expect(engine).toContain("_open_items = 0");
    expect(engine).toContain("SET status = 'closed'");
  });

  it("reconciles from the item side when the last item reaches a terminal state", () => {
    expect(itemTrigger).toContain("NEW.status NOT IN ('served','cancelled','voided')");
    expect(itemTrigger).toContain("IF _open > 0 THEN RETURN NEW; END IF;");
    expect(itemTrigger).toContain("pos_reconcile_settlement_internal");
    expect(SQL).toContain("AFTER UPDATE OF status ON public.pos_order_items");
  });

  it("emits no second finance path: closure only moves order state, handoff stays with the existing trigger", () => {
    for (const f of [engine, record, manual, reconcile, itemTrigger]) {
      expect(f).not.toContain("neo_finance_post_txn");
      expect(f).not.toContain("finance_posting_receipts");
      expect(f).not.toContain("outbox");
    }
  });

  it("guards against a runaway loop by writing only to the order from the item trigger", () => {
    expect(itemTrigger).not.toContain("UPDATE public.pos_order_items");
  });
});
