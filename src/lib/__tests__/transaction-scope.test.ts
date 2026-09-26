// @vitest-environment jsdom
/**
 * Canonical scope, retry safety and the durable-handoff contract.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  REPORTING_SCOPE_MESSAGE,
  assertSameProperty,
  resolveTransactionScope,
  scopeColumns,
  stableIdempotencyKey,
  type TransactionScope,
} from "@/lib/transaction-scope";
import {
  HANDOFFS,
  classifyHandoff,
  describeHandoff,
  missingRequiredFields,
  outboxHealth,
  outboxPhase,
} from "@/lib/outbox-contract";
import {
  clearPropertySelection,
  readPropertySelection,
  writePropertySelection,
} from "@/lib/property-selection";

const base: Parameters<typeof resolveTransactionScope>[0] = {
  organizationId: "org-1",
  activeBranchId: "prop-a",
  permittedBranchIds: ["prop-a", "prop-b"],
  sourceModule: "pos",
  action: "order.send",
  actorId: "user-1",
  actorName: "Amina",
  currency: "kes",
  identity: ["order-9"],
};

describe("canonical transaction scope", () => {
  it("carries every immutable fact a transaction needs", () => {
    const result = resolveTransactionScope(base);
    expect(result.ok).toBe(true);
    const scope = (result as { scope: TransactionScope }).scope;
    expect(scope.organizationId).toBe("org-1");
    expect(scope.propertyId).toBe("prop-a");
    expect(scope.sourceModule).toBe("pos");
    expect(scope.actorId).toBe("user-1");
    expect(scope.status).toBe("requested");
    expect(scope.currency).toBe("KES"); // normalised, never as typed
    expect(scope.transactionId).toContain("pos-");
    expect(scope.idempotencyKey.startsWith("pos:order.send:")).toBe(true);
  });

  it("treats All Properties as reporting-only and blocks the write", () => {
    const result = resolveTransactionScope({ ...base, activeBranchId: "all" });
    expect(result.ok).toBe(false);
    const blocked = (result as { outcome: { status: string; reason?: string; message: string } })
      .outcome;
    expect(blocked.status).toBe("blocked");
    expect(blocked.reason).toBe("reporting-scope");
    expect(blocked.message).toBe(REPORTING_SCOPE_MESSAGE);
  });

  it("blocks, with a distinct reason, every other missing fact", () => {
    const reason = (input: Partial<typeof base>) => {
      const r = resolveTransactionScope({ ...base, ...input });
      return r.ok ? null : r.outcome.reason;
    };
    expect(reason({ organizationId: null })).toBe("no-organisation");
    expect(reason({ activeBranchId: null })).toBe("no-property");
    expect(reason({ activeBranchId: "prop-z" })).toBe("property-not-permitted");
    expect(reason({ actorId: "  " })).toBe("no-actor");
    expect(reason({ currency: "" })).toBe("no-currency");
  });

  it("does not block on the permitted list before it has loaded", () => {
    // An empty list means "not known yet"; the backend still decides.
    expect(resolveTransactionScope({ ...base, permittedBranchIds: [] }).ok).toBe(true);
  });

  it("gives the same idempotency key to the same command and different keys to different ones", () => {
    const first = resolveTransactionScope(base);
    const again = resolveTransactionScope({ ...base, actorName: "Amina Y" });
    const other = resolveTransactionScope({ ...base, identity: ["order-10"] });
    const otherProperty = resolveTransactionScope({ ...base, activeBranchId: "prop-b" });
    const key = (r: typeof first) => (r.ok ? r.scope.idempotencyKey : "");
    expect(key(again)).toBe(key(first)); // a cosmetic difference is the same command
    expect(key(other)).not.toBe(key(first));
    expect(key(otherProperty)).not.toBe(key(first));
    expect(key(first)).toBe(key(resolveTransactionScope(base))); // stable across calls
  });

  it("ignores case and padding when deciding whether two commands are the same", () => {
    expect(stableIdempotencyKey("pos", "send", [" A ", 2])).toBe(
      stableIdempotencyKey("pos", "send", ["a", "2"]),
    );
    expect(stableIdempotencyKey("pos", "send", ["a"])).not.toBe(
      stableIdempotencyKey("pos", "void", ["a"]),
    );
  });

  it("writes organisation, property and currency from the scope, never from a form", () => {
    const r = resolveTransactionScope(base);
    expect(r.ok && scopeColumns(r.scope)).toEqual({
      organization_id: "org-1",
      branch_id: "prop-a",
      currency: "KES",
    });
  });

  it("refuses a transaction that would mix properties, naming the offending record", () => {
    const scope = (resolveTransactionScope(base) as { scope: TransactionScope }).scope;
    expect(
      assertSameProperty(scope, [
        { label: "Room 307", branchId: "prop-a" },
        { label: "Tusker 500ml", branchId: null }, // organisation-wide catalogue
      ]),
    ).toBeNull();

    const blocked = assertSameProperty(scope, [{ label: "Table 4", branchId: "prop-b" }]);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.reason).toBe("cross-property-participant");
    expect(blocked?.message).toContain("Table 4");

    expect(
      assertSameProperty(scope, [{ label: "Supplier X", organizationId: "org-2" }])?.reason,
    ).toBe("cross-property-participant");
  });
});

describe("property selection memory", () => {
  beforeEach(() => window.localStorage.clear());

  it("remembers a selection per user and never leaks it to the next person", () => {
    writePropertySelection("user-1", "prop-a");
    writePropertySelection("user-2", "prop-b");
    expect(readPropertySelection("user-1")).toBe("prop-a");
    expect(readPropertySelection("user-2")).toBe("prop-b");
    clearPropertySelection("user-1");
    expect(readPropertySelection("user-1")).toBeNull();
    expect(readPropertySelection("user-2")).toBe("prop-b");
  });

  it("remembers nothing for an anonymous session", () => {
    writePropertySelection(null, "prop-a");
    expect(readPropertySelection(null)).toBeNull();
  });

  it("migrates an in-progress shift from the old device-wide key once", () => {
    window.localStorage.setItem("hos.activeBranch", "prop-c");
    expect(readPropertySelection("user-1")).toBe("prop-c");
    expect(window.localStorage.getItem("hos.activeBranch")).toBeNull();
    expect(readPropertySelection("user-2")).toBeNull(); // not inherited
  });
});

describe("durable handoff contract", () => {
  it("covers each of the nine cross-module consequences exactly once", () => {
    expect(HANDOFFS).toHaveLength(9);
    expect(new Set(HANDOFFS.map((h) => h.key)).size).toBe(9);
    for (const h of HANDOFFS) {
      expect(h.eventTypes.length).toBeGreaterThan(0);
      expect(h.replayPermission.module.length).toBeGreaterThan(0);
      expect(h.promise.endsWith(".")).toBe(true);
    }
  });

  it("separates handoffs that share the generic finance.posted event type", () => {
    const of = (source: string) =>
      classifyHandoff({ event_type: "finance.posted", source_module: source });
    expect(of("pos_order")).toBe("revenue.finance");
    expect(of("event_deposit")).toBe("deposit.finance");
    expect(of("supplier_invoice")).toBe("grn.finance");
    expect(of("supplier_payment")).toBe("supplier_payment.journal");
    expect(classifyHandoff({ event_type: "stay.checked_out", source_module: "pms" })).toBe(
      "checkout.housekeeping",
    );
    // An unknown type is reported as unclassified rather than forced into a bucket.
    expect(classifyHandoff({ event_type: "something.else" })).toBeNull();
  });

  it("reads an event's position from the record, not from its status text alone", () => {
    expect(outboxPhase({ status: "pending" })).toBe("pending");
    expect(outboxPhase({ status: "pending", attempts: 2 })).toBe("retrying");
    expect(outboxPhase({ status: "pending", processed_at: "2026-08-31T00:00:00Z" })).toBe(
      "processed",
    );
    expect(outboxPhase({ status: "failed", dead_lettered_at: "2026-08-31T00:00:00Z" })).toBe("dead");
  });

  it("offers replay only for a stuck event, and only to a named authority", () => {
    const stuck = describeHandoff({
      event_type: "grn.accepted",
      source_module: "procurement",
      source_record_id: "grn-1",
      branch_id: "prop-a",
      status: "failed",
      attempts: 3,
      last_error: "ledger account missing",
      next_attempt_at: "2026-08-31T02:00:00Z",
      idempotency_key: "grn:1",
    });
    expect(stuck.phase).toBe("retrying");
    expect(stuck.replayable).toBe(true);
    expect(stuck.replayPermission).toEqual({ module: "finance", action: "edit" });
    expect(stuck.summary).toContain("GRN → Finance");
    expect(stuck.lastError).toBe("ledger account missing");

    const done = describeHandoff({
      event_type: "order.created",
      source_module: "pos",
      source_record_id: "o-1",
      branch_id: "prop-a",
      status: "processed",
      attempts: 1,
      processed_at: "2026-08-31T01:00:00Z",
      idempotency_key: "pos:o-1",
      payload: { ticket_id: "KDS-88" },
    });
    expect(done.replayable).toBe(false);
    expect(done.downstream).toBe("KDS-88");
    expect(done.summary).toContain("KDS-88");
  });

  it("names the facts that would stop a human recovering an event", () => {
    expect(
      missingRequiredFields({
        event_type: "order.created",
        source_record_id: "o-1",
        branch_id: "prop-a",
        status: "pending",
        attempts: 0,
        idempotency_key: "k",
      }),
    ).toEqual([]);

    // A failed event with no error, and a processed event with nothing to
    // show for itself, are both incomplete records.
    expect(missingRequiredFields({ event_type: "x", status: "failed", attempts: 2 })).toEqual([
      "source_record_id",
      "branch_id",
      "idempotency_key",
      "last_error",
      "next_attempt_at",
    ]);
    expect(
      missingRequiredFields({
        event_type: "finance.posted",
        source_module: "pos_order",
        source_record_id: "p-1",
        branch_id: "prop-a",
        status: "processed",
        attempts: 1,
        idempotency_key: "k",
        processed_at: "2026-08-31T00:00:00Z",
      }),
    ).toEqual(["downstream_reference"]);
  });

  it("summarises fleet health, including handoffs never observed at all", () => {
    const health = outboxHealth([
      { event_type: "order.created", source_module: "pos", status: "pending", attempts: 0, source_record_id: "a", branch_id: "b", idempotency_key: "k" },
      { event_type: "grn.accepted", source_module: "procurement", status: "failed", attempts: 4, dead_lettered_at: "2026-08-31T00:00:00Z", last_error: "x", source_record_id: "a", branch_id: "b", idempotency_key: "k" },
    ]);
    expect(health.total).toBe(2);
    expect(health.pending).toBe(1);
    expect(health.dead).toBe(1);
    expect(health.incomplete).toBe(0);
    expect(health.unobserved).toContain("night_audit.close_day");
    expect(health.unobserved).not.toContain("pos.kds");
  });
});
