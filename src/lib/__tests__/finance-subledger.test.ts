import { describe, expect, it } from "vitest";
import {
  assertSinglePosting,
  evaluateEligibility,
  journalBalanced,
  postingIdentity,
  postingVerdict,
  subledgerCounters,
  type PostingReceipt,
  type SourceEvent,
} from "@/lib/finance-subledger";

const source: SourceEvent = {
  family: "payment",
  sourceId: "aaaa",
  organizationId: "org",
  propertyId: "prop",
  reference: "RCT-1",
  amount: 3250,
  currency: "KES",
  businessDate: "2026-08-31",
  operationalState: "captured",
};

const journal = (debit: number, credit: number, persisted = true) => ({
  id: "j1",
  journalNumber: "JV-1",
  persisted,
  lines: [
    { accountCode: "1000", debit },
    { accountCode: "1100", credit },
  ],
});

describe("eligibility gate", () => {
  it("passes a complete, final, valued source", () => {
    const r = evaluateEligibility(source);
    expect(r.eligible).toBe(true);
    expect(r.identity).toBe("payment:aaaa");
  });

  it("refuses a source that has not reached a postable state", () => {
    const r = evaluateEligibility({ ...source, operationalState: "draft" });
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.failures.map((f) => f.code)).toContain("not_final");
  });

  it("refuses voided, zero, negative and unscoped sources", () => {
    const codes = (e: Partial<SourceEvent>) => {
      const r = evaluateEligibility({ ...source, ...e });
      return r.eligible ? [] : r.failures.map((f) => f.code);
    };
    expect(codes({ voided: true })).toContain("voided");
    expect(codes({ amount: 0 })).toContain("zero_amount");
    expect(codes({ amount: -5 })).toContain("negative_amount");
    expect(codes({ propertyId: null })).toContain("no_property");
    expect(codes({ businessDate: null })).toContain("no_business_date");
  });

  it("keeps one posting identity so a retry cannot post twice", () => {
    expect(postingIdentity(source)).toBe(postingIdentity({ family: "payment", sourceId: "aaaa" }));
  });
});

describe("posted means a persisted balanced journal", () => {
  const eligible = evaluateEligibility(source);

  it("is pending while no receipt exists", () => {
    expect(postingVerdict(source, eligible, null).status).toBe("pending");
  });

  it("is pending while the journal is not persisted", () => {
    const receipt: PostingReceipt = { identity: "payment:aaaa", receiptId: "r1", journal: journal(3250, 3250, false), attempts: 1 };
    expect(postingVerdict(source, eligible, receipt).status).toBe("pending");
  });

  it("is failed when the attempt errored", () => {
    const receipt: PostingReceipt = { identity: "payment:aaaa", receiptId: "r1", journal: null, attempts: 2, lastError: "period closed" };
    const v = postingVerdict(source, eligible, receipt);
    expect(v.status).toBe("failed");
    expect(v.detail).toContain("period closed");
  });

  it("refuses to call an unbalanced journal posted", () => {
    const receipt: PostingReceipt = { identity: "payment:aaaa", receiptId: "r1", journal: journal(3250, 3200), attempts: 1 };
    expect(postingVerdict(source, eligible, receipt).status).toBe("unbalanced");
  });

  it("refuses a balanced journal that does not equal the source", () => {
    const receipt: PostingReceipt = { identity: "payment:aaaa", receiptId: "r1", journal: journal(100, 100), attempts: 1 };
    expect(postingVerdict(source, eligible, receipt).status).toBe("unbalanced");
  });

  it("posts only when receipt, journal and amount all agree", () => {
    const receipt: PostingReceipt = { identity: "payment:aaaa", receiptId: "r1", journal: journal(3250, 3250), attempts: 1 };
    const v = postingVerdict(source, eligible, receipt);
    expect(v.status).toBe("posted");
    expect(v.journalId).toBe("j1");
  });

  it("blocks an ineligible source regardless of what a page believes", () => {
    const bad = evaluateEligibility({ ...source, operationalState: "draft" });
    const receipt: PostingReceipt = { identity: "payment:aaaa", receiptId: "r1", journal: journal(3250, 3250), attempts: 1 };
    expect(postingVerdict({ ...source, operationalState: "draft" }, bad, receipt).status).toBe("blocked");
  });

  it("rejects a second receipt or a second journal for one source", () => {
    const a: PostingReceipt = { identity: "payment:aaaa", receiptId: "r1", journal: journal(3250, 3250), attempts: 1 };
    expect(() => assertSinglePosting("payment:aaaa", [a])).not.toThrow();
    expect(() => assertSinglePosting("payment:aaaa", [a, { ...a, receiptId: "r2" }])).toThrow(/unique/i);
  });

  it("balances only when both sides are non-zero and equal", () => {
    expect(journalBalanced(journal(10, 10))).toBe(true);
    expect(journalBalanced({ lines: [] })).toBe(false);
  });
});

describe("counters come from verdicts", () => {
  it("is clean only when nothing is pending, blocked, failed or unbalanced", () => {
    const posted = postingVerdict(source, evaluateEligibility(source), {
      identity: "payment:aaaa",
      receiptId: "r1",
      journal: journal(3250, 3250),
      attempts: 1,
    });
    expect(subledgerCounters([posted])).toMatchObject({ posted: 1, postedValue: 3250, clean: true });
    const blocked = postingVerdict(
      { ...source, voided: true },
      evaluateEligibility({ ...source, voided: true }),
      null,
    );
    const counters = subledgerCounters([posted, blocked]);
    expect(counters.blocked).toBe(1);
    expect(counters.clean).toBe(false);
  });
});
