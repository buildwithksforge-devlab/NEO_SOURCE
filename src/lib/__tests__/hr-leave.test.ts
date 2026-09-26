import { describe, expect, it } from "vitest";
import {
  availableDays,
  balancePreview,
  countLeaveDays,
  noticeDays,
  policyBreaches,
} from "@/lib/hr-leave";
import { buildDocumentChains } from "@/lib/hr-documents";
import { buildEmployeeTimeline } from "@/lib/hr-timeline";

describe("leave working days", () => {
  it("counts every calendar day when the policy counts weekends and holidays", () => {
    // Mon 2026-03-02 → Sun 2026-03-08
    expect(countLeaveDays("2026-03-02", "2026-03-08", {})).toBe(7);
  });

  it("skips weekends when the policy excludes them", () => {
    expect(
      countLeaveDays("2026-03-02", "2026-03-08", { counts_weekends: false }),
    ).toBe(5);
  });

  it("skips configured public holidays when the policy excludes them", () => {
    expect(
      countLeaveDays("2026-03-02", "2026-03-06", { counts_public_holidays: false }, [
        "2026-03-04",
      ]),
    ).toBe(4);
  });

  it("never counts a holiday twice when it falls on an excluded weekend", () => {
    expect(
      countLeaveDays(
        "2026-03-02",
        "2026-03-08",
        { counts_weekends: false, counts_public_holidays: false },
        ["2026-03-07"],
      ),
    ).toBe(5);
  });

  it("returns zero for a reversed or incomplete range", () => {
    expect(countLeaveDays("2026-03-08", "2026-03-02", {})).toBe(0);
    expect(countLeaveDays("", "2026-03-02", {})).toBe(0);
  });
});

describe("leave balance maths", () => {
  const balance = {
    entitlement_days: 21,
    carried_forward_days: 4,
    adjustment_days: 0,
    taken_days: 6,
    pending_days: 3,
  };

  it("treats pending days as already committed", () => {
    expect(availableDays(balance)).toBe(16);
  });

  it("never reports a negative balance", () => {
    expect(availableDays({ entitlement_days: 1, taken_days: 5 })).toBe(0);
  });

  it("previews the balance left after approval", () => {
    expect(balancePreview(balance, 5)).toEqual({
      available: 16,
      requested: 5,
      after: 11,
      exceeds: false,
    });
  });

  it("flags a request beyond the available balance", () => {
    expect(balancePreview(balance, 20).exceeds).toBe(true);
  });
});

describe("policy breaches", () => {
  const balance = { entitlement_days: 10, taken_days: 0, pending_days: 0 };

  it("blocks a paid request that exceeds the balance", () => {
    const breaches = policyBreaches({
      policy: { paid: true },
      balance,
      requestedDays: 12,
      startDate: "2099-01-01",
      hasDocument: true,
    });
    expect(breaches.find((b) => b.code === "over_balance")?.blocking).toBe(true);
  });

  it("only warns when unpaid leave exceeds the balance", () => {
    const breaches = policyBreaches({
      policy: { paid: false },
      balance,
      requestedDays: 12,
      startDate: "2099-01-01",
      hasDocument: true,
    });
    expect(breaches.find((b) => b.code === "over_balance")?.blocking).toBe(false);
  });

  it("blocks a missing supporting document", () => {
    const breaches = policyBreaches({
      policy: { requires_document: true },
      balance,
      requestedDays: 1,
      startDate: "2099-01-01",
      hasDocument: false,
    });
    expect(breaches.some((b) => b.code === "document_required" && b.blocking)).toBe(true);
  });

  it("warns, but does not block, on short notice", () => {
    const soon = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const breaches = policyBreaches({
      policy: { minimum_notice_days: 14 },
      balance,
      requestedDays: 1,
      startDate: soon,
      hasDocument: true,
    });
    const notice = breaches.find((b) => b.code === "short_notice");
    expect(notice?.blocking).toBe(false);
  });

  it("counts notice in whole days from today", () => {
    expect(noticeDays("2026-03-10", new Date("2026-03-01T18:00:00Z"))).toBe(9);
  });
});

describe("document version chains", () => {
  it("keeps superseded versions under the current document", () => {
    const chains = buildDocumentChains([
      { id: "v3", title: "CV", supersedes_document_id: "v2" },
      { id: "v2", title: "CV", supersedes_document_id: "v1" },
      { id: "v1", title: "CV", supersedes_document_id: null },
      { id: "id1", title: "National ID", supersedes_document_id: null },
    ]);
    expect(chains.map((c) => c.current["id"])).toEqual(["v3", "id1"]);
    expect(chains[0]!.previous.map((p) => p["id"])).toEqual(["v2", "v1"]);
  });
});

describe("employee timeline", () => {
  it("orders the working life newest first and labels each event", () => {
    const events = buildEmployeeTimeline({
      employee: {
        id: "e1",
        employment_date: "2024-01-15",
        probation_end_date: "2024-04-15",
        job_title: "Waiter",
      },
      history: [
        { id: "h1", change_type: "promotion", effective_date: "2025-02-01", reason: "Promoted" },
      ],
      leave: [
        {
          id: "l1",
          status: "approved",
          days: 5,
          start_date: "2025-08-03",
          end_date: "2025-08-07",
          created_at: "2025-07-20",
          approved_at: "2025-07-22",
          leave_types: { name: "Annual Leave" },
        },
      ],
    });

    expect(events[0]!.date.slice(0, 10)).toBe("2025-07-22");
    expect(events.at(-1)!.date.slice(0, 10)).toBe("2024-01-15");
    expect(events.some((e) => e.title === "Annual Leave approved")).toBe(true);
    expect(events.some((e) => e.title === "Promotion")).toBe(true);
  });

  it("ignores records with no usable date", () => {
    const events = buildEmployeeTimeline({
      employee: { id: "e1", employment_date: null },
      documents: [{ id: "d1", created_at: null, title: "CV", category: "cv" }],
    });
    expect(events).toHaveLength(0);
  });
});
