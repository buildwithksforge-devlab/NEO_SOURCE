import { describe, expect, it } from "vitest";
import {
  amountStep,
  authorityLadder,
  findCoverageIssues,
  resolveApprovalRule,
  type CoverageRule,
} from "@/lib/approval-coverage";

const TYPES = [{ key: "purchase-request", name: "Purchase requisition" }];

function rule(p: Partial<CoverageRule>): CoverageRule {
  return {
    id: Math.random().toString(36).slice(2),
    approval_type: "purchase-request",
    level: 1,
    branch_id: null,
    approver_role_id: "role",
    min_amount: null,
    max_amount: null,
    currency: null,
    effective_from: null,
    effective_to: null,
    active: true,
    ...p,
  };
}

/**
 * The certification figures below are test data only: the same assertions are
 * re-run against a completely different ladder to prove nothing is encoded.
 */
const PROPERTY = "property-a";
const OTHER = "property-b";

const ladderRules = [
  rule({ level: 1, branch_id: PROPERTY, min_amount: 0, max_amount: 100000, approver_role_id: "r1", currency: "KES" }),
  rule({ level: 2, branch_id: PROPERTY, min_amount: 100001, max_amount: 500000, approver_role_id: "r2", currency: "KES" }),
  rule({ level: 3, branch_id: null, min_amount: 500001, max_amount: null, approver_role_id: "r3", currency: "KES" }),
];

describe("approval coverage — whole-unit bands are continuous", () => {
  it("reports no gap for a continuous whole-unit ladder", () => {
    expect(
      findCoverageIssues(ladderRules, {
        types: TYPES,
        branches: [{ id: PROPERTY, name: "Property A" }],
      }),
    ).toEqual([]);
  });

  it("does not let a group-wide ceiling rule hide property authority", () => {
    const issues = findCoverageIssues(ladderRules, {
      types: TYPES,
      branches: [{ id: PROPERTY, name: "Property A" }],
    });
    expect(issues.some((i) => /500,001|100,001/.test(i.message))).toBe(false);
  });

  it("uses whole units when the policy is written in whole units", () => {
    expect(amountStep("KES", ladderRules)).toBe(1);
    expect(amountStep("USD", [rule({ min_amount: 0, max_amount: 10.5 })])).toBeCloseTo(0.01);
  });
});

describe("approval coverage — routing follows the saved policy", () => {
  const at = (amount: number) =>
    resolveApprovalRule(ladderRules, {
      type: "purchase-request",
      amount,
      branchId: PROPERTY,
      currency: "KES",
    })?.approver_role_id;

  it("routes each configured band to its configured approver", () => {
    expect(at(50000)).toBe("r1");
    expect(at(100000)).toBe("r1");
    expect(at(100001)).toBe("r2");
    expect(at(500000)).toBe("r2");
    expect(at(500001)).toBe("r3");
    expect(at(100000000)).toBe("r3");
  });

  it("follows completely different thresholds without code changes", () => {
    const big = [
      rule({ level: 1, branch_id: PROPERTY, min_amount: 0, max_amount: 5000000, approver_role_id: "a" }),
      rule({ level: 2, branch_id: PROPERTY, min_amount: 5000001, max_amount: null, approver_role_id: "b" }),
    ];
    const pick = (amount: number) =>
      resolveApprovalRule(big, { type: "purchase-request", amount, branchId: PROPERTY })
        ?.approver_role_id;
    expect(pick(4999999)).toBe("a");
    expect(pick(5000001)).toBe("b");
    expect(pick(900000000)).toBe("b");
    expect(findCoverageIssues(big, { types: TYPES, branches: [{ id: PROPERTY, name: "A" }] })).toEqual([]);
  });

  it("prefers a property rule over the organisation-wide rule at the same amount", () => {
    const rules = [
      rule({ level: 1, branch_id: null, approver_role_id: "org", min_amount: 0, max_amount: null }),
      rule({ level: 1, branch_id: PROPERTY, approver_role_id: "own", min_amount: 0, max_amount: null }),
    ];
    expect(
      resolveApprovalRule(rules, { type: "purchase-request", amount: 10, branchId: PROPERTY })
        ?.approver_role_id,
    ).toBe("own");
  });

  it("never applies another property's rule", () => {
    const rules = [rule({ branch_id: OTHER, approver_role_id: "other", min_amount: 0, max_amount: null })];
    expect(
      resolveApprovalRule(rules, { type: "purchase-request", amount: 10, branchId: PROPERTY }),
    ).toBeNull();
  });

  it("ignores a rule that is not yet or no longer in force", () => {
    const future = rule({ effective_from: "2999-01-01", min_amount: 0, max_amount: null });
    const past = rule({ effective_to: "2000-01-01", min_amount: 0, max_amount: null });
    expect(resolveApprovalRule([future, past], { type: "purchase-request", amount: 5 })).toBeNull();
  });
});

describe("approval coverage — real problems are still reported", () => {
  it("reports a genuine uncovered range with type, scope and currency", () => {
    const issues = findCoverageIssues(
      [
        rule({ level: 1, branch_id: PROPERTY, min_amount: 0, max_amount: 100000, currency: "KES" }),
        rule({ level: 2, branch_id: PROPERTY, min_amount: 200000, max_amount: null, currency: "KES" }),
      ],
      { types: TYPES, branches: [{ id: PROPERTY, name: "Property A" }] },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("gap");
    expect(issues[0]!.message).toContain("Purchase requisition");
    expect(issues[0]!.message).toContain("Property A");
    expect(issues[0]!.message).toContain("KES");
    expect(issues[0]!.message).toContain("100,001");
    expect(issues[0]!.message).toContain("199,999");
  });

  it("flags two rules at the same level claiming the same amounts", () => {
    const issues = findCoverageIssues(
      [
        rule({ level: 1, branch_id: PROPERTY, min_amount: 0, max_amount: 100000 }),
        rule({ level: 1, branch_id: PROPERTY, min_amount: 50000, max_amount: 200000 }),
      ],
      { types: TYPES, branches: [{ id: PROPERTY, name: "Property A" }] },
    );
    expect(issues.some((i) => i.kind === "overlap")).toBe(true);
  });

  it("keeps one property's gap from being masked by another property", () => {
    const issues = findCoverageIssues(
      [
        rule({ branch_id: PROPERTY, min_amount: 0, max_amount: null }),
        rule({ branch_id: OTHER, min_amount: 10000, max_amount: null }),
      ],
      {
        types: TYPES,
        branches: [
          { id: PROPERTY, name: "Property A" },
          { id: OTHER, name: "Property B" },
        ],
      },
    );
    expect(issues.filter((i) => i.kind === "gap")).toHaveLength(1);
    expect(issues[0]!.message).toContain("Property B");
  });

  it("builds a readable ladder from configuration alone", () => {
    const bands = authorityLadder(ladderRules, {
      type: "purchase-request",
      branchId: PROPERTY,
      currency: "KES",
    });
    expect(bands.map((b) => b.rule.approver_role_id)).toEqual(["r1", "r2", "r3"]);
    expect(bands.at(-1)!.to).toBeNull();
    expect(bands.at(-1)!.orgWide).toBe(true);
  });
});
