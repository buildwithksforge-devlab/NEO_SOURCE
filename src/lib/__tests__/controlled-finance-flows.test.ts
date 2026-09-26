import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

const migration = read(
  "supabase/migrations/20260924090000_finish_controlled_finance_flows.sql",
);
const till = read("src/routes/_shell.finance.till.tsx");
const eod = read("src/routes/_shell.finance.eod.tsx");
const payables = read("src/routes/_shell.finance.payables.tsx");
const posOrder = read("src/routes/_shell.pos.orders.$id.tsx");
const manifest = read("src/lib/rpc-manifest.ts");

describe("supplier payment production lifecycle", () => {
  it("allows every state used by the real payment conveyor and mirrors schedule settlement", () => {
    expect(migration).toContain(
      "'draft','scheduled','pending','awaiting-approval','approved','released','paid','failed','cancelled','reversed'",
    );
    expect(migration).toContain(
      "'draft','scheduled','pending','pending_approval','approved','released','paid','failed','cancelled'",
    );
    expect(migration).toContain("SET status='paid', updated_at=now()");
  });

  it("does not release an invoice payment across suppliers, matching holds or its outstanding balance", () => {
    expect(migration).toContain("The linked invoice belongs to a different supplier");
    expect(migration).toContain("held by matching and cannot be paid");
    expect(migration).toContain("Accept and post the supplier invoice before releasing payment");
    expect(migration).toContain("only % remains outstanding on invoice %");
    expect(migration).toContain("sp.status IN ('released','paid')");
    expect(migration).toContain("paid_amount = round(_paid,2)");
    expect(migration).toContain("status = CASE WHEN _paid >= round(coalesce(amount,0),2) - 0.009 THEN 'paid' ELSE 'partially_paid' END");
  });

  it("keeps maker and releaser separate and captures the real bank evidence", () => {
    expect(migration).toContain("A payment cannot be released by the person who scheduled it");
    expect(migration).toContain("coalesce(s.created_by, auth.uid()), auth.uid(), now()");
    expect(migration).toContain("Enter the bank transfer or cheque reference for this payment");
    expect(payables).toContain('"pending_approval"');
  });
});

describe("cash refund production lifecycle", () => {
  it("makes refund an allowed audit movement without double-reducing expected cash", () => {
    expect(migration).toMatch(/cash_movements_type_chk[\s\S]*?'refund'/);
    expect(migration).toContain("'cash-refund:' || _r.id::text");
    expect(migration).toContain("Audit-only movement. Do not increment paid-outs");
    expect(migration).toContain("(_org, _s.id, 'refund', round(_r.amount,2)");
  });

  it("requires an open same-property till with enough expected cash", () => {
    expect(migration).toContain("Open your till before paying out a cash refund");
    expect(migration).toContain("Open a till at the same property as the refund before paying it out");
    expect(migration).toContain("This till holds % expected cash but the refund requires %");
  });

  it("does not mark a partially refunded POS payment fully refunded", () => {
    expect(migration).toContain("_settled_against_pos >= _original_pos_amount - 0.009");
    expect(migration).toContain("UPDATE public.pos_payments SET status='refunded'");
  });

  it("pairs refund settlement with a positive contra-journal contract", () => {
    const refundJournal = read("supabase/migrations/20260924141500_refund_payment_journal_sign_guard.sql");
    expect(refundJournal).toContain("amount := abs(amount)");
    expect(refundJournal).toContain("Refund / contra collection");
    expect(refundJournal).toContain("'1060', 'debit', amount");
  });

  it("allows only the controlled full-refund transition out of a confirmed POS payment", () => {
    const transition = read("supabase/migrations/20260924143000_cash_refund_confirmed_transition_guard.sql");
    expect(transition).toContain("NEW.status = 'refunded'");
    expect(transition).toContain("r.status = 'settled'");
    expect(transition).toContain("_settled >= abs(COALESCE(OLD.amount,0)) - 0.009");
    expect(transition.indexOf("SET status='settled'")).toBeLessThan(
      transition.indexOf("UPDATE public.pos_payments SET status='refunded'"),
    );
  });

});

describe("counted-cash shift close", () => {
  it("uses canonical movement names in the screen and backend", () => {
    expect(till).toContain('const MOVEMENT_TYPES = ["drop", "paid-out", "float-top-up"]');
    expect(migration).toContain("replace(lower(btrim(coalesce(_type,''))), '_', '-')");
  });

  it("uses the canonical Cashier finance.till capabilities at the server boundary", () => {
    expect(migration).toContain("has_permission('finance','till','edit')");
    expect(migration).toContain("has_permission('finance','till','create')");
    expect(migration).toContain("has_permission('finance','till','close')");
  });

  it("requires a physical count and sends a real variance for independent review", () => {
    expect(migration).toContain("Counted cash is required and cannot be negative");
    expect(migration).toContain("A cashier may only close their own till");
    expect(migration).toContain("'count', _count");
    expect(migration).toContain("'variance-review'");
    expect(migration).toContain("'cash-variance'");
  });

  it("admits all live shift review states at the database boundary", () => {
    expect(migration).toContain(
      "'open','pending-closure','closed','variance-review','pending-review','reopened','disputed'",
    );
  });
});

describe("explicit business-day lifecycle", () => {
  it("registers and exposes the explicit open RPC", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.neo_open_business_day");
    expect(manifest).toContain('neo_open_business_day: "authenticated"');
    expect(eod).toContain("useOpenBusinessDay");
  });

  it("will not close an unopened day or reopen a closed date", () => {
    expect(migration).toContain("'status','not_open'");
    expect(migration).toContain("is already closed and cannot be reopened");
    expect(migration).toContain("Close the currently open business day before opening another one");
  });

  it("serialises each property's business calendar and requires a signed audit before close", () => {
    expect(migration).toContain("'business-day:' || _org::text || ':' || _branch::text");
    expect(migration).toContain("_a.stage<>'signed'");
    expect(migration).toContain("Reconciliation is unresolved");
  });

  it("refuses EOD while tills, POS orders, rider cash or refunds are unresolved", () => {
    expect(migration).toContain("coalesce(s.status,'open') <> 'closed'");
    expect(migration).toContain("NOT IN ('closed','cancelled','voided','charged-to-room','credit')");
    expect(migration).toContain("r.status <> 'reconciled'");
    expect(migration).toContain("r.status IN ('pending_approval','approved')");
    expect(migration).toContain("Close tills and orders, reconcile rider cash");
  });
});

describe("real discount authority", () => {
  it("enforces the 15 percent Operations Manager ceiling on the server", () => {
    expect(migration).toContain("_effective_percent > 15.0000");
    expect(migration).toContain("public.neo_user_has_role_key('owner')");
    expect(migration).toContain("public.neo_user_has_role_key('operations-manager')");
    expect(migration).toContain("Discounts above 15 percent require Owner approval");
    expect(migration).toContain("Operations Manager (up to 15 percent) or Owner");
  });

  it("honours configured branch/date/time/order policy boundaries before applying the discount", () => {
    expect(migration).toContain("d.branch_id IS NOT NULL AND d.branch_id <> o.branch_id");
    expect(migration).toContain("d.valid_from IS NOT NULL");
    expect(migration).toContain("d.valid_time_from IS NOT NULL");
    expect(migration).toContain("o.order_type = ANY (d.order_types)");
  });

  it("requires the approval reason in the UI and keeps the user-facing ceiling visible", () => {
    expect(posOrder).toContain("policy.requires_approval");
    expect(posOrder).toContain("Operations Manager approval is capped");
    expect(migration).toContain("Enter the Owner approval reason for this discount");
  });

  it("gives Operations Manager the base execute/approve capabilities needed to reach the <=15% server ceiling", () => {
    const roleTemplates = read("src/lib/role-templates.ts");
    const backfill = read("supabase/migrations/20260924144500_operations_manager_discount_capability.sql");
    expect(roleTemplates).toContain('action: "discount.execute"');
    expect(roleTemplates).toContain('action: "discount.approve"');
    expect(backfill).toContain("discount.execute");
    expect(backfill).toContain("operations-manager");
  });
});
