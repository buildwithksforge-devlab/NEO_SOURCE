import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const payment = readFileSync(
  "supabase/migrations/20261126026000_payment_settlement_evidence.sql",
  "utf8",
);

const inventory = readFileSync(
  "supabase/migrations/20261125234000_inventory_controlled_accounting_recovery.sql",
  "utf8",
);

describe("core operational and financial integration contracts", () => {
  it("validates payment amounts before mutation", () => {
    expect(payment).toContain("neo_core_payment_amount_guard_v1");
    expect(payment).toContain("_amount <> round(_amount,2)");
    expect(payment).toContain("_amount <= 0");
  });

  it("rejects nonfinite monetary inputs", () => {
    expect(payment).toContain(
      "_amount::text IN ('NaN','Infinity','-Infinity')",
    );
    expect(payment).toContain(
      "_tendered::text IN ('NaN','Infinity','-Infinity')",
    );
  });

  it("rejects insufficient supplied cash tender", () => {
    expect(payment).toContain("_tendered < _amount");
  });

  it("retains existing payment identity", () => {
    expect(payment).toContain("IF _key IS NULL THEN");
  });

  it("preserves receipt numbers and generates missing identities", () => {
    expect(payment).toContain("neo_core_manual_receipt_identity_v1");
    expect(payment).toContain("nullif(btrim(receipt_number),'')");
    expect(payment).toContain("public.next_document_number('receipt')");
  });

  it("does not replace canonical settlement execution", () => {
    expect(payment).toContain(
      "public.pos_confirm_manual_payment(uuid,text)",
    );
    expect(payment).toContain(
      "public.pos_record_payment_attempt(uuid,numeric,text,numeric,text,uuid,text,boolean,text,uuid)",
    );
  });

  it("excludes cancelled and unsent items from completion deductions", () => {
    expect(inventory).toContain(
      "NOT IN (''voided'',''cancelled'',''draft'',''cancel-pending'')",
    );
  });

  it("preserves nested inventory posting context", () => {
    expect(inventory).toContain("neo_preserve_inventory_context_v1");
    expect(inventory).toContain(
      "current_setting('neo.system_posting',true)",
    );
    expect(inventory).toContain(
      "set_config(''neo.system_posting'', v_prior_posting, true)",
    );
  });
});
