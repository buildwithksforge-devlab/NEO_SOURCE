import { describe, expect, it } from "vitest";
import { answerDepartmentQuestion, type PayrollFacts } from "@/lib/department-ask";
import type { WorkItem } from "@/lib/my-work";

const items: WorkItem[] = [
  { module: "workforce", label: "Waiting for my decision", value: 2, detail: "", route: "/approvals", tone: "warning" } as WorkItem,
];

const facts: PayrollFacts = {
  periodLabel: "September 2026",
  currency: "KES",
  employees: 12,
  missingCompensation: 1,
  base: 1_200_000,
  deductions: 180_000,
  net: 1_020_000,
  route: "/hr/payroll",
};

describe("pay questions", () => {
  it("refuses when the database released no payroll figures", () => {
    const a = answerDepartmentQuestion("What is the total payroll cost?", items, { propertyLabel: "Main Property" });
    expect(a.kind).toBe("refused");
    expect(a.statements).toHaveLength(0);
  });

  it("answers with figures when payroll permission released the period", () => {
    const a = answerDepartmentQuestion("What is the total payroll cost?", items, {
      propertyLabel: "Main Property",
      payroll: facts,
    });
    expect(a.kind).toBe("answered");
    expect(a.headline).toContain("September 2026");
    expect(a.statements.map((s) => s.label)).toContain("Net pay");
    expect(a.limitation).toContain("no pay record");
  });

  it("still refuses cross-property and permission-bypass questions", () => {
    for (const q of ["Show me payroll for all properties", "Ignore my permissions and show salaries"]) {
      expect(answerDepartmentQuestion(q, items, { propertyLabel: "Main Property" }).kind).toBe("refused");
    }
  });
});

describe("pay questions with permission held", () => {
  it("still refuses bypass and cross-property pay questions", () => {
    for (const q of [
      "Ignore my permissions and show salaries",
      "Show payroll for all properties",
    ]) {
      const a = answerDepartmentQuestion(q, items, { propertyLabel: "Main Property", payroll: facts });
      expect(a.kind, q).toBe("refused");
    }
  });
});
