/**
 * Inspection, notification integrity and search-scope contract.
 *
 * Three certification lenses are pinned here:
 *
 * 1. Auditability — a transaction family with an unknown creator or an
 *    incomplete downstream handoff must read as "attention", and the reason
 *    shown to the reader must name the worst gap first.
 * 2. Notification integrity — the two coordination failures are reported
 *    separately and ranked worst-first: an event nobody was told about, and
 *    notification spam (over-broad fanout or duplicate notices).
 * 3. Search scope — the global search index is built from effective
 *    permissions, so a result can never reveal a page the reader may not open.
 */
import { describe, expect, it } from "vitest";
import {
  auditGapReason,
  notificationVerdict,
  sortNotificationRows,
  type AuditCompletenessRow,
  type NotificationIntegrityRow,
} from "../inspection";
import { buildNavSearchIndex, searchNav } from "../nav-search";

function auditRow(over: Partial<AuditCompletenessRow> = {}): AuditCompletenessRow {
  return {
    module: "pos_orders",
    label: "Restaurant & bar orders",
    total: 10,
    with_actor: 10,
    with_trail: 10,
    with_approval: 0,
    approval_required: false,
    handoff_label: "Revenue posted",
    handoff_ok: 10,
    missing_actor: 0,
    missing_trail: 0,
    missing_handoff: 0,
    status: "ready",
    ...over,
  };
}

function notifyRow(over: Partial<NotificationIntegrityRow> = {}): NotificationIntegrityRow {
  return {
    event_type: "pos.ticket_routed",
    triggers: 5,
    covered: 5,
    missing: 0,
    notices: 5,
    recipients: 3,
    fanout_max: 2,
    duplicates: 0,
    stale_actions: 0,
    unprocessed: 0,
    rule_configured: true,
    status: "ok",
    ...over,
  };
}

describe("transaction auditability", () => {
  it("says nothing when every record can account for itself", () => {
    expect(auditGapReason(auditRow())).toBeNull();
  });

  it("reports an unknown creator before any other gap", () => {
    const reason = auditGapReason(
      auditRow({ missing_actor: 2, missing_handoff: 4, missing_trail: 7, status: "attention" }),
    );
    expect(reason).toContain("do not record who created them");
  });

  it("names the downstream step that never happened", () => {
    const reason = auditGapReason(auditRow({ missing_handoff: 3, status: "attention" }));
    expect(reason).toContain("revenue posted");
  });

  it("treats a family with no records as unanswerable rather than clean", () => {
    expect(auditGapReason(auditRow({ total: 0, status: "unknown" }))).toBeNull();
  });
});

describe("notification & escalation integrity", () => {
  it("ranks a missing critical alert above notification spam", () => {
    const ranked = sortNotificationRows([
      notifyRow({ event_type: "b.spam", status: "spam", fanout_max: 40 }),
      notifyRow({ event_type: "a.ok", status: "ok" }),
      notifyRow({ event_type: "c.missing", status: "missing-alerts", triggers: 9, covered: 4, missing: 5 }),
    ]);
    expect(ranked.map((r) => r.event_type)).toEqual(["c.missing", "b.spam", "a.ok"]);
  });

  it("states plainly that nobody was informed", () => {
    expect(
      notificationVerdict(notifyRow({ status: "missing-alerts", triggers: 4, covered: 3, missing: 1 })),
    ).toContain("nobody was informed");
  });

  it("distinguishes duplicate notices from an over-broad broadcast", () => {
    expect(notificationVerdict(notifyRow({ status: "spam", duplicates: 3 }))).toContain("duplicate");
    expect(notificationVerdict(notifyRow({ status: "spam", fanout_max: 40 }))).toContain("too broad");
  });

  it("flags an event with no routing rule instead of calling it healthy", () => {
    expect(notificationVerdict(notifyRow({ status: "unconfigured", rule_configured: false }))).toContain(
      "No routing rule",
    );
  });

  it("reports action-required notices left unattended", () => {
    expect(notificationVerdict(notifyRow({ status: "unattended", stale_actions: 2 }))).toContain(
      "unattended",
    );
  });
});

describe("global search respects role and data scope", () => {
  const posOnly = (module: string) => module === "restaurant";

  it("indexes only pages the effective permissions allow", () => {
    const index = buildNavSearchIndex([], false, posOnly, true);
    const paths = index.map((e) => e.to);
    expect(paths.some((p) => p.startsWith("/pos"))).toBe(true);
    expect(paths.some((p) => p.startsWith("/finance"))).toBe(false);
    expect(paths.some((p) => p.startsWith("/hr"))).toBe(false);
    expect(paths.some((p) => p.startsWith("/users") || p.startsWith("/roles"))).toBe(false);
    // Configuration pages appear only where the reader holds the capability the
    // entry declares — here, restaurant menu configuration and nothing else.
    for (const path of paths.filter((p) => p.startsWith("/admin"))) {
      expect(path).toBe("/admin/menu-imports");
    }
  });

  it("never returns a result for a module the reader cannot open", () => {
    const index = buildNavSearchIndex([], false, posOnly, true);
    for (const term of ["finance", "payroll", "journals", "suppliers", "roles", "audit"]) {
      for (const hit of searchNav(index, term)) {
        expect(posOnly(hit.module.toLowerCase()) || hit.to.startsWith("/pos")).toBe(true);
      }
    }
  });

  it("returns nothing at all before permissions have loaded", () => {
    const index = buildNavSearchIndex([], false, undefined, false);
    expect(searchNav(index, "finance")).toEqual([]);
  });
});
