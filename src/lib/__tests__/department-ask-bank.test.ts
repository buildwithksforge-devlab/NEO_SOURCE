import { describe, expect, it } from "vitest";
import { answerDepartmentQuestion, type BankFacts } from "@/lib/department-ask";
import type { WorkItem } from "@/lib/my-work";

const financeItems: WorkItem[] = [
  { module: "finance", label: "Unposted journals", value: 2, detail: "Awaiting posting", route: "/finance/journals", tone: "warning" } as WorkItem,
];

const bank: BankFacts = {
  currency: "KES",
  rangeLabel: "2026-01-01 to 2026-09-16",
  accounts: [
    { name: "Main current account", balance: 1_250_000 },
    { name: "Petty cash", balance: null },
  ],
  total: 1_250_000,
  quiet: 1,
  unmapped: 0,
  route: "/finance/bank-accounts",
};

describe("Ask NEØ — bank positions", () => {
  it("refuses a bank question from someone with no finance access", () => {
    const housekeeping: WorkItem[] = [
      { module: "housekeeping", label: "Rooms to clean", value: 4, detail: "", route: "/housekeeping", tone: "warning" } as WorkItem,
    ];
    const a = answerDepartmentQuestion("what is our bank balance?", housekeeping, { propertyLabel: "Main" });
    expect(a.kind).toBe("refused");
    expect(a.statements).toHaveLength(0);
  });


  it("quotes posted balances when the ledger released them", () => {
    const a = answerDepartmentQuestion("what is our bank balance?", financeItems, { propertyLabel: "Main", bank });
    expect(a.kind).toBe("answered");
    expect(a.headline).toContain("1,250,000");
    expect(a.statements.map((s) => s.label)).toContain("Main current account");
    expect(a.limitation).toContain("no posting in this period");
  });

  it("never answers a bank question asked across properties", () => {
    const a = answerDepartmentQuestion("bank balance for all properties", financeItems, { propertyLabel: "Main", bank });
    expect(a.kind).toBe("refused");
  });

  it("says plainly when nothing in the question matched a figure", () => {
    const a = answerDepartmentQuestion("what do you think of the weather", financeItems, { propertyLabel: "Main" });
    expect(a.headline).toContain("could not match");
    expect(a.limitation).toContain("Try naming what you need");
  });
});
