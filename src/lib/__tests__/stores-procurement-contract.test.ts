/**
 * Stores ↔ Procurement production contract.
 *
 * The deployed routines are exported verbatim into
 * `fixtures/stores-procurement.sql`, so these assertions run against what the
 * database actually executes rather than a description of it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROCUREMENT_LABELS } from "@/lib/ops-reconciliation";
import { ROUTE_CAPABILITIES } from "@/lib/capabilities";
import { ROLE_FEATURE_TEMPLATES } from "@/lib/role-templates";
import { RPC_MANIFEST } from "@/lib/rpc-manifest";
import { outstandingOf } from "@/lib/stores-lifecycle";

const SQL = readFileSync(join(process.cwd(), "src/lib/__tests__/fixtures/stores-procurement.sql"), "utf8");

const fn = (name: string) => {
  const start = SQL.indexOf(`FUNCTION public.${name}(`);
  expect(start, `${name} missing from fixture`).toBeGreaterThan(-1);
  const next = SQL.indexOf("CREATE OR REPLACE FUNCTION", start + 10);
  return SQL.slice(start, next === -1 ? undefined : next);
};

const submit = fn("neo_procurement_request_submit");
const decide = fn("neo_procurement_request_decide");
const convert = fn("neo_procurement_order_from_request");
const approveOrder = fn("neo_procurement_order_approve");
const receive = fn("neo_stores_receive_goods");
const issue = fn("neo_stores_issue");
const lowStock = fn("neo_stores_low_stock_scan");
const reconcile = fn("neo_procurement_reconciliation");
const overReceiptGuard = fn("neo_grn_guard_over_receipt");
const postReceipt = fn("inventory_post_receipt");
const consume = fn("inventory_consume_order_item");

const WRITE_ROUTINES = { submit, convert, receive, issue } as const;

describe("requisition to purchase order lifecycle", () => {
  it("refuses to submit a requisition that is not a draft or a returned one", () => {
    expect(submit).toContain("request_not_submittable");
    expect(submit).toContain("IN ('draft','rejected')");
  });

  it("refuses an empty requisition", () => {
    expect(submit).toContain("request_has_no_lines");
  });

  it("only an approval capability decides, and never on one's own request", () => {
    expect(decide).toContain("has_permission('procurement','requests.approve')");
    expect(decide).toContain("self_approval_refused");
    expect(decide).toContain("reason_required");
  });

  it("converts only approved requisitions, once, against a known supplier", () => {
    expect(convert).toContain("request_not_approved");
    expect(convert).toContain("request_already_ordered");
    expect(convert).toContain("supplier_not_approved");
    expect(convert).toContain("pg_advisory_xact_lock");
    expect(convert).toContain("next_document_number('purchase_order','LPO'");
  });

  it("order approval is its own capability and is written to the audit trail", () => {
    expect(approveOrder).toContain("has_permission('procurement','lpos.approve')");
    expect(approveOrder).toContain("INSERT INTO public.audit_logs");
  });
});

describe("exactly-once submissions", () => {
  it("every write routine demands an attempt key and replays a repeat", () => {
    for (const [name, body] of Object.entries(WRITE_ROUTINES)) {
      expect(body, `${name} must demand an attempt key`).toContain("attempt_key_required");
      expect(body, `${name} must replay a repeated submission`).toContain("'replayed', true");
      expect(body, `${name} must record the attempt`).toContain("INSERT INTO public.procurement_attempts");
    }
  });

  it("serialises concurrent receiving of the same order", () => {
    expect(receive).toContain("pg_advisory_xact_lock");
  });

  it("store issues key every ledger line to the submission and its line number", () => {
    expect(issue).toContain("'store:'||lower(_direction)||':'||_attempt::text||':'||_idx::text");
  });

  it("receiving posts the ledger through the one costing routine", () => {
    expect(receive).toContain("public.inventory_post_receipt(_grn)");
    expect(receive).not.toContain("INSERT INTO public.stock_movements");
    expect(postReceipt).toContain("'grn:' || _receipt::text || ':' || l.id::text");
  });

  it("POS consumption stays keyed to its source order item", () => {
    expect(consume).toContain("idempotency_key");
  });
});

describe("receiving controls", () => {
  it("accepts partial deliveries and flags them", () => {
    expect(receive).toContain("_partial");
    expect(receive).toContain("'partial',_partial");
  });

  it("refuses to receive above the outstanding quantity without a reason", () => {
    expect(receive).toContain("over_receipt_refused");
    expect(overReceiptGuard).toContain("over_receipt_refused");
  });

  it("treats over-receipt as its own authority, not merely a typed reason", () => {
    expect(overReceiptGuard).toContain("has_permission('procurement','receiving.override')");
    expect(overReceiptGuard).toContain("over_receipt_not_authorised");
    expect(overReceiptGuard).toContain("INSERT INTO public.audit_logs");
  });

  it("receiving is a custody capability, not a purchasing one", () => {
    expect(receive).toContain("has_permission('procurement','receiving.manage')");
    expect(receive).not.toContain("lpos.approve");
  });

  it("refuses a delivery with no live store location", () => {
    expect(receive).toContain("store_location_required");
    expect(receive).toContain("order_not_receivable");
  });
});

describe("issues and returns", () => {
  it("requires a store capability, a reason and a valid direction", () => {
    expect(issue).toContain("has_permission('stores','issues.create')");
    expect(issue).toContain("reason_required");
    expect(issue).toContain("invalid_direction");
  });

  it("issues leave the store and returns come back in", () => {
    expect(issue).toContain("CASE WHEN lower(_direction)='issue' THEN -1 ELSE 1 END");
  });
});

describe("scope and privilege", () => {
  it("every routine works inside the caller's organisation and property scope", () => {
    for (const [name, body] of Object.entries({ ...WRITE_ROUTINES, decide, approveOrder, lowStock, reconcile })) {
      expect(body, `${name} must resolve the organisation`).toContain("public.current_org_id()");
      expect(body, `${name} must honour property scope`).toContain("public.neo_branch_in_scope");
    }
  });

  it("declares every new routine on the callable surface", () => {
    for (const name of [
      "neo_procurement_request_submit",
      "neo_procurement_request_decide",
      "neo_procurement_order_from_request",
      "neo_procurement_order_approve",
      "neo_stores_receive_goods",
      "neo_stores_issue",
      "neo_stores_low_stock_scan",
    ]) {
      expect(RPC_MANIFEST[name], `${name} missing from the manifest`).toBe("authenticated");
    }
  });
});

describe("low stock and reconciliation", () => {
  it("alerts only staff who may actually raise a requisition, once a day per item", () => {
    expect(lowStock).toContain("p.module='procurement'");
    expect(lowStock).toContain("p.action='create'");
    expect(lowStock).toContain("'lowstock:'||_row.id::text");
  });

  it("reports every class of exception the interface labels", () => {
    for (const key of Object.keys(PROCUREMENT_LABELS)) {
      expect(reconcile, `${key} missing from the reconciliation report`).toContain(`'${key}'`);
    }
  });

  it("counts drift and duplicate sources against health", () => {
    expect(reconcile).toContain("HAVING count(*) > 1");
    expect(reconcile).toContain("jsonb_array_length(_drift) = 0");
  });
});

describe("role separation in the interface", () => {
  const features = (role: string) => ROLE_FEATURE_TEMPLATES[role] ?? [];

  it("the buyer never receives goods", () => {
    expect(features("procurement-manager")).not.toContain("procurement.receiving");
    expect(features("procurement-officer")).not.toContain("procurement.receiving");
  });

  it("the store keeper never approves purchasing paperwork", () => {
    expect(features("storekeeper")).not.toContain("procurement.lpos");
    expect(features("storekeeper")).toContain("procurement.receiving");
    expect(features("storekeeper")).toContain("stores.issues");
  });

  it("the receiving clerk holds receiving only", () => {
    expect(features("receiving-clerk")).toEqual(["stores.overview", "procurement.receiving"]);
  });

  it("every new screen resolves to a registered capability", () => {
    const prefixes = ROUTE_CAPABILITIES.map((e) => e.prefix);
    for (const route of ["/procurement/requests", "/inventory/receiving", "/inventory/issues"]) {
      expect(prefixes, `${route} is unmapped`).toContain(route);
    }
  });
});

describe("outstanding quantity helper", () => {
  it("nets cancelled and already-received quantities off the order", () => {
    expect(outstandingOf({ quantity: 10, received_quantity: 4, cancelled_quantity: 1 })).toBe(5);
  });

  it("never goes negative after an over-receipt", () => {
    expect(outstandingOf({ quantity: 10, received_quantity: 12 })).toBe(0);
  });
});
