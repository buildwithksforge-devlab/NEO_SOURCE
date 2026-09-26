/**
 * Rider notification audit and goods-receipt acceptance contract.
 *
 * The deployed routines are exported verbatim into
 * `fixtures/delivery-notify-grn.sql`, so these assertions run against what the
 * database actually executes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(join(process.cwd(), "src/lib/__tests__/fixtures/delivery-notify-grn.sql"), "utf8");

const fn = (name: string) => {
  const start = SQL.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} missing from fixture`).toBeGreaterThan(-1);
  const next = SQL.indexOf("CREATE OR REPLACE FUNCTION", start + 10);
  return SQL.slice(start, next === -1 ? undefined : next);
};

const notify = fn("neo_delivery_rider_notify");
const audit = fn("neo_delivery_notification_audit");
const assign = fn("neo_delivery_assign");
const receive = fn("neo_stores_receive_goods");
const guard = fn("neo_grn_guard_over_receipt");

describe("rider notifications are idempotent and audited", () => {
  it("suppresses a repeat notice instead of sending it twice", () => {
    expect(notify).toContain("ON CONFLICT DO NOTHING");
    expect(notify).toContain("RETURNING id INTO _id");
  });

  it("records every attempt, including the suppressed one, with its key", () => {
    expect(notify).toContain("INSERT INTO public.rider_notification_events");
    expect(notify).toContain("_idem, _id IS NULL");
    expect(notify).toContain("actor_id");
  });

  it("never notifies a rider who has no account behind the profile", () => {
    expect(notify).toContain("IF _r.profile_id IS NULL THEN RETURN");
  });
});

describe("assignment and reassignment flow through the audited path", () => {
  it("sends both the new-rider and the losing-rider notice through the helper", () => {
    expect(assign).toContain("public.neo_delivery_rider_notify");
    expect(assign.match(/neo_delivery_rider_notify/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("writes no notification row directly, so nothing escapes the audit", () => {
    expect(assign).not.toContain("INSERT INTO public.notifications");
  });

  it("keeps stable keys so a retried assignment cannot double-notify", () => {
    expect(assign).toContain("'delivery.assign:' || _order::text || ':' || _rider::text");
    expect(assign).toContain("'delivery.unassign:' || _order::text");
  });

  it("still refuses a reassignment without a written reason", () => {
    expect(assign).toContain("'reason_required'");
    expect(assign).toContain("Reassigning an order requires a written reason.");
  });

  it("still checks eligibility and property scope before assigning", () => {
    expect(assign).toContain("neo_delivery_dispatch_candidates");
    expect(assign).toContain("neo_branch_in_scope");
    expect(assign).toContain("delivery','dispatch.assign");
  });
});

describe("dispatcher notification audit", () => {
  it("requires dispatch or rider-management authority", () => {
    expect(audit).toContain("has_permission('delivery','dispatch.view')");
    expect(audit).toContain("has_permission('delivery','riders.manage')");
    expect(audit).toContain("insufficient_privilege");
  });

  it("is organisation and property scoped", () => {
    expect(audit).toContain("e.organization_id = _org");
    expect(audit).toContain("public.neo_branch_in_scope(e.branch_id)");
  });

  it("returns who was notified, about what, by whom and whether it was suppressed", () => {
    for (const field of ["rider_name", "order_number", "actor_name", "idempotency_key", "duplicate_suppressed"]) {
      expect(audit).toContain(field);
    }
  });
});

describe("goods receipt accepts, rejects and posts only what was accepted", () => {
  it("splits delivered quantity into accepted, rejected and damaged", () => {
    expect(receive).toContain("quantity_rejected");
    expect(receive).toContain("quantity_damaged");
    expect(receive).toContain("GREATEST(_qty - COALESCE((_line->>'quantity_rejected')::numeric,0)");
  });

  it("stores the rejection reason on the line", () => {
    expect(receive).toContain("rejection_reason");
  });

  it("records the supplier's own paperwork references", () => {
    expect(receive).toContain("delivery_note_number");
    expect(receive).toContain("supplier_invoice_number");
  });

  it("still supports partial receipts against an open order", () => {
    expect(receive).toContain("partially-received");
    expect(receive).toContain("is_partial");
  });

  it("is exactly-once through the attempt key", () => {
    expect(receive).toContain("attempt_key_required");
    expect(receive).toContain("'replayed', true");
    expect(receive).toContain("pg_advisory_xact_lock");
  });

  it("refuses an over-receipt with no line reason", () => {
    expect(receive).toContain("over_receipt_refused");
  });
});

describe("over-receipt authority is decided in the database", () => {
  it("needs both a written reason and the override capability", () => {
    expect(guard).toContain("over_receipt_refused");
    expect(guard).toContain("has_permission('procurement','receiving.override')");
    expect(guard).toContain("over_receipt_not_authorised");
  });

  it("stamps the authoriser and writes an audit entry", () => {
    expect(guard).toContain("NEW.over_receipt_authorised_by := auth.uid()");
    expect(guard).toContain("INSERT INTO public.audit_logs");
    expect(guard).toContain("receipt.over_receipt");
  });
});
